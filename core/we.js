'use strict';
/**
 * wallpaper · Wallpaper Engine 库扫描与应用
 * ------------------------------------------------------------------
 * 扫描 Steam 创意工坊 431960（Wallpaper Engine 的 AppID）下的 video / scene 壁纸。
 * 不复制进壁纸库；应用时直接从源路径复制到 themes/<id>/background.<ext>（因此不受 80MB 上传上限约束）。
 */

const fs = require('fs');
const path = require('path');

const store = require('./store.js');

const WE_APPID = '431960';
let weScanCache = { at: 0, items: [], roots: [] };
// R4：扫描结果落盘缓存——daemon 重启后首开壁纸页不再全目录重扫。
// 两级缓存：内存 60s（进程内热路径）→ 磁盘 6h（跨重启）；force 恒强扫并回写。
const WE_DISK_CACHE_TTL = 6 * 60 * 60 * 1000;
let weDiskCacheLoaded = false;

function weCacheFile(dataDir) {
  return path.join(dataDir || '.', 'we-cache.json');
}

function loadDiskCache(dataDir) {
  if (weDiskCacheLoaded || !dataDir) return weScanCache;
  weDiskCacheLoaded = true;
  try {
    const j = JSON.parse(fs.readFileSync(weCacheFile(dataDir), 'utf8'));
    if (j && j.at && Array.isArray(j.items) && Array.isArray(j.roots)) {
      weScanCache = { at: j.at, items: j.items, roots: j.roots };
    }
  } catch (_) { /* 无缓存/损坏 → 全扫 */ }
  return weScanCache;
}

function saveDiskCache(dataDir, cache) {
  if (!dataDir) return;
  try {
    const file = weCacheFile(dataDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cache));
  } catch (_) { /* 缓存写失败不影响主流程 */ }
}

/** Steam 安装根目录候选。 */
function weSteamBaseCandidates() {
  const bases = [];
  const drives = ['C', 'D', 'E', 'F', 'G'];
  const rels = [
    ['Steam'], ['steam'], ['SteamLibrary'], ['SteamLibrary', 'Steam'],
    ['Program Files (x86)', 'Steam'], ['Program Files', 'Steam'], ['Games', 'Steam'],
  ];
  for (const dl of drives) for (const r of rels) bases.push(path.join(dl + ':', ...r));
  return bases;
}

/** 创意工坊 431960 根目录（含 libraryfolders.vdf 里的其它库）。 */
function weWorkshopRoots() {
  const seen = new Set();
  const roots = [];
  // Windows 路径大小写不敏感：D:\Steam 与 D:\steam 实为同一目录，按小写规范化去重
  const addRoot = (p) => {
    try {
      if (!p || !fs.existsSync(p)) return;
      const key = String(p).replace(/[\\/]+$/, '').toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      roots.push(p);
    } catch (_) { /* noop */ }
  };
  for (const base of weSteamBaseCandidates()) {
    const steamapps = path.join(base, 'steamapps');
    if (!fs.existsSync(steamapps)) continue;
    addRoot(path.join(steamapps, 'workshop', 'content', WE_APPID));
    const vdf = path.join(steamapps, 'libraryfolders.vdf');
    try {
      if (fs.existsSync(vdf)) {
        const txt = fs.readFileSync(vdf, 'utf8');
        const re = /"path"\s*"([^"]+)"/g;
        let m;
        while ((m = re.exec(txt))) {
          const lib = m[1].replace(/\\\\/g, '\\');
          addRoot(path.join(lib, 'steamapps', 'workshop', 'content', WE_APPID));
        }
      }
    } catch (_) { /* noop */ }
  }
  return roots;
}

