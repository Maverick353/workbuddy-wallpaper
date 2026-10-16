#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
/**
 * release-feed.js · 生成更新用的 feed（version.json）并把更新包镜像到 landing/
 * ------------------------------------------------------------------
 * 用法：
 *   node scripts/release-feed.js [--zip dist/workbuddy-wallpaper.zip] [--version 1.2.0]
 *                               [--min-supported 1.1.0] [--notes "一句话"] [--notes-file x.md]
 *                               [--no-mirror] [--dry-run]
 *
 * 为什么需要它：
 *   · 客户端只认一个 JSON（`version.json`），其中**必须**有 zip 的 url + sha256 + size ——
 *     sha256 是「下载的东西没被中间人换过/没下坏」的唯一凭据，所以必须在发版时算出来写进去。
 *   · 主源是自建静态站（国内可直连），所以更新包也要**镜像一份到 landing/** 一起部署；
 *     只放 GitHub Releases 的话，国内用户点「立即更新」会卡在下载那一步。
 *
 * 注意顺序（来自 release-and-ship 的教训）：**发布与部署是两件事**。
 *   本脚本只产出 `landing/version.json` + 镜像 zip；真正上线要另外跑一次 landing 部署。
 *   不要把它挂在打 tag 之后自动执行 —— tag 推出去不可回滚，部署失败会留下
 *   「版本已发、更新源还是旧的」的残局。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const update = require('../core/update.js');

const ROOT = path.resolve(__dirname, '..');

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : null;
}
const has = (flag) => process.argv.includes(flag);

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = String(arg('--version') || pkg.version);
const zipPath = path.resolve(ROOT, arg('--zip') || path.join('dist', 'workbuddy-wallpaper.zip'));
const landingDir = path.join(ROOT, 'landing');
const feedPath = path.join(landingDir, 'version.json');
const dryRun = has('--dry-run');
const noMirror = has('--no-mirror');

if (!update.parseVersion(version)) {
  console.error('版本号非法: ' + version);
  process.exit(1);
}
if (!fs.existsSync(zipPath)) {
  console.error('找不到更新包：' + zipPath + '\n  先构建：git archive --format=zip --prefix=workbuddy-wallpaper/ -o dist/workbuddy-wallpaper.zip HEAD');
  process.exit(1);
}

// ── ① 校验：包里的 package.json 版本必须等于要发布的版本（防串包）───────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wbwp-feed-'));
let innerVersion = null;
try {
  update.unzipTo(zipPath, tmp);
  const inner = JSON.parse(fs.readFileSync(path.join(tmp, 'workbuddy-wallpaper', 'package.json'), 'utf8'));
  innerVersion = String(inner.version);
} catch (e) {
  console.error('无法读取更新包内容：' + ((e && e.message) || e));
  process.exit(1);
} finally {
  update.removeTree(tmp);
}
if (innerVersion !== version) {
  console.error('版本不一致：包内 package.json = ' + innerVersion + '，要发布的是 ' + version + '。');
  console.error('  （zip 多半是旧提交打的。重新用当前 HEAD 打一次。）');
  process.exit(1);
}

// ── ② 算 sha256 / size ─────────────────────────────────────────────────────
const buf = fs.readFileSync(zipPath);
const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
const size = buf.length;

// ── ③ 组装 feed ───────────────────────────────────────────────────────────
const notesFile = arg('--notes-file');
const notes = notesFile
  ? fs.readFileSync(path.resolve(ROOT, notesFile), 'utf8').trim()
  : (arg('--notes') || '');
const repoSlug = 'Maverick353/workbuddy-wallpaper';
const zipName = 'workbuddy-wallpaper.zip';
const ghUrl = 'https://github.com/' + repoSlug + '/releases/download/v' + version + '/' + zipName;
const siteBase = 'https://workbuddy-wallpaper.app.workbuddy.host';

const feed = {
  schema: 1,
  channel: 'stable',
  latest: version,
  minSupported: arg('--min-supported') || null,
  releasedAt: new Date().toISOString(),
  url: siteBase + '/',
  notes: notes,
  assets: {
    zip: {
      // 主源 = 自建静态站（国内可直连）；GitHub Release 作镜像兜底。
      url: noMirror ? ghUrl : siteBase + '/' + zipName,
      mirrors: noMirror ? [] : [ghUrl],
      size: size,
      sha256: sha256,
    },
  },
};

console.log('更新包  : ' + path.relative(ROOT, zipPath));
console.log('  大小  : ' + size + ' 字节 (' + (size / 1048576).toFixed(2) + ' MB)');
console.log('  sha256: ' + sha256);
console.log('  包内版本: ' + innerVersion + '  ✓ 与发布版本一致');
console.log('主线地址: ' + feed.assets.zip.url);
console.log('镜像地址: ' + (feed.assets.zip.mirrors[0] || '(无)'));

if (dryRun) { console.log('\n--dry-run：什么都没写。'); process.exit(0); }

fs.mkdirSync(landingDir, { recursive: true });
fs.writeFileSync(feedPath, JSON.stringify(feed, null, 2) + '\n');
console.log('\n已写 ' + path.relative(ROOT, feedPath));

if (!noMirror) {
  const dest = path.join(landingDir, zipName);
  fs.copyFileSync(zipPath, dest);
  console.log('已镜像更新包 → ' + path.relative(ROOT, dest) + '（部署 landing 时会一起上线）');
}
console.log('\n下一步：部署 landing/ 到静态站（发布与部署分开跑），然后核对 ' +
  siteBase + '/version.json 可访问且 sha256 与上面一致。');
