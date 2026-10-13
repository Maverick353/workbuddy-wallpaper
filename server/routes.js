'use strict';
/**
 * wallpaper · 服务端路由（daemon 适配层）
 * ------------------------------------------------------------------
 * 只做三件事：解析路径 → 调 core → 输出 JSON / 文件。
 * 业务逻辑一律在 core/ 里，本文件不做任何文件读写与扫描计算。
 *
 * 由 scripts/wallpaper.js（WorkDaddy 侧的薄桥接）实例化，daemon.js 只在
 * handleApi() 与 startServer() 各挂一处转发，不侵入任何既有逻辑。
 *
 * ctx 契约（由 daemon 注入）：
 *   { json, readBody, log, dataDir, themesDir?, wallpapersDir?, weRendererDir?, applyTheme?, version?, apiToken? }
 */

const fs = require('fs');
const path = require('path');

const core = require('../core/index.js');
const media = core.media;
const store = core.store;
const we = core.we;
const { readMask } = require('../core/theme-css.js'); // 蒙版与 theme-css 单一源

/** 本插件负责的 API 路径（daemon 的 handleApi 据此转发）。 */
const ROUTES = [
  ['GET', '/api/wallpaper/health'],
  ['GET', '/api/wallpapers'],
  ['GET', '/api/custom-wallpapers'],
  ['POST', '/api/custom-wallpapers'],
  ['DELETE', '/api/custom-wallpapers'],
  ['GET', '/api/we-wallpapers'],
  ['POST', '/api/we-apply'],
  ['POST', '/api/theme-bg'],
  ['GET', '/api/mask'],
  ['POST', '/api/mask'],
];

/** 本插件负责的静态路径前缀（daemon 的 startServer 据此转发）。 */
const STATIC_PREFIXES = ['/wallpapers/', '/theme-media/', '/wallpaper-engine/scene-live/', '/wallpaper-engine/scene-files/'];

function dirs(ctx) {
  return store.dirsFor(ctx);
}

function ctxWithDirs(ctx) {
  const d = dirs(ctx);
  return { ...ctx, themesDir: d.themesDir, wallpapersDir: d.wallpapersDir };
}

/** 是否本插件负责的 API 路径。 */
function isApiPath(p) {
  if (p === '/api/wallpaper/health') return true;
  if (p === '/api/wallpapers' || p === '/api/custom-wallpapers' || p === '/api/we-wallpapers' || p === '/api/we-apply' || p === '/api/theme-bg' || p === '/api/mask') return true;
  return false;
}

/** 是否本插件负责的静态路径（含方法判定）。 */
function isStaticPath(req) {
  const method = req.method;
  if (method !== 'GET' && method !== 'HEAD') return false;
  const raw = String(req.url || '');
  const q = raw.indexOf('?');
  const pn = q === -1 ? raw : raw.slice(0, q);
  if (pn === '/diag') return method === 'GET';
  return STATIC_PREFIXES.some((pre) => pn.startsWith(pre));
}

/** 场景渲染器自愈部署（幂等）：createRoutes 重建时检查一次，缺失/落后即从 vendored 副本恢复。 */
let rendererEnsuredFor = '';
function ensureRenderer(weRendererDir) {
  if (!weRendererDir || rendererEnsuredFor === weRendererDir) return null;
  rendererEnsuredFor = weRendererDir;
  try {
    return core.ensureRendererDeployed(weRendererDir);
  } catch (_) {
    return null; // 部署失败不阻塞路由创建，静态服务按现状降级 404
  }
}

