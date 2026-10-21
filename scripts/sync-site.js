#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
/**
 * sync-site.js · 把 `landing/`（唯一源）严格镜像到 `landing-site/`（发布根）
 * ------------------------------------------------------------------
 * 为什么需要两个目录：
 *   2026-10-21 那个下载页的应用被删除后，平台明确**不允许原目录再发布**
 *   （避免悄悄换掉分享链接），恢复方式只有「换一个新目录重新发布」。
 *   所以 `landing/` 仍是唯一的源（脚本写它、断言读它、git 跟踪它），
 *   `landing-site/` 只作为**发布入口**存在。
 *
 * 为什么用"先清空再全量复制"而不是增量：
 *   两份副本分叉的根因永远是"某次忘了同步"。全量镜像让分叉在结构上不可能发生；
 *   `verify.js` 里还有一条断言比对两个目录的文件清单与 sha256（防止忘了跑这个脚本）。
 *
 * 用法：node scripts/sync-site.js [--check]
 *   --check  只比对不写入；不一致时非 0 退出（给 CI / 断言用）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'landing');
const DEST = path.join(ROOT, 'landing-site');
const checkOnly = process.argv.includes('--check');

function walk(dir, base, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) walk(abs, rel, out);
    else out.set(rel, crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex'));
  }
  return out;
}

const srcMap = walk(SRC, '', new Map());
const destMap = fs.existsSync(DEST) ? walk(DEST, '', new Map()) : new Map();

const onlySrc = [...srcMap.keys()].filter((k) => !destMap.has(k));
const onlyDest = [...destMap.keys()].filter((k) => !srcMap.has(k));
const differ = [...srcMap.keys()].filter((k) => destMap.has(k) && destMap.get(k) !== srcMap.get(k));

if (checkOnly) {
  if (onlySrc.length || onlyDest.length || differ.length) {
    console.error('✗ landing/ 与 landing-site/ 不一致：');
    for (const f of onlySrc) console.error('   · 只在源里：' + f);
    for (const f of onlyDest) console.error('   · 只在发布目录：' + f);
    for (const f of differ) console.error('   · 内容不同：' + f);
    console.error('  修：node scripts/sync-site.js');
    process.exit(1);
  }
  console.log('✓ landing/ 与 landing-site/ 完全一致（' + srcMap.size + ' 个文件）');
  process.exit(0);
}

// 全量镜像：删掉发布目录里多余的东西（否则上一次的旧 .bin 会一直被传上去）
if (fs.existsSync(DEST)) {
  for (const e of fs.readdirSync(DEST)) {
    fs.rmSync(path.join(DEST, e), { recursive: true, force: true });
  }
} else {
  fs.mkdirSync(DEST, { recursive: true });
}
let n = 0;
for (const [rel] of srcMap) {
  const to = path.join(DEST, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(path.join(SRC, rel), to);
  n++;
}
console.log('✓ 已镜像 ' + n + ' 个文件 → landing-site/');
for (const [rel, sha] of srcMap) console.log('   ' + rel.padEnd(34) + sha.slice(0, 12));
