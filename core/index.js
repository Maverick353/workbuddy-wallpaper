'use strict';
/**
 * wallpaper · 对外门面（public façade）
 * ------------------------------------------------------------------
 * 上层（daemon 路由 / 独立服务）只依赖这个文件，不直接碰 media/store/we 细节。
 * 语义：管理 WorkDaddy 的壁纸资产（图片 / 视频 / Wallpaper Engine 视频与场景），
 *       并把选中的壁纸落到「当前主题」的背景上。
 */

const media = require('./media.js');
const store = require('./store.js');
const we = require('./we.js');
const renderer = require('./renderer.js');
const themeCss = require('./theme-css.js');
const update = require('./update.js');
const pause = require('./pause.js');

const PLUGIN_ID = 'workdaddy.wallpaper';
const PLUGIN_VERSION = '1.2.3';

module.exports = {
  PLUGIN_ID,
  PLUGIN_VERSION,
  media,
  store,
  we,
  renderer,
  themeCss,
  update,
  pause,
  // 常用直通
  VIDEO_EXTS: media.VIDEO_EXTS,
  MEDIA_MIME: media.MEDIA_MIME,
  isVideoName: media.isVideoName,
  serveMediaFile: media.serveMediaFile,
  listWallpapers: store.listWallpapers,
  listCustom: store.listCustom,
  saveCustom: store.saveCustom,
  deleteCustom: store.deleteCustom,
  writeThemeBg: store.writeThemeBg,
  listWe: we.listWe,
  applyWe: we.applyWe,
  readSceneProperties: we.readSceneProperties,
  applySceneProperties: we.applySceneProperties,
  weScanVideos: we.weScanVideos,
  weFindVideoById: we.weFindVideoById,
  weWorkshopRoots: we.weWorkshopRoots,
  ensureRendererDeployed: renderer.ensureDeployed,
  rendererStatus: renderer.rendererStatus,
  resolveBackgroundAssets: themeCss.resolveBackgroundAssets,
  resolveFrames: themeCss.resolveFrames,
  readMask: themeCss.readMask,
};
