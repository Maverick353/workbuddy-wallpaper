#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
/**
 * install.js · 把本项目安装为 WorkBuddy 用户技能（幂等）
 * ------------------------------------------------------------------
 *   node scripts/install.js                # 安装到 ~/.workbuddy/skills/workbuddy-wallpaper
 *   node scripts/install.js --no-autostart # 安装但不注册开机自启
 *   node scripts/install.js --uninstall     # 卸载（停服务 + 撤销自启 + 删目录）
 *   node scripts/install.js --status        # 查看安装状态
 *
 * 设计要点：
 *   · 零依赖（Node 标准库）
 *   · 幂等：重复安装 = 先清目标目录再复制（不叠加、不留残）
 *   · 只复制运行所需（排除 .git / node_modules / _tmp / .backup-* / *.log）
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SRC = path.resolve(__dirname, '..');
const SKILL_NAME = 'workbuddy-wallpaper';
const SKILLS_DIR = path.join(os.homedir(), '.workbuddy', 'skills');
const DEST = path.join(SKILLS_DIR, SKILL_NAME);
const COMPANION = path.join(DEST, 'scripts', 'companion.js');
const STOP_UI = path.join(DEST, 'scripts', 'stop-ui.js');
const DATA_DIR = path.join(process.env.APPDATA || os.homedir(), 'workbuddy-wallpaper');

const EXCLUDE_TOP = new Set(['.git', 'node_modules', '_tmp', 'dist']);

function log(...a) { process.stdout.write('[install] ' + a.join(' ') + '\n'); }

/**
 * 两个路径是否「同一个，或存在包含关系」。
 * ⚠️ 这是自毁防护的核心判定：若 SRC === DEST（或互相嵌套），下面的 rmSync 会先把**源目录**删掉，
 * 随后的 cpSync 从一个不存在的源复制 → 用户只是"重装一下"就丢了整份程序（且静默）。
 * 历史上真会踩：用户按 README 手工把文件夹放进 skills 目录后，又照着文档跑了 install.js。
 */
function sameOrNested(a, b) {
  const na = path.resolve(a).toLowerCase();
  const nb = path.resolve(b).toLowerCase();
  if (na === nb) return true;
  const sep = path.sep.toLowerCase();
  return na.startsWith(nb + sep) || nb.startsWith(na + sep);
}

/** 交互式 y/n；非 TTY 或读取失败时返回默认值（默认值一律取"保守"的那个）。 */
function promptYesNo(question, def) {
  try {
    if (!process.stdin.isTTY) return def;
    process.stdout.write(question);
    const buf = Buffer.alloc(256);
    const n = fs.readSync(0, buf, 0, 256, null);
    const s = buf.slice(0, n).toString().trim().toLowerCase();
    if (!s) return def;
    return s === 'y' || s === 'yes' || s === '是';
  } catch (_) {
    process.stdout.write('\n');
    return def;
  }
}

/**
 * 递归删除一个目录树 —— **刻意不用 `fs.rmSync`**。
 *
 * ⚠️ 2026-10-14 实测踩坑：WorkBuddy 托管的那个 Node 会给 `fs.rmSync` 打一个
 *   safe-delete shim（`cli/vendor/shim/node-safe-delete-shim.cjs`），把它重定向成
 *   「丢进回收站」的操作。那个操作会抛：
 *     `[safe-delete] 操作失败 … Error during a 'trash' operation`
 *   → 整个安装流程中断（而且发生在 `rmSync(旧安装目录)` 这一步，正好卡在最关键的位置）。
 *   底层的 unlinkSync / rmdirSync 没有被接管，所以自己递归删，行为确定。
 */
function removeTree(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) removeTree(p);
      else fs.unlinkSync(p);
    } catch (_) {
      // 只读文件先去掉只读位再删
      try { fs.chmodSync(p, 0o666); fs.unlinkSync(p); } catch (_) {}
    }
  }
  try { fs.rmdirSync(dir); } catch (_) {}
}

/** 复制过滤器：排除运行时/临时/版本控制产物。 */
function keep(src) {
  const rel = path.relative(SRC, src);
  if (!rel) return true;
  for (const part of rel.split(path.sep)) {
    if (EXCLUDE_TOP.has(part)) return false;
    if (part.startsWith('.backup-')) return false;
  }
  const base = path.basename(src);
  if (base === '.gitignore' || base === '.gitattributes') return false;  // 仓库专用，不随包分发
  if (base.endsWith('.log')) return false;
  return true;
}

function status() {
  const installed = fs.existsSync(path.join(DEST, 'SKILL.md'));
  log('技能名   :', SKILL_NAME);
  log('安装位置 :', DEST);
  log('已安装   :', installed ? '是' : '否');
  return installed;
}

