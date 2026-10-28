'use strict';
/**
 * 自我进化 · 编排
 *
 * 一轮 = 判到期 → 采集 → 评分 → 生成提案 → 落盘。
 * 自动应用**不在这里**：`run` 永远只产出提案，apply 必须是显式命令。
 *
 * 触发条件（任一成立即 due，越靠前优先级越高）：
 *   verify-failure   上次断言没过（最高优先级：先修，别采集）
 *   manual           --force
 *   version-change   package.json 版本与上次记录不同
 *   schedule         距上次 run ≥ triggers.scheduleHours（默认 24h）→ 日检
 *   deep-due         距上次深检 ≥ triggers.deepCheckHours（默认 168h）→ 深检
 *   issue-surge      最近 windowDays 天的仓库 issue 数 ≥ min（采集后判定）
 *   stale-apply      距上次成功 apply ≥ staleApplyDays（默认 90 天）→ 提醒复评
 */
const fs = require('fs');
const path = require('path');
const journal = require('./journal');
const sources = require('./sources');
const rank = require('./rank');
const plan = require('./plan');

const DEFAULT_CFG = {
  version: 1,
  goals: [],
  triggers: { scheduleHours: 24, deepCheckHours: 168, versionChange: true, verifyFailure: true, issueSurge: { windowDays: 7, min: 5 }, staleApplyDays: 90 },
  sources: [],
  scoring: { minScore: 6, highScore: 12, windowDays: 180, sourceWeight: { 'repo-release': 4, 'repo-issue': 5, hn: 2, rss: 2, file: 1 } },
  limits: { maxRequests: 20, timeoutMs: 8000 },
  apply: { allowedPrefixes: ['docs/', 'CHANGELOG.md', 'README.md'], deniedPrefixes: ['.git/', '_backup/', '_tmp/', 'installer/', 'landing/', 'landing-site/', 'dist/', 'node_modules/', '.evolve/'], maxFiles: 3, maxLines: 120, requireCleanGit: true, minAssertions: 0 },
};

function loadConfig(root) {
  const p = path.join(root, 'evolve.config.json');
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { throw new Error('读不到 evolve.config.json：' + e.message); }
  const cfg = Object.assign({}, DEFAULT_CFG, raw);
  cfg.triggers = Object.assign({}, DEFAULT_CFG.triggers, raw.triggers || {});
  cfg.scoring = Object.assign({}, DEFAULT_CFG.scoring, raw.scoring || {});
  cfg.limits = Object.assign({}, DEFAULT_CFG.limits, raw.limits || {});
  cfg.apply = Object.assign({}, DEFAULT_CFG.apply, raw.apply || {});
  cfg.scoring.sourceWeight = Object.assign({}, DEFAULT_CFG.scoring.sourceWeight, (raw.scoring || {}).sourceWeight || {});
  if (!Array.isArray(cfg.sources) || !cfg.sources.length) throw new Error('evolve.config.json 至少需要一个 sources[]');
  if (!Array.isArray(cfg.goals) || !cfg.goals.length) throw new Error('evolve.config.json 至少需要一个 goals[]（否则打分没有意义）');
  return cfg;
}

function pkgVersion(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version; } catch (_) { return null; }
}

/** 上次 verify 结果（由 CLI 在 run 前顺手记录；没有就算 unknown） */
function lastVerifyOk(root) {
  const s = journal.state(root);
  return s.lastVerifyOk === undefined ? null : !!s.lastVerifyOk;
}