function createRoutes(ctx) {
  const c = ctxWithDirs(ctx);
  ensureRenderer(ctx.weRendererDir);

  function send(res, result) {
    if (!result) return;
    const { status, body } = result;
    if (typeof body === 'string') {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(body);
    }
    return ctx.json(res, status, body);
  }

  function health() {
    return {
      status: 200,
      body: {
        ok: true,
        plugin: { id: core.PLUGIN_ID, version: core.PLUGIN_VERSION },
        mounted: 'daemon',
        daemonVersion: ctx.version || null,
        dirs: { themes: c.themesDir, wallpapers: c.wallpapersDir, weRenderer: ctx.weRendererDir || null },
        renderer: ctx.weRendererDir ? core.rendererStatus(ctx.weRendererDir) : null,
      },
    };
  }

  /** daemon 的 /api/wallpaper* 等 API 入口。 */
  function handle(req, res, url, p) {
    const m = req.method;
    if (m === 'GET' && p === '/api/wallpaper/health') return send(res, health());
    if (m === 'GET' && p === '/api/wallpapers') return send(res, store.listWallpapers(c));
    if (m === 'GET' && p === '/api/custom-wallpapers') return send(res, store.listCustom(c));
    if (m === 'POST' && p === '/api/custom-wallpapers') {
      return ctx.readBody(req).then((body) => send(res, store.saveCustom(c, body && body.dataUrl)));
    }
    if (m === 'DELETE' && p === '/api/custom-wallpapers') {
      const raw = String(req.url.split('?')[1] || '');
      const name = decodeURIComponent(/name=([^&]+)/.exec(raw) ? RegExp.$1 : '');
      return send(res, store.deleteCustom(c, name));
    }
    if (m === 'GET' && p === '/api/we-wallpapers') {
      const force = /[?&]refresh=1/.test(String(req.url || ''));
      return send(res, we.listWe(force, ctx.dataDir));
    }
    if (m === 'POST' && p === '/api/we-apply') {
      return ctx.readBody(req).then((body) => we.applyWe(c, body || {})).then((r) => send(res, r));
    }
    if (m === 'POST' && p === '/api/theme-bg') {
      return ctx.readBody(req).then((body) => store.writeThemeBg(c, body || {})).then((r) => send(res, r));
    }
    // 背景蒙版（独立应用的操作栏需要；WorkDaddy daemon 自带同名接口，插件侧声明不改变其行为）
    if (m === 'GET' && p === '/api/mask') {
      return send(res, { status: 200, body: { ok: true, opacity: readMask(c.dataDir) } });
    }
    if (m === 'POST' && p === '/api/mask') {
      return ctx.readBody(req).then(async (body) => {
        const v = parseFloat(body && body.opacity);
        if (Number.isNaN(v)) return { status: 400, body: { ok: false, error: 'opacity 必须是数字' } };
        const opacity = Math.min(1, Math.max(0, v));
        try {
          fs.mkdirSync(c.dataDir, { recursive: true });
          fs.writeFileSync(path.join(c.dataDir, 'mask.json'), JSON.stringify({ opacity }, null, 2));
        } catch (e) {
          return { status: 500, body: { ok: false, error: e.message } };
        }
        // 蒙版值进了 CSS（#root 背景层），仅写文件不会生效 → 必须按 /api/theme-bg 同路径
        // 重新应用当前主题（重新注入背景 CSS）。此前漏了这步，面板「外观」页的蒙版滑条
        // 表现为「拖了没反应」（实测：POST 后页面 #root 背景仍是旧值）。
        let applied = null;
        try {
          const curFile = path.join(c.dataDir, 'current-theme.json');
          const cur = fs.existsSync(curFile) ? (JSON.parse(fs.readFileSync(curFile, 'utf8')).id || '') : '';
          if (cur) applied = await store.applyThemeId(c, cur);
        } catch (_) { /* 重应用失败不判整体失败：值已落盘，下次注入即生效 */ }
        return { status: 200, body: { ok: true, opacity, applied } };
      }).then((r) => send(res, r));
    }
    return ctx.json(res, 404, { ok: false, error: 'wallpaper: 未支持的接口 ' + m + ' ' + p });
  }

  /** daemon 的静态路由段入口：返回 true 表示已处理。 */
  function serveStatic(req, res, url) {
    try {
      const isHead = req.method === 'HEAD';
      const pn = url.pathname;

      // 壁纸静态服务：/wallpapers/<name>（图片 + 视频；面板缩略图与视频壁纸背景源）
      if (pn.startsWith('/wallpapers/')) {
        const name = path.basename(decodeURIComponent(pn.split('/').pop()));
        return media.serveMediaFile(req, res, path.join(c.wallpapersDir, name), name), true;
      }

      // 主题媒体静态服务：/theme-media/<id>/<name>（视频背景源；图片背景仍走内联 dataURL）
      if (pn.startsWith('/theme-media/')) {
        const segs = decodeURIComponent(pn).split('/').filter(Boolean);
        const id = String(segs[1] || '').replace(/[^A-Za-z0-9_-]/g, '_');
        const name = path.basename(segs[2] || '');
        return media.serveMediaFile(req, res, path.join(c.themesDir, id, name), name), true;
      }

      // 渲染器诊断信标：/diag?msg=...（WebWallGL 渲染进度/失败落 daemon.log，前缀 [we-diag]）
      if (pn === '/diag') {
        try {
          const msg = url.searchParams.get('msg') || '';
          if (msg && ctx.log) ctx.log('[we-diag] ' + String(msg).slice(0, 500));
        } catch (_) { /* noop */ }
        res.writeHead(204);
        return res.end(), true;
      }

      // WebWallGL 场景渲染页：/wallpaper-engine/scene-live/*（vendored 渲染器）
      // 注意：渲染器 index.html 内以绝对路径引用 /wallpaper-engine/scene-live/assets/...，此 base 不可改。
      if (pn.startsWith('/wallpaper-engine/scene-live/')) {
        const base = ctx.weRendererDir;
        if (!base) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end(isHead ? undefined : 'not found'), true; }
        const rest = decodeURIComponent(pn.slice('/wallpaper-engine/scene-live/'.length));
        const safe = rest.split('/').filter((s) => s && s !== '.' && s !== '..').join('/');
        const file = path.join(base, safe || 'index.html');
        if (!path.resolve(file).startsWith(path.resolve(base))) {
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end(isHead ? undefined : 'forbidden'), true;
        }
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end(isHead ? undefined : 'not found'), true;
        }
        const isHtml = /\.html?$/i.test(file);
        const isHashed = /-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/i.test(file);
        const mime = media.MEDIA_MIME[path.extname(file).toLowerCase()] || (isHtml ? 'text/html; charset=utf-8' : 'application/octet-stream');
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': isHtml ? 'no-store' : (isHashed ? 'public, max-age=31536000, immutable' : 'no-cache') });
        return res.end(isHead ? undefined : fs.readFileSync(file)), true;
      }

      // 场景载荷：/wallpaper-engine/scene-files/<workshopId>/<file> —— 从 Steam 创意工坊目录直读
      if (pn.startsWith('/wallpaper-engine/scene-files/')) {
        const segs = decodeURIComponent(pn).split('/').filter(Boolean);
        // URL 形如 /wallpaper-engine/scene-files/<workshopId>/<file>：前两段是路由前缀
        const weId = String(segs[2] || '').replace(/[^0-9]/g, '');
        const rel = segs.slice(3).filter((s) => s && s !== '.' && s !== '..').join('/');
        if (!weId || !rel) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          if (ctx.log) ctx.log('[we-files] 404 (缺参) ' + req.method + ' ' + String(req.url).slice(0, 200));
          return res.end(isHead ? undefined : 'not found'), true;
        }
        let base = null;
        for (const root of we.weWorkshopRoots()) {
          const d = path.join(root, weId);
          if (fs.existsSync(d) && fs.statSync(d).isDirectory()) { base = d; break; }
        }
        if (!base) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          if (ctx.log) ctx.log('[we-files] 404 (无此工坊) ' + req.method + ' ' + weId + '/' + rel);
          return res.end(isHead ? undefined : 'not found'), true;
        }
        const file = path.join(base, rel);
        if (!path.resolve(file).startsWith(path.resolve(base))) {
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
          if (ctx.log) ctx.log('[we-files] 403 ' + req.method + ' ' + weId + '/' + rel);
          return res.end(isHead ? undefined : 'forbidden'), true;
        }
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          if (ctx.log) ctx.log('[we-files] 404 (无此文件) ' + req.method + ' ' + weId + '/' + rel);
          return res.end(isHead ? undefined : 'not found'), true;
        }
        const mime = media.MEDIA_MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
        // 可重验证缓存：ETag(size+mtime) 命中即 304，大 scene.pkg 重复拉取省带宽
        const st = fs.statSync(file);
        const etag = '"' + st.size + '-' + Math.round(st.mtimeMs) + '"';
        if (req.headers['if-none-match'] === etag) {
          if (ctx.log) ctx.log('[we-files] 304 ' + req.method + ' ' + weId + '/' + rel);
          res.writeHead(304, { ETag: etag });
          return res.end(), true;
        }
        if (ctx.log) ctx.log('[we-files] 200 ' + req.method + ' ' + weId + '/' + rel + ' (' + st.size + 'B)');
        res.writeHead(200, {
          'Content-Type': mime,
          'Content-Length': st.size,
          ETag: etag,
          'Cache-Control': /\.html?$/i.test(file) ? 'no-store' : 'no-cache',
          'Access-Control-Allow-Origin': '*',
        });
        return res.end(isHead ? undefined : fs.readFileSync(file)), true;
      }

      return false;
    } catch (e) {
      if (!res.writableEnded) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('error: ' + e.message);
      }
      return true;
    }
  }

  return {
    ROUTES,
    STATIC_PREFIXES,
    isApiPath,
    isStaticPath,
    handle,
    serveStatic,
    health,
    dirs: () => dirs(ctx),
  };
}

module.exports = { createRoutes, ROUTES, STATIC_PREFIXES, isApiPath, isStaticPath };
