'use strict';
/**
 * 自我进化 · 方案生成
 *
 * 输入：rank() 的 kept 候选 + 项目现状（版本/断言数/已知缺口）
 * 输出：{ id, markdown, json } —— markdown 给人看，json 里的 ops 给 apply 用。
 *
 * 一条铁律：**能自动改的只有"记录类"变更**（append-doc 到 backlog）。
 * 代码/配置的改动永远只生成「建议条目 + 复现/验收要求」，由人拍板后再落手。
 * 理由：搜索结果与项目实际之间必然有语义 gap，让规则去 patch 代码必然产生似是而非的改动。
 */
const fs = require('fs');
const path = require('path');

const ACTION = {
  security: '核对是否在影响范围 → 若受影响，按公告给出的最低修复版本评估升级路径；升级前先跑 `verify-apply-real.js` 与真机自更新',
  perf: '先在 1080p + 场景壁纸下采样 GPU 进程 CPU（10s 均值）作为基线 → 应用后再采样一次；对照 `sceneFps` 档位看是否只是帧率问题',
  compat: '宿主/运行时升级后必做三件事：① 7 组视口跑 `_tmp/audit-pages.js` ② `probe-injection.js` 确认注入在位 ③ `verify-apply-real.js`；重点核对 `color-mix()`、`:focus-visible`、`aspect-ratio` 与 `document.hidden` 时序是否仍成立',
  bug: '写出最小复现步骤 → 能复现就先补一条 `verify.js` 断言（红），再修到绿；不能复现则记入 backlog 并标注环境',
  ux: '按「问题表现 / 用户影响 / 改法」三段写清，再判定是否进下一版；涉及布局的必须跑 `_tmp/audit-pages.js` 的 7 组视口',
  doc: '定位到具体文档章节补充，改完跑 `verify.js`（接口清单由 `gen-api-docs.js` 生成，别手改）',
  release: '对照 CHANGELOG 与 docs/ 确认本次发版带来的行为变化已写清；无影响就直接忽略（自家发版默认不进候选，只有含安全字样才留）',
  feature: '先评估「使用频次 × 实现成本」，低于阈值的只进 backlog 不做；确认要做时按工作包拆',
  other: '人工判断相关性；不确定就只进 backlog，不排期',
};

function pad(n) { return String(n).padStart(2, '0'); }

function buildId(now) {
  const d = new Date(now || Date.now());
  return 'EV-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes());
}

/** 由候选生成 ops：只有「记录进 backlog」是自动可应用的。 */
function buildOps(kept, opt) {
  const o = opt || {};
  if (!kept.length) return [];
  const lines = [];
  lines.push('### ' + (o.id || buildId()) + ' 自动采集候选（' + new Date().toISOString().slice(0, 10) + '）');
  lines.push('');
  lines.push('| 相关度 | 类型 | 标题 | 来源 |');
  lines.push('|---|---|---|---|');
  for (const k of kept.slice(0, 15)) {
    lines.push('| ' + k.relevance + ' | ' + k.kind + ' | ' + String(k.title).replace(/\|/g, '\\|').slice(0, 70) +
      ' | ' + k.sourceKind + ' |');
  }
  lines.push('');
  for (const k of kept.slice(0, 8)) {
    lines.push('- **[' + k.kind + ' · ' + k.relevance + '] ' + String(k.title).slice(0, 90) + '**');
    if (k.url) lines.push('  - ' + k.url);
    if (k.summary) lines.push('  - 摘要：' + k.summary);
    lines.push('  - 建议动作：' + (ACTION[k.kind] || ACTION.other));
  }
  lines.push('');
  return [{ op: 'append-doc', file: 'docs/evolve/backlog.md', title: (o.id || buildId()), body: lines.join('\n') }];
}

