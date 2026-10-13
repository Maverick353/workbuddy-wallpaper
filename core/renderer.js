// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 WorkDaddy wallpaper contributors
'use strict';
/**
 * wallpaper · 场景渲染器生命周期（vendored WebWallGL）
 * ------------------------------------------------------------------
 * 渲染器构建产物（webwallgl 2.1.0，经 dsh-wallpaper-engine 打包）随插件
 * vendored 在本目录 `renderer/`，运行期由 ensureDeployed() 部署到
 * `<dataDir>/we-renderer/`（daemon 的 /wallpaper-engine/scene-live 挂载点）。
 *
 * 结构改进（相对旧做法「install 时手工部署到数据目录」）：
 *   1. 副本随插件走 —— plugins/ 目录上游升级不覆盖，渲染器永不丢；
 *   2. index.html **不再手工维护**：由 ensureDeployed() 按 assets/ 里的实际
 *      hash 文件名动态生成（含缓存戳与移动端 viewport 修复），上游换 hash 自然适配；
 *   3. 部署损坏自愈：目标目录缺文件 / 版本落后 → 全量重部署；
 *   4. health 上报版本与一致性，线上可观测。
 */

const fs = require('fs');
const path = require('path');

const VENDORED = path.join(__dirname, '..', 'renderer');
const BASE = '/wallpaper-engine/scene-live';

/** 读 vendored 副本的版本信息（.upstream.json）。 */
function vendoredInfo() {
  try {
    return JSON.parse(fs.readFileSync(path.join(VENDORED, '.upstream.json'), 'utf8'));
  } catch (_) {
    return null;
  }
}

/** vendored 副本里需要部署的相对路径清单（.upstream.json files 排除 index.html，它由本模块生成）。 */
function vendoredFiles() {
  const info = vendoredInfo();
  if (!info || !Array.isArray(info.files)) return null;
  const list = info.files.filter((f) => f !== 'index.html');
  for (const rel of list) {
    if (!fs.existsSync(path.join(VENDORED, rel))) return null; // 副本不完整视同缺失
  }
  return list;
}

/** 生成 index.html：按 assets/ 实际 hash 文件名引用，缓存戳取版本号。 */
function buildIndexHtml(info) {
  const assetsDir = path.join(VENDORED, 'assets');
  const names = fs.readdirSync(assetsDir).sort();
  const renderer = names.find((n) => /^renderer-.*\.js$/.test(n));
  const polyfill = names.find((n) => /^modulepreload-polyfill-.*\.js$/.test(n));
  if (!renderer) return null;
  const stamp = `v=${encodeURIComponent((info && info.version) || 'unknown')}`;
  return `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <!--
      移动端 WebView（安卓壁纸宿主）默认按 980px 宽的桌面视口排版，再整体缩放到
      屏宽。壁纸画布是 position:fixed;inset:0，在那个虚拟视口下会被撑成 980×N，
      缩放后画面按桌面宽高比 letterbox 居中，竖屏上下留出大片空白。
      锁定 viewport 到设备宽度，画布才等于真实屏幕，cover 裁切才按真实比例算。
      桌面宿主没有 viewport 概念，这个标签对它无副作用。
    -->
    <meta
      name="viewport"
      content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover"
    />
    <title>WebWallGL Renderer</title>
    <style>
      /* 壁纸页没有文档流内容。去掉默认边距，并关掉移动端的滚动回弹、
         长按选择与点击高亮 —— 否则触摸交互会被 WebView 自己的手势吃掉。 */
      html,
      body {
        margin: 0;
        padding: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: #000;
        overscroll-behavior: none;
        -webkit-user-select: none;
        user-select: none;
        -webkit-tap-highlight-color: transparent;
      }
    </style>
    <script type="module" crossorigin src="${BASE}/assets/${renderer}?${stamp}"></script>${
      polyfill ? `
    <link rel="modulepreload" crossorigin href="${BASE}/assets/${polyfill}?${stamp}">` : ''
    }
  </head>
  <body>
  </body>
</html>
`;
}

function copyFiles(deployDir, relList) {
  fs.mkdirSync(deployDir, { recursive: true });
  for (const rel of relList) {
    const src = path.join(VENDORED, rel);
    const dst = path.join(deployDir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  fs.writeFileSync(path.join(deployDir, '.upstream.json'), JSON.stringify(vendoredInfo(), null, 2));
}

/**
 * 确保渲染器已部署且与 vendored 副本一致。部署目录缺失 / 缺文件 / 版本落后 → 全量重部署。
 * 返回 { deployed: boolean, version, reDeployed: boolean, reason }。
 * 幂等：同一次进程内同一目录只处理一次（除非强制）。
 */
function ensureDeployed(deployDir, options = {}) {
  const info = vendoredInfo();
  const files = vendoredFiles();
  if (!info || !files) {
    return { deployed: false, version: null, reDeployed: false, reason: 'vendored-missing' };
  }
  const target = path.join(deployDir || '', '.upstream.json');
  const deployedInfo = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(deployDir, '.upstream.json'), 'utf8')); } catch (_) { return null; }
  })();
  const intact = deployedInfo
    && deployedInfo.version === info.version
    && files.every((rel) => fs.existsSync(path.join(deployDir, rel)));
  if (!options.force && intact && fs.existsSync(path.join(deployDir, 'index.html'))) {
    return { deployed: true, version: deployedInfo.version, reDeployed: false, reason: 'up-to-date' };
  }
  try {
    copyFiles(deployDir, files);
    const html = buildIndexHtml(info);
    if (!html) return { deployed: false, version: info.version, reDeployed: true, reason: 'no-renderer-asset' };
    fs.writeFileSync(path.join(deployDir, 'index.html'), html);
    return { deployed: true, version: info.version, reDeployed: true, reason: intact ? 'index-regenerated' : 'fresh-deploy' };
  } catch (error) {
    return { deployed: false, version: info.version, reDeployed: false, reason: 'deploy-failed: ' + error.message };
  }
}

/** 部署状态（health 用）：部署目录与 vendored 副本的一致性。 */
function rendererStatus(deployDir) {
  const info = vendoredInfo();
  const files = vendoredFiles();
  const deployedInfo = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(deployDir || '', '.upstream.json'), 'utf8')); } catch (_) { return null; }
  })();
  const upToDate = Boolean(info && deployedInfo
    && deployedInfo.version === info.version
    && files && files.every((rel) => fs.existsSync(path.join(deployDir, rel)))
    && fs.existsSync(path.join(deployDir, 'index.html')));
  return {
    vendored: info ? { version: info.version, commit: info.commit } : null,
    deployed: deployedInfo ? { version: deployedInfo.version } : null,
    upToDate,
    base: BASE,
  };
}

module.exports = { ensureDeployed, rendererStatus, buildIndexHtml, vendoredInfo, VENDORED, BASE };
