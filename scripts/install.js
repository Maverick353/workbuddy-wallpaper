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

const EXCLUDE_TOP = new Set(['.git', 'node_modules', '_tmp']);

function log(...a) { process.stdout.write('[install] ' + a.join(' ') + '\n'); }

/** 复制过滤器：排除运行时/临时/版本控制产物。 */
function keep(src) {
  const rel = path.relative(SRC, src);
  if (!rel) return true;
  for (const part of rel.split(path.sep)) {
    if (EXCLUDE_TOP.has(part)) return false;
    if (part.startsWith('.backup-')) return false;
  }
  if (path.basename(src).endsWith('.log')) return false;
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
  if (fs.existsSync(DEST)) { log('目标已存在 → 先清理（幂等）'); fs.rmSync(DEST, { recursive: true, force: true }); }
  fs.mkdirSync(DEST, { recursive: true });
  fs.cpSync(SRC, DEST, { recursive: true, filter: keep });
  log('已复制到:', DEST);

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
    log('停止服务…');
    spawnSync(process.execPath, [COMPANION, '--stop-service'], { stdio: 'inherit' });
    log('撤销开机自启…');
    spawnSync(process.execPath, [COMPANION, '--uninstall-autostart'], { stdio: 'inherit' });
  }
  if (fs.existsSync(DEST)) { fs.rmSync(DEST, { recursive: true, force: true }); log('已删除:', DEST); }
  else log('目标不存在，无需删除');
  log('完成。（数据目录 %APPDATA%\\workbuddy-wallpaper 未动，如需清除请手动删除）');
}

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  console.log('用法: node scripts/install.js [--no-autostart | --uninstall | --status]');
  process.exit(0);
}
if (args.includes('--status')) { status(); process.exit(0); }
if (args.includes('--uninstall')) { uninstall(); process.exit(0); }
install({ noAutostart: args.includes('--no-autostart') });