function render(ctx) {
  const c = ctx || {};
  const kept = c.kept || [];
  const st = c.stats || {};
  const srcs = c.sources || [];
  const bad = srcs.filter((s) => !s.ok);
  const L = [];

  L.push('# 进化提案 ' + (c.id || ''));
  L.push('');
  L.push('> 生成时间：' + new Date(c.now || Date.now()).toISOString().replace('T', ' ').slice(0, 19) + '　触发原因：**' + (c.reason || 'manual') + '**');
  L.push('> 项目基线：v' + (c.version || '?') + '　断言 ' + (c.assertions || '?') + '　模式：' + (c.tier === 'deep' ? '深检（含最佳实践源）' : '日检（仓库动态）'));
  L.push('');
  L.push('## 一、本轮结论');
  L.push('');
  if (!kept.length) {
    L.push('本轮 **0 条**候选达到阈值（' + (c.minScore || 6) + ' 分）。' + (bad.length ? '其中 ' + bad.length + ' 个源不可达，见第四节。' : ''));
  } else {
    L.push('采集 **' + (st.input || 0) + '** 条 → 过阈值 **' + kept.length + '** 条（其中高优先 **' + (st.high || 0) + '** 条），丢弃 ' + (st.dropped || 0) + ' 条（超时间窗/低分/重复）。');
    const byKind = Object.keys(st.byKind || {}).map((k) => k + '×' + st.byKind[k]).join(' · ');
    if (byKind) L.push('类型分布：' + byKind);
  }
  L.push('');

  if (kept.length) {
    L.push('## 二、候选清单（按相关度降序）');
    L.push('');
    L.push('| # | 相关度 | 分 | 类型 | 来源 | 标题 |');
    L.push('|---|---|---|---|---|---|');
    kept.forEach((k, i) => {
      L.push('| ' + (i + 1) + ' | ' + k.relevance + ' | ' + k.score + ' | ' + k.kind + ' | ' + k.sourceKind +
        ' | [' + String(k.title).replace(/[\[\]|]/g, '').slice(0, 64) + '](' + (k.url || '#') + ') |');
    });
    L.push('');
    L.push('## 三、逐条摘要与建议动作');
    L.push('');
    kept.slice(0, 10).forEach((k, i) => {
      L.push('### ' + (i + 1) + '. ' + String(k.title).slice(0, 90));
      L.push('');
      L.push('- 相关度 **' + k.relevance + '**（原始分 ' + k.score + '）· 类型 `' + k.kind + '` · 来源 `' + k.sourceKind + '`' +
        (k.ageDays != null ? ' · ' + k.ageDays + ' 天前' : '') + (k.cached ? ' · **来自缓存**' : ''));
      L.push('- 命中：' + (k.hits && k.hits.length ? k.hits.slice(0, 5).map((h) => h.kw + '/' + h.where).join('、') : '（来源权重 + 时效）'));
      if (k.summary) L.push('- 摘要：' + k.summary.replace(/\n/g, ' '));
      L.push('- 建议动作：' + (ACTION[k.kind] || ACTION.other));
      L.push('');
    });
  }

  L.push('## 四、数据源状态');
  L.push('');
  L.push('| 源 | 结果 | 条目 | 耗时 | 备注 |');
  L.push('|---|---|---|---|---|');
  for (const s of srcs) {
    L.push('| ' + s.id + ' | ' + (s.ok ? '✅' : (s.cached ? '⚠️ 缓存兜底' : '❌ 不可达')) + ' | ' + s.count + ' | ' + s.ms + 'ms | ' +
      (s.error ? String(s.error).slice(0, 60) : (s.cacheAgeH ? '缓存 ' + s.cacheAgeH + 'h 前' : '')) + ' |');
  }
  L.push('');
  if (bad.length) L.push('> ⚠️ ' + bad.length + ' 个源本轮未取到实时数据，相关结论只代表**已知信息**，不代表"没有新东西"。');
  L.push('');

  L.push('## 五、可执行变更（需审批）');
  L.push('');
  if (c.ops && c.ops.length) {
    L.push('本提案携带 **' + c.ops.length + '** 个改动操作（默认只写文档，不改代码）：');
    L.push('');
    for (const op of c.ops) {
      L.push('- `' + op.op + '` → `' + op.file + '`' + (op.op === 'append-doc' ? '（追加一节）' : '（精确替换）'));
    }
    L.push('');
    L.push('```bash');
    L.push('node scripts/evolve.js apply ' + (c.id || '') + ' --dry-run   # 先看 diff');
    L.push('node scripts/evolve.js apply ' + (c.id || '') + '             # 真应用（自动跑断言，失败自动回滚）');
    L.push('```');
  } else {
    L.push('本提案**没有**可自动应用的改动（未达阈值或全是需要人判断的条目）。先按第三节的建议动作人工评估。');
  }
  L.push('');
  L.push('## 六、决策边界（本机制的自我约束）');
  L.push('');
  L.push('- 只写 `docs/**`、`CHANGELOG.md`、`README.md`；**代码与配置永不自动改**（`--allow-code` + 人工 approve 才放行精确替换）。');
  L.push('- 永不触碰 `.git/`、`_backup/`、`installer/`、`landing*/`、`*.pem`、`.api-token`。');
  L.push('- 应用前要求 `git status` 干净；改动量超预算（默认 3 文件 / 120 行）直接拒绝。');
  L.push('- 断言不过 = 自动回滚，且 journal 留痕。');
  L.push('');
  return L.join('\n');
}

/** 落盘：docs/evolve/proposals/<id>.md + .json（md 进仓库，人可 review） */
function save(root, proposal) {
  const d = path.join(root, 'docs', 'evolve', 'proposals');
  fs.mkdirSync(d, { recursive: true });
  const md = path.join(d, proposal.id + '.md');
  const js = path.join(d, proposal.id + '.json');
  fs.writeFileSync(md, proposal.markdown);
  fs.writeFileSync(js, JSON.stringify(proposal.json, null, 2));
  return { md, json: js };
}

function load(root, id) {
  const d = path.join(root, 'docs', 'evolve', 'proposals');
  const js = path.join(d, id + '.json');
  const md = path.join(d, id + '.md');
  if (!fs.existsSync(js)) return null;
  return { id, json: JSON.parse(fs.readFileSync(js, 'utf8')), markdown: fs.existsSync(md) ? fs.readFileSync(md, 'utf8') : '' };
}

function listProposals(root) {
  const d = path.join(root, 'docs', 'evolve', 'proposals');
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((f) => f.endsWith('.json')).sort().reverse()
    .map((f) => ({ id: f.replace(/\.json$/, ''), at: fs.statSync(path.join(d, f)).mtimeMs }));
}

module.exports = { buildId, buildOps, render, save, load, listProposals, ACTION };
