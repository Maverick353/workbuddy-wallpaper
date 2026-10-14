#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
/**
 * restore-shortcut.js · 撤销 fix-shortcut.js 对快捷方式的修改
 * ==================================================================
 * fix-shortcut.js 每次改动前都会在**同目录**留一份 `<快捷方式>.lnk.bak-<时间戳>`。
 * 本脚本把这些备份还原回去（默认还原**最近一次**改动之前的状态）。
 *
 * 用法：
 *   node scripts/restore-shortcut.js           # 列出候选 → 确认 → 还原最近一份
 *   node scripts/restore-shortcut.js --oldest  # 还原到**最早**那份（= 最初、加参数之前）
 *   node scripts/restore-shortcut.js --list    # 只看有哪些备份
 *   node scripts/restore-shortcut.js --yes
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const lnk = require('./lnk.js');

const log = (...a) => process.stdout.write('[restore-shortcut] ' + a.join(' ') + '\n');
const warn = (...a) => process.stderr.write('[restore-shortcut] ' + a.join(' ') + '\n');

function confirm(question) {
  if (process.argv.includes('--yes')) return true;
  try {
    if (!process.stdin.isTTY) { warn('（非交互环境，未确认 → 不修改；要自动执行请加 --yes）'); return false; }
    process.stdout.write(question);
    const buf = Buffer.alloc(64);
    const n = fs.readSync(0, buf, 0, 64, null);
    const s = buf.slice(0, n).toString().trim().toLowerCase();
    return s === '' || s === 'y' || s === 'yes';
  } catch (_) { return false; }
}

function dirs() {
  const home = os.homedir();
  const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  return [
    path.join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'),
    path.join(home, 'Desktop'),
    process.env.PUBLIC ? path.join(process.env.PUBLIC, 'Desktop') : null,
  ].filter(Boolean);
}

/** 找 WorkBuddy 快捷方式的备份：<dir>/WorkBuddy.lnk.bak-* */
function findBackups() {
  const out = [];
  for (const dir of dirs()) {
    if (!fs.existsSync(dir)) continue;
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { continue; }
    for (const n of names) {
      if (!/^WorkBuddy\.lnk\.bak-/i.test(n)) continue;
      const f = path.join(dir, n);
      try {
        const st = fs.statSync(f);
        const buf = fs.readFileSync(f);
        out.push({ file: f, target: f.replace(/\.bak-.*$/, ''), mtime: st.mtimeMs, size: buf.length, args: lnk.readArguments(buf) });
      } catch (_) {}
    }
  }
  out.sort((a, b) => a.mtime - b.mtime);   // 早 → 晚
  return out;
}

function main() {
  const listOnly = process.argv.includes('--list');
  const useOldest = process.argv.includes('--oldest');
  const all = findBackups();

  if (!all.length) {
    log('没找到任何快捷方式备份（形如 WorkBuddy.lnk.bak-*）。');
    log('说明 fix-shortcut.js 还没在本机改过，或备份被手动删了。');
    process.exit(0);
  }

  log('找到 ' + all.length + ' 份备份（早 → 晚）：');
  all.forEach((b, i) => {
    log('  [' + i + '] ' + path.basename(b.file) + '  ' + b.size + ' 字节  ARGUMENTS=' + JSON.stringify(b.args));
  });

  if (listOnly) process.exit(0);

  const pick = useOldest ? all[0] : all[all.length - 1];
  log('');
  log('将还原：' + path.basename(pick.file) + '  →  ' + pick.target);
  log('（该备份的 ARGUMENTS = ' + JSON.stringify(pick.args) + '，即还原后参数会变成这个值）');
  if (!confirm('按回车确认还原（Ctrl+C 取消）：')) { log('已取消。'); process.exit(0); }

  try {
    const buf = fs.readFileSync(pick.file);
    const tmp = pick.target + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, pick.target);       // 原子替换
    log('✓ 已还原：' + pick.target);
    log('  当前 ARGUMENTS = ' + JSON.stringify(lnk.readArguments(fs.readFileSync(pick.target))));
    log('  生效需要完全退出 WorkBuddy 后用该快捷方式重开。');
  } catch (e) {
    warn('✗ 还原失败：' + e.message + '（可手动把备份文件复制回原名）');
    process.exit(1);
  }
  process.exit(0);
}

main();
