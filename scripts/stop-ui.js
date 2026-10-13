#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
/**
 * stop-ui.js · 停止壁纸 UI
 * ------------------------------------------------------------------
 * ① 从宿主页面卸载 UI 与背景层（wdw-* 全部节点与全局钩子）
 * ② 按数据目录里的 .ui.pid 停掉 start-ui.js 起的服务进程
 *
 *   node scripts/stop-ui.js                 # 全清
 *   node scripts/stop-ui.js --keep-server   # 只卸载页面，服务继续跑（供 API 调用）
 */
const fs = require('fs');
const path = require('path');
const { findCdp, hostSession } = require('./cdp.js');
const bg = require(path.join(__dirname, '..', 'ui', 'background.js'));
const { dataDir } = require('./server.js');

const UI_UNINSTALL = '(function(){'
  + 'var removed=[];'
  + '["wdw-rope-buddy","wdw-wallpaper-panel","wdw-dsh-ui-style","wdw-rope-buddy-style","wdw-panel-style","wdw-font-style"].forEach(function(id){var e=document.getElementById(id);if(e){e.remove();removed.push(id);}});'
  + 'try{document.body.classList.remove("wdw-dsh-ui");}catch(_){}'
  + 'try{localStorage.removeItem("wdw.ui.mode");}catch(_){}'
  + '["__wdwRopeBuddy","__wdwPanel"].forEach(function(k){try{if(k in window)delete window[k];}catch(_){}});'
  + 'return removed.join(", ")||"(无)";})()';

(async () => {
  const rawArgs = process.argv.slice(2);
  const i = rawArgs.indexOf('--data-dir');
  const dir = i >= 0 ? rawArgs[i + 1] : dataDir();

  // ① 页面卸载
  const port = await findCdp();
  if (!port) {
    process.stdout.write('[stop-ui] 未发现 CDP，跳过页面卸载（服务照常处理）\n');
  } else {
    const { session } = await hostSession(port);
    const a = await session.ev(UI_UNINSTALL);
    const b = await session.ev(bg.backgroundUninstallExpression());
    process.stdout.write('[stop-ui] 已卸载页面 UI：' + a + '；背景层：' + b + '\n');
    session.close();
  }

  // ② 停服务
  if (rawArgs.includes('--keep-server')) {
    process.stdout.write('[stop-ui] --keep-server：服务继续运行\n');
    return;
  }
  const pidFile = path.join(dir, '.ui.pid');
  if (!fs.existsSync(pidFile)) {
    process.stdout.write('[stop-ui] 没有 .ui.pid（服务可能不是由 start-ui.js 启动的，或已停止）\n');
    return;
  }
  const pid = Number((fs.readFileSync(pidFile, 'utf8') || '').trim());
  if (!pid) { process.stdout.write('[stop-ui] pid 文件内容无效\n'); return; }
  try {
    process.kill(pid);
    process.stdout.write('[stop-ui] 已停止服务进程 pid=' + pid + '\n');
  } catch (e) {
    process.stdout.write('[stop-ui] 服务进程已不在（pid=' + pid + '）：' + e.message + '\n');
  }
  try { fs.unlinkSync(pidFile); } catch (_) {}
})().catch((e) => { process.stdout.write('[stop-ui] 失败：' + ((e && e.message) || e) + '\n'); process.exit(1); });
