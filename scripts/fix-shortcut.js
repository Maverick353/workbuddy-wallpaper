#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
/**
 * fix-shortcut.js · 让 WorkBuddy 带上调试端口启动（改快捷方式，不碰进程）
 * ==================================================================
 * 为什么是"改快捷方式"而不是"关掉重启"：
 *   WorkBuddy 是 Electron 应用，**单实例** —— 应用已在运行时再点一次快捷方式，
 *   新参数会被既有实例接管并**忽略**，所以"重启"必须先把应用完全退出。
 *   而"自动关掉再重启"这条路在父项目里有过血的教训（见 WorkDaddy-guardian/guardian.js 注释）：
 *   taskkill 后重启会留下**权限不可读的孤儿进程**，导致整条流水线罢工、**需要重启电脑**；
 *   且强杀有未落盘会话丢失的风险。
 *   ⇒ 本工具**只改快捷方式并告诉你"要怎么重开"，绝不杀任何进程**。
 *
 * 用法：
 *   node scripts/fix-shortcut.js            # 找到 → 说明将做什么 → 按回车确认 → 改（改前备份）
 *   node scripts/fix-shortcut.js --dry-run  # 只说明，不落盘
 *   node scripts/fix-shortcut.js --yes      # 跳过确认（自动化用）
 *   node scripts/fix-shortcut.js --port 9222
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const lnk = require('./lnk.js');

const PORT = (() => {
  const i = process.argv.indexOf('--port');
  return i >= 0 ? Number(process.argv[i + 1]) || 9222 : 9222;
})();
const ARG = '--remote-debugging-port=' + PORT;

const log = (...a) => process.stdout.write('[fix-shortcut] ' + a.join(' ') + '\n');
const warn = (...a) => process.stderr.write('[fix-shortcut] ' + a.join(' ') + '\n');
const exists = (p) => { try { return !!p && fs.existsSync(p); } catch (_) { return false; } };

/** 确认（非 TTY 默认"不改"，安全）。 */
function confirm(question) {
  if (process.argv.includes('--yes')) return true;
  try {
    if (!process.stdin.isTTY) { warn('（非交互环境，未确认 → 不修改；要自动执行请加 --yes）'); return false; }
    process.stdout.write(question);
    const buf = Buffer.alloc(64);
    const n = fs.readSync(0, buf, 0, 64, null);
    const s = buf.slice(0, n).toString().trim().toLowerCase();
    return s === '' || s === 'y' || s === 'yes' || s === '回车' || s === '是';
  } catch (_) { return false; }
}

/** 收集要扫描的快捷方式目录。 */
function shortcutDirs() {
  const home = os.homedir();
  const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  return [
    path.join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'),
    path.join(home, 'Desktop'),
    process.env.PUBLIC ? path.join(process.env.PUBLIC, 'Desktop') : null,
  ].filter(Boolean);
}

/** 扫描所有 .lnk，返回 {file, target, args}[]。 */
function scanShortcuts() {
  const out = [];
  for (const dir of shortcutDirs()) {
    if (!exists(dir)) continue;
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { continue; }
    for (const n of names) {
      if (!/\.lnk$/i.test(n)) continue;
      const f = path.join(dir, n);
      try {
        const buf = fs.readFileSync(f);
        out.push({ file: f, target: lnk.readTarget(buf) || '', args: lnk.readArguments(buf), name: n });
      } catch (_) { /* 不是 .lnk 或读不了，忽略 */ }
    }
  }
  return out;
}

/** 找 WorkBuddy 的快捷方式（按 .lnk 里的目标 exe 名判定）。 */
function findWorkBuddyShortcuts(all) {
  return all.filter((s) => /[\\/]WorkBuddy\.exe$/i.test(s.target));
}

