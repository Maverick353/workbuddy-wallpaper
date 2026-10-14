#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
/**
 * workbuddy-wallpaper · 独立壁纸服务入口
 * ------------------------------------------------------------------
 * 零依赖（纯 Node 标准库），自带内核（./core）、路由（./server）、场景渲染器（./renderer）
 * 与官方壁纸资产（./assets/wallpapers）。数据目录独立于任何宿主应用。
 *
 *   node scripts/server.js                     # 默认 127.0.0.1:47851
 *   node scripts/server.js --port 48000 --data-dir "D:/my-wallpapers"
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ASSETS_WALLPAPERS = path.join(ROOT, 'assets', 'wallpapers');
const APP_DIR_NAME = 'workbuddy-wallpaper';
const { start, parseArgs } = require(path.join(ROOT, 'server', 'standalone.js'));

// Node 版本自检（P0）：见 scripts/resolve-node.js。
if (!require('./resolve-node.js').assertNodeOk('壁纸服务')) process.exit(1);

/** 本技能自己的数据目录（与 WorkDaddy / WorkBuddy 的任何目录都无关）。 */
function dataDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), APP_DIR_NAME);
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', APP_DIR_NAME);
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), APP_DIR_NAME);
}

/** 首启种子：数据目录没有任何官方壁纸时，把随包资产拷过去。 */
function seedWallpapers(dir) {
  const target = path.join(dir, 'themes', 'wallpapers');
  try {
    if (!fs.existsSync(ASSETS_WALLPAPERS)) return 0;
    const hasAny = fs.existsSync(target) && fs.readdirSync(target).some((f) => f.toLowerCase().endsWith('.webp'));
    if (hasAny) return 0;
    fs.mkdirSync(target, { recursive: true });
    let n = 0;
    for (const f of fs.readdirSync(ASSETS_WALLPAPERS)) {
      if (!f.toLowerCase().endsWith('.webp')) continue;
      fs.copyFileSync(path.join(ASSETS_WALLPAPERS, f), path.join(target, f));
      n++;
    }
    return n;
  } catch (_) { return 0; }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = args.dataDir || dataDir();
  const seeded = seedWallpapers(dir);
  const { url, port } = await start({ ...args, dataDir: dir });
  process.stdout.write(
    'workbuddy-wallpaper 已启动\n' +
    '  服务地址 : ' + url + '\n' +
    '  数据目录 : ' + dir + '\n' +
    '  健康检查 : ' + url + 'api/wallpaper/health\n' +
    '  种子壁纸 : ' + (seeded ? seeded + ' 张（首启自动导入）' : '已有，跳过') + '\n' +
    '  提示     : 只监听本机回环；停止请用 scripts/stop-ui.js 或结束该进程\n'
  );
  return { url, port, dataDir: dir };
}

if (require.main === module) {
  main().catch((e) => { process.stderr.write('启动失败：' + e.message + '\n'); process.exit(1); });
}

module.exports = { ROOT, APP_DIR_NAME, ASSETS_WALLPAPERS, dataDir, seedWallpapers, main, start };
