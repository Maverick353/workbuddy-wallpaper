'use strict';
/**
 * 自我进化 · 日志与状态
 *
 * 目录（全部在仓库根的 `.evolve/`，已 gitignore —— 属于运行态，不入库）：
 *   journal.jsonl   追加式事件流（run / collect / propose / approve / apply / rollback / validate）
 *   state.json      上次运行时间、上次版本、上次应用时间、断言基线
 *   cache/<源>.json 各数据源的最近一次成功响应（离线兜底）
 *   backup/<id>/    应用前的原文件快照（回滚唯一凭据）
 *
 * 设计要点：**只用追加写**。journal 不重写、不截断，任何一次 apply 都能从事件流里复盘。
 */
const fs = require('fs');
const path = require('path');

const ROOT_DIR = '.evolve';

function dir(root) { return path.join(root, ROOT_DIR); }

function ensure(root) {
  const d = dir(root);
  for (const sub of ['', 'cache', 'backup', 'proposals']) fs.mkdirSync(path.join(d, sub), { recursive: true });
  return d;
}

/** 追加一条事件。event.type 必填。 */
function append(root, event) {
  ensure(root);
  const rec = Object.assign({ at: new Date().toISOString(), pid: process.pid }, event);
  fs.appendFileSync(path.join(dir(root), 'journal.jsonl'), JSON.stringify(rec) + '\n');
  return rec;
}

function read(root, limit) {
  try {
    const raw = fs.readFileSync(path.join(dir(root), 'journal.jsonl'), 'utf8').trim();
    if (!raw) return [];
    const lines = raw.split('\n');
    return lines.slice(-(limit || 200)).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  } catch (_) { return []; }
}

function last(root, type) {
  const evs = read(root, 800).filter((e) => !type || e.type === type);
  return evs.length ? evs[evs.length - 1] : null;
}

function state(root) {
  try { return JSON.parse(fs.readFileSync(path.join(dir(root), 'state.json'), 'utf8')); } catch (_) { return {}; }
}

function patchState(root, patch) {
  ensure(root);
  const next = Object.assign({}, state(root), patch);
  fs.writeFileSync(path.join(dir(root), 'state.json'), JSON.stringify(next, null, 2));
  return next;
}

/** 距上次某类事件的小时数；没有记录返回 Infinity（视为"从未"，应当触发）。 */
function hoursSince(root, type) {
  const e = last(root, type);
  if (!e) return Infinity;
  return (Date.now() - new Date(e.at).getTime()) / 3600000;
}

module.exports = { dir, ensure, append, read, last, state, patchState, hoursSince };