/** 探常见安装位置（快捷方式都没了时的兜底）。 */
function probeInstallPaths() {
  const home = os.homedir();
  const cands = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'WorkBuddy', 'WorkBuddy.exe'),
    path.join(process.env.ProgramFiles || '', 'WorkBuddy', 'WorkBuddy.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'WorkBuddy', 'WorkBuddy.exe'),
  ];
  try {
    for (const d of ['C', 'D', 'E', 'F']) {
      cands.push(d + ':\\AI\\WorkBuddy\\WorkBuddy.exe');
      cands.push(d + ':\\WorkBuddy\\WorkBuddy.exe');
    }
  } catch (_) {}
  return cands.filter(exists);
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const all = scanShortcuts();

  // 1) 先按"现有快捷方式"定位（最准：用户实际用的就是它）
  const wb = findWorkBuddyShortcuts(all);
  if (wb.length) {
    log('找到 ' + wb.length + ' 个 WorkBuddy 快捷方式（来源：现有 .lnk 的目标路径）：');
    for (const s of wb) log('  · ' + s.file + '  → ' + s.target);
  } else {
    log('没找到指向 WorkBuddy.exe 的快捷方式。');
    const found = probeInstallPaths();
    if (found.length) {
      log('但在这些位置找到了 WorkBuddy.exe：');
      for (const p of found) log('  · ' + p);
      log('（单纯找到 exe 不够 —— 需要有一个快捷方式才能给它加参数。手动建一个：');
      log('   右键该 exe → 显示更多选项 → 发送到 → 桌面快捷方式；然后重跑本命令。）');
    } else {
      log('也没在常见位置找到 WorkBuddy.exe。');
      log('请手动给 WorkBuddy 的快捷方式加上参数（右键快捷方式 → 属性 → 目标 末尾追加）：');
      log('  ' + ARG);
    }
    process.exit(0);
  }

  // 2) 逐个判断是否需要改（幂等 + 不制造重复标志）
  const need = [];
  for (const s of wb) {
    const cur = s.args || '';
    const tokens = cur.split(/\s+/).filter(Boolean);
    if (tokens.includes(ARG)) { log('已是目标参数，跳过：' + s.file); continue; }
    // 已有其它端口参数时**替换它的值**，而不是再追加一个 ——
    // 追加会得到 `--remote-debugging-port=9222 --remote-debugging-port=9223` 这种重复标志，
    // Chromium 对重复标志的行为不可预期（谁生效取决于解析顺序）。
    const dup = tokens.findIndex((t) => /^--remote-debugging-port=/.test(t));
    const next = dup >= 0
      ? tokens.map((t, i) => (i === dup ? ARG : t)).join(' ')
      : (tokens.length ? tokens.join(' ') + ' ' + ARG : ARG);
    need.push({ ...s, next });
  }
  if (!need.length) {
    log('全部快捷方式都已带 ' + ARG + '，无需修改。');
    process.exit(0);
  }

  // 3) 说明将做什么（改的是用户桌面/开始菜单里的东西，必须先讲清）
  log('');
  log('将进行以下修改（**只改快捷方式文件，不动任何进程**）：');
  for (const s of need) {
    log('  · ' + s.file);
    log('      参数：' + JSON.stringify(s.args || '') + '  →  ' + JSON.stringify(s.next));
    log('      备份：' + s.file + '.bak-' + '<时间戳>');
  }

  if (dryRun) { log('\n（--dry-run：未落盘）'); process.exit(0); }
  log('');
  if (!confirm('按回车确认执行（Ctrl+C 取消）：')) { log('已取消，未做任何修改。'); process.exit(0); }

  // 4) 执行：先备份，再**原子替换**（写临时文件 + rename），避免半写坏掉用户快捷方式
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  let okN = 0;
  for (const s of need) {
    try {
      const buf = fs.readFileSync(s.file);
      const out = lnk.setArguments(buf, s.next);
      const bak = s.file + '.bak-' + stamp;
      fs.writeFileSync(bak, buf);
      const tmp = s.file + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, out);
      fs.renameSync(tmp, s.file);
      // 复核：改完再读一遍
      const check = lnk.readArguments(fs.readFileSync(s.file));
      if (check !== s.next) throw new Error('写后复核不一致：' + JSON.stringify(check));
      log('✓ 已修改并复核通过：' + s.file);
      okN++;
    } catch (e) {
      warn('✗ 修改失败：' + s.file + ' → ' + e.message);
      warn('  （若提示权限不足，请关掉杀软/受控文件夹访问后重试；备份仍在原目录）');
    }
  }

  log('');
  log('完成 ' + okN + '/' + need.length + ' 个。');
  log('');
  log('⚠️ 现在必须这样做才生效：');
  log('   1. **完全退出 WorkBuddy**（不是最小化 —— 托盘图标也退掉，确保没有 WorkBuddy.exe 残留）');
  log('   2. **用刚改过的那个快捷方式**重新打开');
  log('   3. 验证：node scripts/companion.js --status  → 第 4 行应为 CDP ' + PORT + ': LISTENING');
  log('   为什么必须完全退出：WorkBuddy 是单实例应用，已在运行时再点快捷方式，新参数会被旧实例忽略。');
  log('   想撤销：node scripts/restore-shortcut.js');
  process.exit(okN === need.length ? 0 : 1);
}

main();
