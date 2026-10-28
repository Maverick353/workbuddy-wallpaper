#!/usr/bin/env node
'use strict';
/**
 * 自我进化 CLI
 *
 *   node scripts/evolve.js status              看是否到期/上次跑过什么/有多少备份
 *   node scripts/evolve.js run [--deep]        跑一轮：采集 → 评分 → 出提案（**不改代码**）
 *        [--offline] [--force] [--tier cheap|deep] [--json]
 *   node scripts/evolve.js list                列出历史提案
 *   node scripts/evolve.js show <id>           打印提案全文
 *   node scripts/evolve.js apply <id>          应用（默认只允许文档；失败自动回滚）
 *        [--dry-run] [--allow-code] [--auto] [--skip-verify] [--skip-clean-check]
 *   node scripts/evolve.js rollback <id>       还原到应用前的备份
 *   node scripts/evolve.js sources             各源健康度（打一次真实请求）
 *
 * 退出码：0 成功 / 1 失败或被拒 / 2 未到期（无操作）
 */
const path = require('path');
const fs = require('fs');
const evolve = require('../core/evolve');
const journal = require('../core/evolve/journal');
const planMod = require('../core/evolve/plan');
const applyMod = require('../core/evolve/apply');
const validate = require('../core/evolve/validate');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const cmd = (argv[0] || 'status').replace(/^--?/, '');
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const pos = (n) => argv.filter((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--tier')[n];

const c = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
const say = (s) => process.stdout.write(s + '\n');

function table(rows) {
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i] == null ? '' : r[i]).length)));
  rows.forEach((r, ri) => say('  ' + r.map((cell, i) => String(cell == null ? '' : cell).padEnd(w[i])).join('  ') + (ri === 0 ? '' : '')));
}

function loadCfg() { return evolve.loadConfig(ROOT); }

function cmdStatus() {
  const cfg = loadCfg();
  const st = journal.state(ROOT);
  const d = evolve.due(ROOT, cfg);
  const props = planMod.listProposals(ROOT);
  const backups = (() => { try { return fs.readdirSync(path.join(journal.dir(ROOT), 'backup')).filter((f) => !f.startsWith('.')); } catch (_) { return []; } })();
  const lastRun = [journal.last(ROOT, 'run'), journal.last(ROOT, 'run-deep')]
    .filter(Boolean).sort((a, b) => new Date(b.at) - new Date(a.at))[0] || null;
  const lastApply = journal.last(ROOT, 'apply-ok');

  say(c.b + '自我进化 · 状态' + c.x);
  say('  仓库      ' + ROOT);
  say('  目标数    ' + cfg.goals.length + '　数据源 ' + cfg.sources.length + '（' + cfg.sources.filter((s) => s.tier === 'deep').length + ' 个深检源）');
  say('  阈值      相关度 ≥ ' + cfg.scoring.minScore + ' 进提案，≥ ' + cfg.scoring.highScore + ' 标高优先');
  say('  预算      单次 ≤' + cfg.apply.maxFiles + ' 文件 / ≤' + cfg.apply.maxLines + ' 行；只写 ' + cfg.apply.allowedPrefixes.join(' · '));
  say('');
  say(c.b + '到期判断' + c.x + '  ' + (d.due ? c.y + '需要跑' + c.x + '（' + d.reasons.join('，') + '）→ 建议 tier=' + d.tier : c.g + '未到期' + c.x));
  say('  上次运行  ' + (lastRun ? lastRun.at + '（' + (lastRun.type === 'run-deep' ? '深检' : '日检') + ' · ' + lastRun.id + '）' : '从未'));
  say('  上次应用  ' + (lastApply ? lastApply.at + '（' + lastApply.id + '）' : '从未'));
  say('  断言基线  ' + (st.lastAssertions != null ? st.lastAssertions + ' 条（' + (st.lastVerifyOk ? '绿' : c.r + '红' + c.x) + '）' : '未记录'));
  say('  提案      ' + props.length + ' 份' + (props.length ? '，最新 ' + props[0].id : '') + '　备份 ' + backups.length + ' 份');
  return d.due ? 0 : 2;
}

