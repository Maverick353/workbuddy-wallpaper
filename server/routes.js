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
const crypto = require('crypto');

const core = require('../core/index.js');
const media = core.media;
const store = core.store;
const we = core.we;
const { readMask } = require('../core/theme-css.js'); // 蒙版与 theme-css 单一源
const fonts = require('../core/fonts.js');            // 本机字体枚举（字体页的可搜索列表）
const update = require('../core/update.js');          // 版本检测与更新推送（零依赖）

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
  ['GET', '/api/fonts'],
  ['GET', '/api/update'],
  ['POST', '/api/update/check'],
  ['POST', '/api/update/apply'],
  ['POST', '/api/update/rollback'],
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
  if (p === '/api/wallpapers' || p === '/api/custom-wallpapers' || p === '/api/we-wallpapers' || p === '/api/we-apply' || p === '/api/theme-bg' || p === '/api/mask' || p === '/api/fonts') return true;
  if (p === '/api/update' || p === '/api/update/check' || p === '/api/update/apply' || p === '/api/update/rollback') return true;
  return false;
}

// ── 更新机制的编排（业务在 core/update.js，这里只做「拼装 + 决定何时重启」）────
const PKG_ROOT = path.resolve(__dirname, '..');

/**
 * 当前安装的版本号。
 * ⚠️ **不能直接用 `ctx.version`**：standalone 传进来的 `version` 是插件命名空间（值就是
 *    `"standalone"`），不是 semver。拿它去比版本 → `parseVersion` 失败 → 恒判「有更新」，
 *    每个用户都会看到一个永远升不完的新版本（实测抓到）。
 * 所以：**以 `package.json` 为准**（它就是这份已安装代码的版本），`ctx.version` 只在
 * 拿不到文件、且它本身是合法 semver 时才兜底。
 */
function currentVersion(ctx) {
  try {
    const v = String(JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version || '');
    if (update.parseVersion(v)) return v;
  } catch (_) {}
  const cv = ctx && ctx.version ? String(ctx.version) : '';
  return update.parseVersion(cv) ? cv : '0.0.0';
}

/** 面包屑：一份「面板直接可渲染」的状态快照（不发网络）。 */
function updateStatus(ctx) {
  const dataDir = ctx.dataDir;
  const cfg = update.loadConfig({ dataDir });
  const cache = update.readCache(dataDir);
  const r = cache.result || null;
  // ⚠️ 顺序很重要：**缓存结果先铺底，实时字段后覆盖**。
  // 踩过（2026-10-21 真机自更新后才暴露）：原来是反过来的 —— 缓存里的 `currentVersion`
  // 会盖掉磁盘上的实时版本。于是「更新成功 → 重启 → 面板仍显示有新版本」，
  // 而且 `hasUpdate` 永远是检查那一刻算出来的旧值，用户看到的是一个升不完的新版本。
  const cur = currentVersion(ctx);
  const st = Object.assign({}, r || {}, {
    ok: true,
    currentVersion: cur,
    checked: !!r,
    feeds: cfg.feeds,
    channel: cfg.channel,
    disabled: !!cfg.disabled,
    startupDelaySeconds: cfg.startupDelaySeconds,
    checkIntervalHours: cfg.checkIntervalHours,
    keepBackups: cfg.keepBackups,
    backups: update.listBackups(dataDir).map((b) => ({ version: b.version, at: new Date(b.at).toISOString() })),
  });

  // 缓存的 hasUpdate/mustUpdate/canUpdate 是「检查当时基于旧版本」算出来的；
  // 版本变了（更新成功、或手动回滚）必须用实时版本重算，否则结论就是错的。
  if (r && r.latest && update.parseVersion(String(r.latest))) {
    st.hasUpdate = update.isNewer(cur, String(r.latest));
    st.mustUpdate = r.minSupported ? update.compareVersions(cur, String(r.minSupported)) < 0 : false;
    st.canUpdate = !!(r.zip && r.zip.url) && update.compareVersions(cur, String(r.latest)) < 0;
  }
  st.lastCheckAt = cache.lastCheckAt || (r && r.lastCheckAt) || 0;
  return st;
}