/** 解析一个工坊目录的壁纸载荷（video / scene）。返回 null 表示不是受支持的壁纸。 */
function readWorkshopItem(dir) {
  let pj = null;
  try { pj = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')); } catch (_) { return null; }
  if (!pj) return null;
  const type = String(pj.type).toLowerCase();
  if (type !== 'video' && type !== 'scene') return null;
  // 场景类：优先 scene.pkg（打包形态，自包含可直读）；project.json 的 file 指向松散 scene.json 亦可
  let file = path.basename(String(pj.file || ''));
  if (type === 'scene') {
    const pkg = path.join(dir, 'scene.pkg');
    if (fs.existsSync(pkg) && fs.statSync(pkg).isFile()) { file = 'scene.pkg'; }
    else if (!file || !fs.existsSync(path.join(dir, file))) return null;
  }
  if (!file) return null;
  const vf = path.join(dir, file);
  let size = 0;
  try { const st = fs.statSync(vf); if (!st.isFile()) return null; size = st.size; } catch (_) { return null; }
  // 预览图（面板缩略图用）：preview.gif/jpg/png
  let preview = '';
  for (const pv of ['preview.gif', 'preview.jpg', 'preview.png']) {
    if (fs.existsSync(path.join(dir, pv))) { preview = pv; break; }
  }
  return { path: vf, ext: path.extname(vf).toLowerCase(), title: String(pj.title || ''), type, dir, pj, size, preview, file };
}

/** 扫描全部工坊根目录（内存 60s + 磁盘 6h 两级缓存；force 强制重扫并回写）。 */
function weScanVideos(force, dataDir) {
  const now = Date.now();
  if (!force && weScanCache.at && now - weScanCache.at < 60 * 1000) return weScanCache;
  // 磁盘缓存（跨重启）：TTL 内直接命中，省去全目录扫描
  if (!force) {
    const disk = loadDiskCache(dataDir);
    if (disk.at && now - disk.at < WE_DISK_CACHE_TTL) return disk;
  }
  const roots = weWorkshopRoots();
  const items = [];
  for (const root of roots) {
    let ids = [];
    try { ids = fs.readdirSync(root).filter((x) => /^\d+$/.test(x)); } catch (_) { continue; }
    for (const id of ids) {
      const it = readWorkshopItem(path.join(root, id));
      if (!it) continue;
      items.push({ id, title: it.title || ('Wallpaper Engine ' + id), size: it.size, ext: it.ext, type: it.type, preview: it.preview });
    }
  }
  items.sort((a, b) => String(a.title).localeCompare(String(b.title), 'zh'));
  weScanCache = { at: now, items, roots };
  saveDiskCache(dataDir, weScanCache);
  return weScanCache;
}

/** 按工坊 id 精确查找（不依赖缓存）。 */
function weFindVideoById(id) {
  const want = String(id).replace(/[^0-9]/g, '');
  if (!want) return null;
  for (const root of weWorkshopRoots()) {
    const it = readWorkshopItem(path.join(root, want));
    if (it) return { path: it.path, ext: it.ext, title: it.title || want, type: it.type, dir: it.dir };
  }
  return null;
}

/**
 * 应用 Wallpaper Engine 壁纸：POST /api/we-apply { id: 主题id, weId: 工坊id }
 * 直接从源路径复制到 themes/<id>/background.<ext> 并应用主题。
 */
async function applyWe(ctx, body) {
  try {
    const id = String(body.id || '').replace(/[^A-Za-z0-9_-]/g, '_');
    if (!id) return { status: 400, body: { ok: false, error: '缺少 id' } };
    const weId = String(body.weId || '').replace(/[^0-9]/g, '');
    if (!weId) return { status: 400, body: { ok: false, error: '缺少 weId' } };
    const found = weFindVideoById(weId);
    if (!found) return { status: 404, body: { ok: false, error: '未找到该 Wallpaper Engine 壁纸（或类型不支持）' } };
    const isScene = found.type === 'scene';
    if (isScene && path.extname(found.path).toLowerCase() !== '.pkg') {
      return { status: 400, body: { ok: false, error: '松散形态场景暂不支持，仅支持 scene.pkg 打包形态' } };
    }
    const ext = (found.ext || '.mp4').replace(/^\./, '');
    const dir = store.themeDir(ctx, id);
    fs.mkdirSync(dir, { recursive: true });
    const bgFileName = 'background.' + ext;
    store.cleanupOldBackgrounds(dir, bgFileName);
    fs.copyFileSync(found.path, path.join(dir, bgFileName));
    // 场景渲染选项（可配置化，对标 dsh-wallpaper-engine 的「旋钮」纪律）：
    // 不传 = 与历史行为逐字节一致（sceneFps 30 / muted true / fit cover）；传了则校验后落盘。
    let weOptions;
    if (isScene && (body.sceneFps !== undefined || body.muted !== undefined || body.fit !== undefined)) {
      const fpsRaw = Number(body.sceneFps);
      const sceneFps = Number.isFinite(fpsRaw) ? Math.min(120, Math.max(1, Math.round(fpsRaw))) : 30;
      const fitRaw = String(body.fit || 'cover').toLowerCase();
      const fit = ['cover', 'contain', 'fill'].indexOf(fitRaw) >= 0 ? fitRaw : 'cover';
      weOptions = { sceneFps, muted: body.muted === undefined ? true : !!body.muted, fit };
    }
    // weTitle 一并落盘：面板「关于 → 当前壁纸」与卡片选中态要能显示名字，否则只能显示 —
    store.patchThemeJson(ctx, id, { image: bgFileName, bgVideo: !isScene, bgScene: isScene, weId, weTitle: found.title, weOptions: weOptions || null });
    store.writeCurrentTheme(ctx, id);
    if (ctx.log) ctx.log('应用 Wallpaper Engine ' + (isScene ? '场景' : '视频') + '壁纸 -> ' + id + '/' + bgFileName + ' (weId=' + weId + (weOptions ? ', options=' + JSON.stringify(weOptions) : '') + ')');
    if (!ctx.applyTheme) {
      return { status: 200, body: { ok: true, image: bgFileName, applied: false, pending: true, id, title: found.title, warn: '已保存，连接恢复后自动应用' } };
    }
    try {
      const info = await ctx.applyTheme(id);
      return { status: 200, body: { ok: true, image: bgFileName, applied: !!(info && info.ok), id, title: found.title } };
    } catch (_) {
      return { status: 200, body: { ok: true, image: bgFileName, applied: false, pending: true, id, title: found.title, warn: '已保存，连接恢复后自动应用' } };
    }
  } catch (e) {
    return { status: 500, body: { ok: false, error: e.message } };
  }
}

/**
 * 读取场景可调属性（P0-2.3 场景属性可视化调节）：解析工坊目录 project.json 的 general.properties。
 * 返回规范化属性表 [{ key, text, type: bool|slider|color|combo, value, min, max, options }]，
 * 供面板动态生成控件。只读，不改动源文件；无属性 / 非场景 → 返回空表。
 *
 * WE 属性契约（Wallpaper Engine 官方 general.properties）：
 *   bool   → value 为 boolean
 *   slider → value 为 number，min/max 定范围（可缺省，缺省按 value±1 兜底）
 *   color  → value 为 "r g b" 空格分隔的 0-1 浮点串（官方 UI 用）
 *   combo  → options 为字符串数组，value 为序号（0-based）
 * 缺省 value 的 slider 是合法形态（如 text 含"时间"类），兜底给 min=0/max=1/value=0.5。
 */
function readSceneProperties(weId) {
  const want = String(weId).replace(/[^0-9]/g, '');
  if (!want) return [];
  const found = weFindVideoById(want);
  if (!found || found.type !== 'scene' || !found.dir) return [];
  let pj = null;
  try { pj = JSON.parse(fs.readFileSync(path.join(found.dir, 'project.json'), 'utf8')); } catch (_) { return []; }
  const src = pj && pj.general && pj.general.properties;
  if (!src || typeof src !== 'object') return [];
  const out = [];
  for (const key of Object.keys(src)) {
    const p = src[key];
    if (!p || typeof p !== 'object') continue;
    const type = String(p.type || '').toLowerCase();
    const item = {
      key,
      text: (typeof p.text === 'string' && p.text) ? p.text : key,
      type: ['bool', 'slider', 'color', 'combo'].indexOf(type) >= 0 ? type : (typeof p.value === 'boolean' ? 'bool' : typeof p.value === 'number' ? 'slider' : 'text'),
      value: p.value,
      order: Number.isFinite(Number(p.order)) ? Number(p.order) : Number(p.index) || 0,
    };
    if (item.type === 'slider') {
      const v = Number.isFinite(Number(p.value)) ? Number(p.value) : 0.5;
      item.min = Number.isFinite(Number(p.min)) ? Number(p.min) : Math.min(v, v - 1);
      item.max = Number.isFinite(Number(p.max)) ? Number(p.max) : Math.max(v, v + 1);
      item.value = Math.min(item.max, Math.max(item.min, v));
    } else if (item.type === 'combo') {
      item.options = Array.isArray(p.options) ? p.options.map(String) : [];
    } else if (item.type === 'color') {
      // 保持官方 "r g b" 串形态，页面侧解析；缺省给灰色
      if (typeof p.value !== 'string' || !/^[\d. ]+$/.test(String(p.value).trim())) item.value = '0.5 0.5 0.5';
    }
    out.push(item);
  }
  out.sort((a, b) => a.order - b.order);
  return out;
}

/**
 * 应用场景属性（P0-2.3）：把面板改动落盘到主题 theme.json 的 weUserProperties，
 * 并透传给当前注入表达式（页面侧经 wallpaperPropertyListener.applyUserProperties 写回）。
 * 纯落盘 + 委托 ctx.applyTheme 重注入；真正渲染在页面侧。
 */
async function applySceneProperties(ctx, body) {
  try {
    const id = String(body.id || '').replace(/[^A-Za-z0-9_-]/g, '_');
    if (!id) return { status: 400, body: { ok: false, error: '缺少 id' } };
    const props = body.properties;
    if (props === undefined || typeof props !== 'object') return { status: 400, body: { ok: false, error: '缺少 properties' } };
    // 白名单收敛：只接受 { key: value } 标量，杜绝注入任意结构
    const clean = {};
    for (const k of Object.keys(props)) {
      const v = props[k];
      if (typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') clean[k] = v;
    }
    store.patchThemeJson(ctx, id, { weUserProperties: clean });
    if (!ctx.applyTheme) {
      return { status: 200, body: { ok: true, applied: false, pending: true, id, properties: clean, warn: '已保存，连接恢复后自动应用' } };
    }
    try {
      const info = await ctx.applyTheme(id);
      return { status: 200, body: { ok: true, applied: !!(info && info.ok), id, properties: clean } };
    } catch (_) {
      return { status: 200, body: { ok: true, applied: false, pending: true, id, properties: clean, warn: '已保存，连接恢复后自动应用' } };
    }
  } catch (e) {
    return { status: 500, body: { ok: false, error: e.message } };
  }
}

/** 供 /api/we-wallpapers 输出的精简列表。 */
function listWe(force, dataDir) {
  try {
    const r = weScanVideos(force, dataDir);
    return {
      status: 200,
      body: {
        ok: true,
        roots: r.roots,
        items: r.items.map((it) => ({ id: it.id, title: it.title, size: it.size, ext: it.ext, type: it.type || 'video', preview: it.preview || '' })),
      },
    };
  } catch (e) {
    return { status: 500, body: { ok: false, error: e.message } };
  }
}

module.exports = { WE_APPID, weSteamBaseCandidates, weWorkshopRoots, readWorkshopItem, weScanVideos, weFindVideoById, listWe, applyWe, readSceneProperties, applySceneProperties };