async function cmdRun() {
  const cfg = loadCfg();
  const tier = val('--tier', has('--deep') ? 'deep' : 'cheap');
  const offline = has('--offline');
  const force = has('--force') || has('--now');

  const d = evolve.due(ROOT, cfg);
  if (!d.due && !force) {
    say(c.g + '未到期' + c.x + '：' + (d.reasons.length ? d.reasons.join('，') : '各触发条件均未满足') + '　（要强制跑就加 --force）');
    return 2;
  }

  // 采前先量断言基线：既给 verify-failure 触发用，也给 apply 的"不许少于基线"兜底
  const v = validate.runVerify(ROOT, { minPass: 0 });
  journal.patchState(ROOT, { lastVerifyOk: !!v.ok, lastAssertions: v.pass || 0 });
  say(c.d + '断言基线 ' + (v.pass || '?') + ' 条 · ' + (v.ok ? '绿' : c.r + '红' + c.x) + c.x);

  const t0 = Date.now();
  const out = await evolve.run({
    root: ROOT, cfg, tier, offline,
    reason: force && !d.due ? 'manual(--force)' : (d.reasons[0] || 'manual'),
    assertions: v.pass || 0,
  });
  const ms = Date.now() - t0;

  const stat = out.stats;
  say('');
  say(c.b + '提案 ' + out.proposal.id + c.x + '　' + (ms / 1000).toFixed(1) + 's');
  say('  采集 ' + stat.input + ' 条 → 过阈值 ' + stat.kept + '（高优先 ' + stat.high + '）· 丢弃 ' + stat.dropped);
  const okSrc = out.sources.filter((s) => s.ok).length;
  say('  数据源 ' + okSrc + '/' + out.sources.length + ' 成功' + (out.sources.length > okSrc ? c.y + '（' + (out.sources.length - okSrc) + ' 个用缓存或不可达）' + c.x : ''));
  say('  可执行操作 ' + out.ops.length + ' 个' + (out.ops.length ? '（只写文档）' : ''));
  say('  落盘 ' + path.relative(ROOT, out.paths.md));

  if (has('--json')) say(JSON.stringify({ id: out.proposal.id, stats: stat, sources: out.sources, ops: out.ops }, null, 2));
  if (out.stats.kept) {
    say('');
    say(c.b + '前 5 条候选' + c.x);
    const rows = [['相关度', '类型', '来源', '标题']];
    out.proposal.json.candidates.slice(0, 5).forEach((k) => rows.push([k.relevance, k.kind, k.sourceKind, String(k.title).slice(0, 48)]));
    table(rows);
    say('');
    say('下一步：node scripts/evolve.js apply ' + out.proposal.id + ' --dry-run');
  }
  return 0;
}

function cmdList() {
  const props = planMod.listProposals(ROOT);
  if (!props.length) { say('还没有提案。跑 `node scripts/evolve.js run --force`'); return 0; }
  const rows = [['提案', '生成时间', '候选', '高优先']];
  for (const p of props) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/evolve/proposals', p.id + '.json'), 'utf8'));
      rows.push([p.id, new Date(d.at).toISOString().replace('T', ' ').slice(0, 16), (d.stats && d.stats.kept) || 0, (d.stats && d.stats.high) || 0]);
    } catch (_) { rows.push([p.id, '?', '?', '?']); }
  }
  table(rows);
  return 0;
}

function cmdShow() {
  const id = pos(1);
  if (!id) { say('用法：node scripts/evolve.js show <提案 id>'); return 1; }
  const p = planMod.load(ROOT, id);
  if (!p) { say(c.r + '找不到提案 ' + id + c.x); return 1; }
  say(p.markdown);
  return 0;
}