/** 更新前后比较 `scripts/companion.js` 是否变了 —— 变了要提示用户「看门狗需重启」。 */
function companionHash() {
  try { return crypto.createHash('sha256').update(fs.readFileSync(path.join(PKG_ROOT, 'scripts', 'companion.js'))).digest('hex'); }
  catch (_) { return null; }
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
    // 本机字体列表（字体页的「搜得到」来源）。带磁盘缓存，?refresh=1 强制重扫。
    if (m === 'GET' && p === '/api/fonts') {
      const refresh = /[?&]refresh=1/.test(String(req.url || ''));
      return send(res, { status: 200, body: Object.assign({ ok: true }, fonts.listFonts(c.dataDir, { refresh, log: ctx.log })) });
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
    // ── 更新机制 ────────────────────────────────────────────────────────────
    if (m === 'GET' && p === '/api/update') {
      // 只读缓存，不发网络 —— 面板打开时渲染用它，绝不会卡住 UI
      return send(res, { status: 200, body: updateStatus(c) });
    }
    if (m === 'POST' && p === '/api/update/check') {
      return ctx.readBody(req).then(async (body) => {
        const r = await update.checkForUpdate({
          dataDir: c.dataDir, currentVersion: currentVersion(c), force: !!(body && body.force),
        });
        return { status: 200, body: Object.assign(updateStatus(c), r) };
      }).then((r) => send(res, r));
    }
    if (m === 'POST' && p === '/api/update/apply') {
      return ctx.readBody(req).then(async (body) => {
        const b = body || {};
        if (update.loadConfig({ dataDir: c.dataDir }).disabled) {
          return { status: 400, body: { ok: false, error: '更新已关闭（WBWP_UPDATE_OFF=1）' } };
        }
        const before = companionHash();
        // 应用前**强制**再检查一次：面板上看到的版本可能已经过期（别人抢先发了新版）
        const st = await update.checkForUpdate({ dataDir: c.dataDir, currentVersion: currentVersion(c), force: true });
        if (st.disabled) return { status: 400, body: { ok: false, error: st.error || '更新已关闭' } };
        if (!st.ok) return { status: 502, body: { ok: false, error: '检查更新失败：' + (st.error || '未知原因') } };
        if (!st.hasUpdate) return { status: 409, body: { ok: false, error: '已是最新版本（' + st.currentVersion + '）' } };
        if (!st.canUpdate) return { status: 409, body: { ok: false, error: 'feed 没有可用的更新包地址' } };
        if (b.expectVersion && String(b.expectVersion) !== String(st.latest)) {
          return { status: 409, body: { ok: false, error: '版本已变化：你看到的是 ' + b.expectVersion + '，实际已到 ' + st.latest + '。请重新检查。' } };
        }
        if (st.minSupported && update.compareVersions(st.latest, st.minSupported) < 0) {
          return { status: 500, body: { ok: false, error: 'feed 自相矛盾：latest(' + st.latest + ') 低于 minSupported(' + st.minSupported + ')' } };
        }
        let out;
        try {
          out = await update.applyUpdate({
            dataDir: c.dataDir, version: st.latest, zip: st.zip, targetDir: PKG_ROOT,
          });
        } catch (e) {
          return { status: 500, body: { ok: false, error: '更新失败：' + ((e && e.message) || e) } };
        }
        const watchdogChanged = before !== companionHash();
        const restart = b.restart === false ? 'none' : update.scheduleRestart({ dataDir: c.dataDir, pkgRoot: PKG_ROOT });
        return { status: 200, body: Object.assign(out, { ok: true, restart, watchdogChanged, notes: st.notes }) };
      }).then((r) => send(res, r));
    }
    if (m === 'POST' && p === '/api/update/rollback') {
      return ctx.readBody(req).then(async (body) => {
        const b = body || {};
        // 降级护栏：不允许回滚到低于 feed 声明的 minSupported —— 那比留在当前版本更糟
        // （minSupported 代表「低于它接口契约就不兼容了」）。
        const cached = update.readCache(c.dataDir).result;
        if (b.version && cached && cached.minSupported && update.compareVersions(String(b.version), cached.minSupported) < 0) {
          return { status: 400, body: { ok: false, error: '不能回滚到 ' + b.version + '：低于最低支持版本 ' + cached.minSupported } };
        }
        const before = companionHash();
        let out;
        try {
          out = await update.rollbackTo({ dataDir: c.dataDir, targetDir: PKG_ROOT, version: b.version });
        } catch (e) {
          return { status: 500, body: { ok: false, error: '回滚失败：' + ((e && e.message) || e) } };
        }
        const watchdogChanged = before !== companionHash();
        const restart = b.restart === false ? 'none' : update.scheduleRestart({ dataDir: c.dataDir, pkgRoot: PKG_ROOT });
        return { status: 200, body: Object.assign(out, { ok: true, restart, watchdogChanged }) };
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
