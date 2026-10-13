'use strict';
/**
 * wallpaper · 媒体类型与文件服务
 * ------------------------------------------------------------------
 * 纯函数层：MIME 表、扩展名判定、dataURL 解析、带 HTTP Range 的静态文件服务。
 * 不依赖 daemon，可独立 require（daemon 的主题渲染核也 require 这里的 VIDEO_EXTS）。
 *
 * ⚠️ VIDEO_EXTS 与 daemon.js 里同名的常量必须保持一致（daemon 用它判断主题背景是否为视频）。
 */

const fs = require('fs');
const path = require('path');

/** 媒体类型 → MIME。ES Module 严格校验：.js 必须是 text/javascript，否则被浏览器拒绝执行。 */
const MEDIA_MIME = {
  '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webm': 'video/webm', '.mp4': 'video/mp4', '.ogg': 'video/ogg', '.mov': 'video/quicktime',
  '.pkg': 'application/octet-stream', '.json': 'application/json',
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml',
};

/** 视频扩展名（与 daemon.js 的同名常量保持一致）。 */
const VIDEO_EXTS = ['.webm', '.mp4', '.ogg', '.mov'];

/** 可上传/可管理器识别的全部壁纸扩展名。 */
const WALLPAPER_EXTS_RE = /\.(webp|png|jpe?g|gif|webm|mp4|ogg|mov)$/i;

/** 自定义壁纸文件名（仅允许 custom- 前缀，防误删官方壁纸）。 */
const CUSTOM_NAME_RE = /^custom-[A-Za-z0-9_.-]+\.(webp|png|jpe?g|gif|webm|mp4|ogg|mov)$/i;

/** 主题背景文件名（含场景 .pkg）。 */
const BACKGROUND_NAME_RE = /^background\.(webp|png|jpe?g|gif|webm|mp4|ogg|mov|pkg)$/i;

/** 主题背景文件名（不含 .pkg，用于清理旧背景时避免误删当前 .pkg）。 */
const BACKGROUND_MEDIA_RE = /^background\.(webp|png|jpe?g|gif|webm|mp4|ogg|mov)$/i;

/** 上传通道接受的 dataURL。 */
const DATA_URL_RE = /^data:(image\/(?:png|jpe?g|webp|gif)|video\/(?:webm|mp4|ogg|quicktime));base64,(.+)$/i;

/** MIME → 落盘扩展名。 */
const MIME_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/webm': 'webm', 'video/mp4': 'mp4', 'video/ogg': 'ogg', 'video/quicktime': 'mov',
};

const VIDEO_MAX_BYTES = 80 * 1024 * 1024;
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

function isVideoName(name) {
  return VIDEO_EXTS.indexOf(path.extname(String(name || '')).toLowerCase()) !== -1;
}

/** 文件名 → 扩展名（无点）。.jpeg 归一为 jpg。 */
function extOfName(name) {
  const e = path.extname(String(name)).toLowerCase();
  return (e === '.jpeg' ? 'jpg' : e.replace(/^\./, '')) || '';
}

/** MIME → 扩展名（无点）。 */
function extOfMime(mime, isVideo) {
  return MIME_EXT[String(mime).toLowerCase()] || (isVideo ? 'mp4' : 'webp');
}

/** 是否为允许上传的 dataURL。 */
function parseDataUrl(dataUrl) {
  const m = DATA_URL_RE.exec(String(dataUrl || ''));
  if (!m) return null;
  const mime = String(m[1]).toLowerCase();
  const isVideo = mime.indexOf('video/') === 0;
  return { mime, isVideo, buf: Buffer.from(m[2], 'base64'), ext: extOfMime(mime, isVideo) };
}

/**
 * 带 HTTP Range 的媒体文件服务（支持 GET / HEAD）。
 * 视频必须支持 Range(206)，否则 <video> 无法流式播放；HEAD 用于渲染器/媒体探测。
 */
function serveMediaFile(req, res, file, name) {
  const isHead = req.method === 'HEAD';
  const mime = MEDIA_MIME[path.extname(String(name)).toLowerCase()];
  if (!mime) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end(isHead ? undefined : 'not found'); }
  let stat;
  try { stat = fs.statSync(file); } catch (_) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end(isHead ? undefined : 'not found'); }
  const size = stat.size;
  const headers = { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache, no-store, must-revalidate' };
  const range = req.headers && req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    if (m && (m[1] || m[2])) {
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : size - 1;
      if (!Number.isFinite(start) || start < 0) start = 0;
      if (!Number.isFinite(end) || end >= size) end = size - 1;
      if (start > end) { res.writeHead(416, { 'Content-Range': 'bytes */' + size }); return res.end(); }
      headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size;
      headers['Content-Length'] = end - start + 1;
      res.writeHead(206, headers);
      if (isHead) return res.end();
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
  }
  headers['Content-Length'] = size;
  res.writeHead(200, headers);
  if (isHead) return res.end();
  return fs.createReadStream(file).pipe(res);
}

module.exports = {
  MEDIA_MIME,
  VIDEO_EXTS,
  WALLPAPER_EXTS_RE,
  CUSTOM_NAME_RE,
  BACKGROUND_NAME_RE,
  BACKGROUND_MEDIA_RE,
  DATA_URL_RE,
  MIME_EXT,
  VIDEO_MAX_BYTES,
  IMAGE_MAX_BYTES,
  isVideoName,
  extOfName,
  extOfMime,
  parseDataUrl,
  serveMediaFile,
};