function cmdApply() {
  const id = pos(1);
  if (!id) { say('用法：node scripts/evolve.js apply <提案 id> [--dry-run]'); return 1; }
  const p = planMod.load(ROOT, id);
  if (!p) { say(c.r + '找不到提案 ' + id + c.x); return 1; }
  const cfg = loadCfg();
  const st = journal.state(ROOT);
  const dry = has('--dry-run');
  const allowCode = has('--allow-code');
  const auto = has('--auto');

  const res = applyMod.apply(ROOT, p.json, cfg, {
    dryRun: dry,
    allowCode,
    verify: !has('--skip-verify'),
    skipCleanCheck: has('--skip-clean-check'),
    minPass: st.lastAssertions || 0,
  });

  if (!res.ok && res.phase === 'precheck') {
    say(c.r + '被拒绝' + c.x + '（什么都没改）：');
    for (const r of res.reasons) say('  · ' + r);
    return 1;
  }
  if (res.phase === 'dryrun') {
    say(c.b + '试运行' + c.x + '（未写盘）：' + res.files.length + ' 个文件 / ' + res.lines + ' 行');
    for (const f of res.files) say('  · ' + f);
    for (const op of res.ops) {
      say(c.d + '  ┌ ' + op.op + ' → ' + op.file + c.x);
      String(op.body || op.replace || '').split('\n').slice(0, 12).forEach((l) => say('  │ ' + l));
      say(c.d + '  └ …' + c.x);
    }
    say('');
    say('确认无误后去掉 --dry-run 真应用（会自动跑断言，失败自动回滚）');
    return 0;
  }
  if (!res.ok) {
    say(c.r + '失败' + c.x + '：阶段 ' + res.phase + (res.error ? ' · ' + res.error : ''));
    if (res.checks) res.checks.forEach((k) => say('  ' + (k.ok ? '✓' : '✗') + ' ' + k.name + '  ' + k.detail));
    if (res.rolledBack) say(c.y + '已自动回滚' + c.x + '（备份在 .evolve/backup/' + id + '）');
    return 1;
  }
  say(c.g + '已应用' + c.x + ' ' + id);
  for (const f of res.files || []) say('  · ' + f.op + ' ' + f.file + '（' + f.lines + ' 行）');
  (res.checks || []).forEach((k) => say('  ' + (k.ok ? '✓' : '✗') + ' ' + k.name + '  ' + k.detail));
  say('');
  say('回滚：node scripts/evolve.js rollback ' + id);
  return 0;
}

function cmdRollback() {
  const id = pos(1);
  if (!id) { say('用法：node scripts/evolve.js rollback <提案 id>'); return 1; }
  const r = applyMod.rollback(ROOT, id);
  if (!r.ok) { say(c.r + r.error + c.x); return 1; }
  say(c.g + '已回滚' + c.x + ' ' + id);
  for (const f of r.restored) say('  · ' + f.action + '  ' + f.file);
  return 0;
}

async function cmdSources() {
  const cfg = loadCfg();
  const t0 = Date.now();
  const r = await evolve.runSourcesProbe(cfg, { root: ROOT, tier: has('--deep') ? 'all' : 'cheap' });
  const rows = [['源', '类型', '结果', '条目', '耗时']];
  for (const s of r.status) rows.push([s.id, (cfg.sources.find((x) => x.id === s.id) || {}).type || '?', s.ok ? 'ok' : (s.cached ? 'cache' : 'fail'), s.count, s.ms + 'ms']);
  table(rows);
  say('');
  say('总计 ' + r.items.length + ' 条 · ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  return r.status.every((s) => s.ok) ? 0 : 2;
}

(async () => {
  try {
    let code = 0;
    if (cmd === 'status') code = cmdStatus();
    else if (cmd === 'run') code = await cmdRun();
    else if (cmd === 'list') code = cmdList();
    else if (cmd === 'show') code = cmdShow();
    else if (cmd === 'apply') code = cmdApply();
    else if (cmd === 'rollback') code = cmdRollback();
    else if (cmd === 'sources') code = await cmdSources();
    else { say('未知命令 ' + cmd + '（可用：status run list show apply rollback sources）'); code = 1; }
    process.exit(code);
  } catch (e) {
    say(c.r + '出错：' + e.message + c.x);
    process.exit(1);
  }
})();