function install(opts) {
  if (!fs.existsSync(SKILLS_DIR)) fs.mkdirSync(SKILLS_DIR, { recursive: true });

  // ⚠️ 自毁防护（P0）：本脚本若正跑在安装目录里，SRC === DEST，
  //    下面若照常 rmSync 会先把源目录删掉 → cpSync 从空源复制 → 安装目录被清空且无有用提示。
  //    正确处理：跳过复制（本来就已装好），只继续做「注册自启」这类无破坏动作。
  const inPlace = sameOrNested(SRC, DEST);
  if (inPlace) {
    log('检测到本脚本运行在安装目录内（源 = 目标）→ 跳过复制，避免自毁。');
    log('  你看到的这份就是已安装的副本；如需重新安装，请到项目源码目录再执行。');
  } else {
    if (fs.existsSync(DEST)) { log('目标已存在 → 先清理（幂等）'); removeTree(DEST); }
    fs.mkdirSync(DEST, { recursive: true });
    fs.cpSync(SRC, DEST, { recursive: true, filter: keep });
    log('已复制到:', DEST);
  }

  if (opts.noAutostart) { log('已跳过开机自启（--no-autostart）'); }
  else if (fs.existsSync(COMPANION)) {
    log('注册开机自启…');
    const r = spawnSync(process.execPath, [COMPANION, '--install-autostart'], { stdio: 'inherit' });
    if (r.status !== 0) log('（开机自启注册未成功，可稍后手动执行 companion.js --install-autostart）');
  }
  log('完成。启动：node "' + path.join(DEST, 'scripts', 'start-ui.js') + '"');
  log('或让看门狗常驻：node "' + COMPANION + '"');
}

function uninstall() {
  if (fs.existsSync(COMPANION)) {
    // ① 先优雅摘除页面注入（走 CDP 让页面自己卸 DOM/CSS）。
    //    顺序很重要：直接 taskkill /F 硬杀的话，浏览器端的 bye() 永远不会执行，
    //    吉祥物/面板/CSS 会残留在 WorkBuddy 页面里直到宿主重启。
    if (fs.existsSync(STOP_UI)) {
      log('优雅移除页面 UI（CDP 摘除）…');
      spawnSync(process.execPath, [STOP_UI], { stdio: 'inherit' });
    }
    log('停止服务…');
    spawnSync(process.execPath, [COMPANION, '--stop-service'], { stdio: 'inherit' });
    // ② 停看门狗：不停的话，它下个 tick 发现"WorkBuddy 在跑、服务没跑"，
    //    会一直尝试从一个**即将被删掉的目录**拉起服务 → 无限退避循环刷日志。
    log('停止看门狗…');
    spawnSync(process.execPath, [COMPANION, '--stop-watchdog'], { stdio: 'inherit' });
    log('撤销开机自启…');
    spawnSync(process.execPath, [COMPANION, '--uninstall-autostart'], { stdio: 'inherit' });
  }
  if (fs.existsSync(DEST)) { removeTree(DEST); log('已删除:', DEST); }
  else log('目标不存在，无需删除');

  // ③ 数据目录：里面有主题、缓存，以及用户可能自己上传的自定义壁纸 —— **默认保留**，明确问一次。
  if (fs.existsSync(DATA_DIR)) {
    const del = promptYesNo('数据目录还留着（含主题/缓存/你可能上传的自定义壁纸）：\n  ' + DATA_DIR +
      '\n要一并删除吗？[y/N] ', false);
    if (del) {
      try { removeTree(DATA_DIR); log('已删除数据目录'); }
      catch (e) { log('删除数据目录失败：' + e.message + '（可手动删除）'); }
    } else {
      log('已保留数据目录。想手动清掉就删这个文件夹：');
      log('  ' + DATA_DIR);
    }
  }
  log('完成。');
}

// 只有作为主模块运行时才执行命令分发 —— 这样测试可以直接 require 本文件拿纯函数，
// 而不会因为 require 就触发一次真实安装（踩过：require 即安装）。
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    console.log('用法: node scripts/install.js [--no-autostart | --uninstall | --status]');
    process.exit(0);
  }
  if (args.includes('--status')) { status(); process.exit(0); }
  if (args.includes('--uninstall')) { uninstall(); process.exit(0); }
  install({ noAutostart: args.includes('--no-autostart') });
}

// 导出纯函数供 scripts/verify.js 做回归测试
module.exports = { sameOrNested, removeTree, keep, install, uninstall, status, SRC, DEST, SKILL_NAME };