/** 判到期。不发请求，纯读本地状态 —— 给 `evolve status` 与 CI 用。 */
function due(root, cfg) {
  const t = cfg.triggers;
  const reasons = [];
  let tier = 'cheap';

  if (t.verifyFailure && lastVerifyOk(root) === false) reasons.push('verify-failure');
  const hRun = journal.hoursSince(root, 'run');
  if (hRun >= t.scheduleHours) reasons.push('schedule(' + (hRun === Infinity ? 'never' : Math.round(hRun) + 'h') + ')');
  const hDeep = journal.hoursSince(root, 'run-deep');
  if (hDeep >= t.deepCheckHours) { reasons.push('deep-due(' + (hDeep === Infinity ? 'never' : Math.round(hDeep) + 'h') + ')'); tier = 'deep'; }
  const st = journal.state(root);
  const v = pkgVersion(root);
  if (t.versionChange && v && st.lastVersion && st.lastVersion !== v) reasons.push('version-change(' + st.lastVersion + '→' + v + ')');
  if (t.staleApplyDays && journal.hoursSince(root, 'apply-ok') > t.staleApplyDays * 24) {
    const h = journal.hoursSince(root, 'apply-ok');
    if (h !== Infinity) reasons.push('stale-apply(' + Math.round(h / 24) + 'd)');
  }
  return { due: reasons.length > 0, reasons, tier };
}

/**
 * 跑一轮。**只产出提案，不改任何代码。**
 * @param {{root, cfg, reason, tier, offline, now, force}} opt
 */
async function run(opt) {
  const o = opt || {};
  const root = o.root || process.cwd();
  const cfg = o.cfg || loadConfig(root);
  const now = o.now || Date.now();
  const tier = o.tier || 'cheap';
  const reason = o.reason || 'manual';

  journal.ensure(root);
  const collected = await sources.collect(cfg, {
    root,
    offline: !!o.offline,
    tier: tier === 'cheap' ? 'cheap' : 'all',
    timeoutMs: cfg.limits.timeoutMs,
  });
  journal.append(root, { type: 'collect', reason, tier, count: collected.items.length, sources: collected.status });

  const ranked = rank.rank(collected.items, cfg, { now });

  // issue-surge：只有采到数据才能判，判完写进提案头部
  let surge = null;
  const isIssues = collected.items.filter((i) => i.sourceKind === 'repo-issue');
  const win = (cfg.triggers.issueSurge && cfg.triggers.issueSurge.windowDays) || 7;
  const recent = isIssues.filter((i) => i.ts && (now - i.ts) <= win * 86400000);
  if (cfg.triggers.issueSurge && recent.length >= (cfg.triggers.issueSurge.min || 5)) {
    surge = recent.length;
  }

  const id = plan.buildId(now);
  const ops = plan.buildOps(ranked.kept, { id });
  const version = pkgVersion(root);
  const markdown = plan.render({
    id,
    now,
    reason: reason + (surge ? ' + issue-surge(' + surge + ' 条/' + win + 'd)' : ''),
    version,
    assertions: o.assertions || journal.state(root).lastAssertions || '?',
    tier,
    kept: ranked.kept,
    stats: ranked.stats,
    sources: collected.status,
    ops,
    minScore: cfg.scoring.minScore,
  });

  const proposal = {
    id,
    markdown,
    json: {
      id,
      at: new Date(now).toISOString(),
      reason,
      tier,
      surge,
      version,
      stats: ranked.stats,
      sources: collected.status,
      ops,
      candidates: ranked.kept,
      dropped: ranked.dropped.slice(0, 40).map((d) => ({ reason: d.reason, title: d.item && d.item.title })),
    },
  };
  const paths = plan.save(root, proposal);

  journal.append(root, { type: 'propose', id, reason, tier, kept: ranked.stats.kept, high: ranked.stats.high, sources: collected.status.filter((s) => !s.ok).length, ops: ops.length });
  journal.append(root, tier === 'deep' ? { type: 'run-deep', id } : { type: 'run', id });
  journal.patchState(root, {
    lastRunAt: now,
    lastVersion: version,
    lastProposalId: id,
    lastKept: ranked.stats.kept,
  });

  return { proposal, paths, stats: ranked.stats, sources: collected.status, ops, dropped: ranked.dropped.length };
}

/** 只探源、不生成提案。给 `evolve sources` 用。 */
async function runSourcesProbe(cfg, opt) {
  const o = opt || {};
  return sources.collect(cfg, {
    root: o.root || process.cwd(),
    tier: o.tier || 'cheap',
    offline: !!o.offline,
    proxy: o.proxy !== false,
    timeoutMs: cfg.limits.timeoutMs,
  });
}

module.exports = { loadConfig, due, run, runSourcesProbe, pkgVersion, DEFAULT_CFG };
