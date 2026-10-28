'use strict';
/**
 * 自我进化 · 筛选与评估
 *
 * 三步：①时间窗/噪音过滤 → ②按「目标关键词 + 来源权重 + 时效 + 标签」打分 → ③去重与分类。
 * 打分是**确定性规则**，不用模型：可复现、可断言、CI 里也能跑。
 * 只有 score ≥ config.scoring.minScore 的条目才进提案；≥ highScore 标为高优先。
 */

const KIND_RULES = [
  ['security', /\b(cve-\d{4}-\d+|security|vulnerab|advisory|exploit|xss|csrf|rce)\b/i],
  // 宿主/运行时升级：对本项目是"必须复测"的信号（Chromium 变了，color-mix / :focus-visible / 注入时序都可能变）
  ['compat', /\b(has been released|release notes|chromium \d+|node v?\d+\.\d+|breaking change|deprecat)\b|升级|兼容/i],
  ['perf', /\b(perf|performance|slow|lag|stutter|memory leak|cpu|gpu|fps|optimi[sz])\b|卡顿|性能|内存|占用/i],
  ['bug', /\b(bug|crash|error|exception|fail(ed|s)?|broken|regression|hang|deadlock)\b|崩溃|报错|失败|无响应/i],
  ['ux', /\b(ui|ux|usability|accessib|layout|contrast|keyboard|font)\b|界面|交互|体验|排版|可读/i],
  ['doc', /\b(docs?|readme|guide|tutorial|changelog|documentation)\b|文档|说明/i],
  ['feature', /\b(feature|support|add|request|idea|enhancement|proposal)\b|建议|需求|支持/i],
];

const LABEL_BONUS = { bug: 2, regression: 2, security: 3, enhancement: 1, 'help wanted': 1 };

function classify(item) {
  const hay = (item.title || '') + ' ' + (item.text || '') + ' ' + (item.labels || []).join(' ');
  // 自家发版：先判安全（安全公告要留下），再判 release，别落进 doc 里误导"该补文档"
  if (item.sourceKind === 'repo-release') {
    if (KIND_RULES[0][1].test(hay)) return 'security';
    return 'release';
  }
  for (const [kind, re] of KIND_RULES) if (re.test(hay)) return kind;
  return 'other';
}

/** 极简抽取式摘要：按关键词密度挑 2 句，截 200 字。没有模型、可复现。 */
function summarize(text, keywords, maxChars) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const limit = maxChars || 200;
  if (t.length <= limit) return t;
  const parts = t.split(/(?<=[。！？.!?])\s*/).filter((s) => s.length > 4);
  if (!parts.length) return t.slice(0, limit);
  const kw = (keywords || []).map((k) => k.toLowerCase());
  const scored = parts.map((s, i) => {
    const low = s.toLowerCase();
    let n = 0;
    for (const k of kw) if (low.includes(k)) n += 1;
    return { s, i, n };
  }).sort((a, b) => (b.n - a.n) || (a.i - b.i));
  const picked = scored.slice(0, 2).sort((a, b) => a.i - b.i).map((x) => x.s);
  return picked.join(' ').slice(0, limit);
}

function tokensOf(s) {
  const raw = String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter(Boolean);
  const set = new Set();
  for (const w of raw) {
    if (/^[\u4e00-\u9fa5]+$/.test(w)) { for (let i = 0; i < w.length - 1; i++) set.add(w.slice(i, i + 2)); } else if (w.length > 2) set.add(w);
  }
  return set;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/**
 * @returns {{kept:Array, dropped:Array, stats:Object}}
 * kept 里每条带 score / relevance(0-100) / kind / summary / hits
 */
function rank(items, cfg, opt) {
  const sc = Object.assign({ minScore: 6, highScore: 12, windowDays: 180, sourceWeight: {} }, cfg.scoring || {});
  const goals = cfg.goals || [];
  const o = Object.assign({ now: Date.now() }, opt || {});
  const windowMs = sc.windowDays * 86400000;
  const dropped = [];
  const scored = [];

  for (const it of items) {
    if (!it || !it.title) { dropped.push({ reason: 'no-title', item: it }); continue; }
    const ts = Number(it.ts) || 0;
    const ageDays = ts ? Math.round((o.now - ts) / 86400000) : null;
    // 时间窗：安全类不受限（历史公告仍要看），其余超窗丢弃
    const hay = (it.title || '') + ' ' + (it.text || '');
    const isSec = KIND_RULES[0][1].test(hay);
    // 自家发版记录不是"新情报"：已发出去的版本我们本来就知道，进候选只会淹没真信号
    if (it.own && it.sourceKind === 'repo-release' && !isSec) {
      dropped.push({ reason: 'own-release(不入候选)', item: it });
      continue;
    }
    if (ageDays != null && ageDays > sc.windowDays && !isSec) {
      dropped.push({ reason: 'out-of-window(' + ageDays + 'd)', item: it });
      continue;
    }
    if (String(it.text || '').trim().length < 12 && String(it.title).length < 10) {
      dropped.push({ reason: 'too-thin', item: it });
      continue;
    }

    let raw = 0;
    const hits = [];
    const titleLow = String(it.title).toLowerCase();
    const textLow = String(it.text || '').toLowerCase();
    for (const g of goals) {
      const w = g.weight == null ? 1 : g.weight;
      for (const k of g.keywords || []) {
        const kl = String(k).toLowerCase();
        if (!kl) continue;
        if (titleLow.includes(kl)) { raw += 3 * w; hits.push({ goal: g.id, kw: k, where: 'title' }); }
        else if (textLow.includes(kl)) { raw += 1 * w; hits.push({ goal: g.id, kw: k, where: 'text' }); }
      }
    }
    raw += (sc.sourceWeight[it.sourceKind] || 1);
    if (ageDays != null) raw += ageDays <= 30 ? 2 : (ageDays <= 90 ? 1 : 0);
    if (isSec) raw += 4;
    for (const lb of it.labels || []) raw += (LABEL_BONUS[String(lb).toLowerCase()] || 0);
    if (!it.url) raw -= 1;

    const kind = classify(it);
    const score = Math.max(0, raw);
    if (score < sc.minScore) { dropped.push({ reason: 'low-score(' + score + ')', item: it }); continue; }

    scored.push({
      id: it.id,
      title: it.title,
      url: it.url,
      source: it.source,
      sourceKind: it.sourceKind,
      ts: ts || null,
      ageDays,
      cached: !!it.fromCache,
      score,
      relevance: Math.min(100, Math.round((score / 25) * 100)),
      high: score >= sc.highScore,
      kind,
      hits,
      summary: summarize(it.text, hits.map((h) => h.kw), 200),
    });
  }

  // 去重：同 URL 直接合并；标题词集 Jaccard > 0.75 视为同一件事，保留高分那条
  const kept = [];
  for (const c of scored.sort((a, b) => b.score - a.score)) {
    const tk = tokensOf(c.title);
    const dup = kept.find((k) => (c.url && k.url === c.url) || jaccard(tokensOf(k.title), tk) > 0.75);
    if (dup) { dup.dupes = (dup.dupes || 1) + 1; continue; }
    kept.push(c);
  }

  return {
    kept,
    dropped,
    stats: {
      input: items.length,
      kept: kept.length,
      high: kept.filter((k) => k.high).length,
      dropped: dropped.length,
      byKind: kept.reduce((m, k) => { m[k.kind] = (m[k.kind] || 0) + 1; return m; }, {}),
    },
  };
}

module.exports = { rank, classify, summarize, tokensOf, jaccard };
