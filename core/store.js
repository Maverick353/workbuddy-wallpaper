'use strict';
/**
 * wallpaper · 壁纸库与主题背景存储
 * ------------------------------------------------------------------
 * 负责 themes/ 与 themes/wallpapers/ 下的文件读写：官方/自定义壁纸列表、
 * 自定义壁纸上传/删除、主题背景替换（/api/theme-bg 的全部逻辑）。
 *
 * HTTP 无关：所有函数返回 { status, body }，由 server/routes.js 负责 json() 输出。
 * 唯一的外部依赖是 ctx.applyTheme（daemon 的 applyThemeByCdp），以回调注入。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const media = require('./media.js');
const pauseState = require('./pause.js');

/** 解析工作目录（允许 ctx 覆盖，默认与 daemon 的 THEMES_DIR / WALLPAPERS_DIR 完全一致）。 */
function dirsFor(ctx) {
  const dataDir = ctx.dataDir;
  const themesDir = ctx.themesDir || path.join(dataDir, 'themes');
  const wallpapersDir = ctx.wallpapersDir || path.join(themesDir, 'wallpapers');
  return { dataDir, themesDir, wallpapersDir };
}

/** 读取主题定义（themes/<id>/theme.json）；不存在/损坏返回 null。独立宿主可直接用。 */
function readThemeJson(ctx, id) {
  try {
    const safe = String(id || '').replace(/[^A-Za-z0-9_-]/g, '_');
    const file = path.join(themeDir(ctx, safe), 'theme.json');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) { return null; }
}
function themeDir(ctx, id) {
  return path.join(dirsFor(ctx).themesDir, String(id).replace(/[^A-Za-z0-9_-]/g, '_'));
}

function writeCurrentTheme(ctx, id) {
  try {
    fs.writeFileSync(path.join(dirsFor(ctx).dataDir, 'current-theme.json'), JSON.stringify({ id, at: new Date().toISOString() }, null, 2));
  } catch (_) { /* noop */ }
}

/** 就地编辑 themes/<id>/theme.json（文件不存在则跳过）。fn 可做新增/删除字段。 */
function updateThemeJson(ctx, id, fn) {
  const dir = themeDir(ctx, id);
  const tf = path.join(dir, 'theme.json');
  try {
    // 文件缺失 → 以 {} 起步并创建（独立宿主首用场景：没有主题系统预建 theme.json）；
    // 文件存在但损坏 → 与旧行为一致，安静跳过（不覆盖用户数据）。
    const t = fs.existsSync(tf) ? JSON.parse(fs.readFileSync(tf, 'utf8')) : {};
    fn(t);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tf, JSON.stringify(t, null, 2));
  } catch (_) { /* noop */ }
}

/** 更新 themes/<id>/theme.json 的若干字段（缺失则创建）。 */
function patchThemeJson(ctx, id, patch) {
  updateThemeJson(ctx, id, (t) => Object.assign(t, patch));
}

/** 清掉主题目录下其它扩展名的旧背景，避免残留干扰（保留 keepFileName）。 */
function cleanupOldBackgrounds(dir, keepFileName) {
  try {
    for (const f of fs.readdirSync(dir)) {
      if (media.BACKGROUND_NAME_RE.test(f) && f !== keepFileName) fs.unlinkSync(path.join(dir, f));
    }
  } catch (_) { /* noop */ }
}

/** 官方 + 自定义壁纸列表，附带当前壁纸（按当前主题 background.webp 内容哈希匹配）。 */
function listWallpapers(ctx) {
  try {
    const { wallpapersDir, themesDir, dataDir } = dirsFor(ctx);
    const files = fs.existsSync(wallpapersDir)
      ? fs.readdirSync(wallpapersDir).filter((f) => media.WALLPAPER_EXTS_RE.test(f)).sort()
      : [];
    const official = files.filter((f) => !/^custom-/i.test(f));
    const custom = files.filter((f) => /^custom-/i.test(f));
    let currentWallpaper = null;
    let currentTheme = null;
    try {
      const cur = JSON.parse(fs.readFileSync(path.join(dataDir, 'current-theme.json'), 'utf8')).id || '';
      currentTheme = readThemeJson(ctx, cur);
      const bg = path.join(themesDir, String(cur).replace(/[^A-Za-z0-9_-]/g, '_'), 'background.webp');
      if (fs.existsSync(bg)) {
        const want = crypto.createHash('md5').update(fs.readFileSync(bg)).digest('hex');
        for (const f of files) {
          const p2 = path.join(wallpapersDir, f);
          if (crypto.createHash('md5').update(fs.readFileSync(p2)).digest('hex') === want) { currentWallpaper = f; break; }
        }
      }
    } catch (_) { /* noop */ }
    const titleOf = (f) => String(f).replace(/\.[a-z0-9]+$/i, '').replace(/^(wallpaper-?0*|custom-)/, '');
    // weId / weTitle：WE 场景与视频用的是 background.mp4|.pkg，没有 background.webp 可比对，
    // 只能从主题 json 取 —— 缺这两个字段时面板无法标出「使用中」，且「当前壁纸」只能显示 —。
    const currentTitle = (currentTheme && currentTheme.weTitle)
      || (currentWallpaper ? (official.includes(currentWallpaper) ? '官方壁纸 ' + titleOf(currentWallpaper) : '自定义壁纸 ' + titleOf(currentWallpaper)) : null);
    return {
      status: 200,
      body: {
        ok: true,
        wallpapers: official.map((f) => ({ name: f, type: media.isVideoName(f) ? 'video' : 'image', title: '官方壁纸 ' + String(f.replace(/\.[a-z0-9]+$/i, '')).replace(/^wallpaper-?0*/, '') })),
        customWallpapers: custom.map((f) => ({ name: f, type: media.isVideoName(f) ? 'video' : 'image', title: '自定义壁纸 ' + String(f.replace(/\.[a-z0-9]+$/i, '')).replace(/^custom-/, '') })),
        currentWallpaper,
        weId: (currentTheme && currentTheme.weId) || null,
        currentTitle,
        // 暂停壁纸（可逆）与退出插件（.stopped，不可逆）是两个状态。
        // 面板要在打开时就知道"现在是暂停中"，否则按钮会显示成"暂停壁纸"却点不动。
        paused: pauseState.readPaused(dataDir).paused,
        // 动态效果能力（P0-2.3）：当前主题是否支持昼夜循环（frames≥2 帧）/ 鼠标视差（parallax）。
        // 面板据此显示开关并置灰不支持项，避免用户开了开关却没效果。
        fx: {
          daynight: !!(currentTheme && Array.isArray(currentTheme.frames) && currentTheme.frames.length >= 2),
          parallax: !!(currentTheme && currentTheme.parallax && currentTheme.parallax.enabled !== false),
        },
      },
    };
  } catch (e) {
    return { status: 500, body: { ok: false, error: e.message } };
  }
}

/** 自定义壁纸列表（冗余接口，主要随 /api/wallpapers 返回）。 */
function listCustom(ctx) {
  try {
    const { wallpapersDir } = dirsFor(ctx);
    const files = fs.existsSync(wallpapersDir)
      ? fs.readdirSync(wallpapersDir).filter((f) => media.CUSTOM_NAME_RE.test(f)).sort()
      : [];
    return {
      status: 200,
      body: { ok: true, wallpapers: files.map((f) => ({ name: f, type: media.isVideoName(f) ? 'video' : 'image', title: '自定义壁纸 ' + String(f.replace(/\.[a-z0-9]+$/i, '')).replace(/^custom-/, '') })) },
    };
  } catch (e) {
    return { status: 500, body: { ok: false, error: e.message } };
  }
}

/** 上传自定义壁纸（body.dataUrl base64）。视频原样存（≤80MB），图片 ≤10MB。 */
function saveCustom(ctx, dataUrl) {
  try {
    const parsed = media.parseDataUrl(dataUrl);
    if (!parsed) return { status: 400, body: { ok: false, error: '仅支持 PNG/JPEG/WebP/GIF 图片或 WebM/MP4 视频' } };
    const { buf, isVideo, ext } = parsed;
    const limit = isVideo ? media.VIDEO_MAX_BYTES : media.IMAGE_MAX_BYTES;
    if (buf.length > limit) return { status: 400, body: { ok: false, error: isVideo ? '视频不能超过 80MB' : '图片不能超过 10MB' } };
    const { wallpapersDir } = dirsFor(ctx);
    fs.mkdirSync(wallpapersDir, { recursive: true });
    const name = 'custom-' + Date.now().toString(36) + '.' + ext;
    fs.writeFileSync(path.join(wallpapersDir, name), buf);
    if (ctx.log) ctx.log(`上传自定义壁纸 -> ${name} (${buf.length}B, ${isVideo ? '视频' : '图片'})`);
    return { status: 200, body: { ok: true, name, type: isVideo ? 'video' : 'image' } };
  } catch (e) {
    return { status: 500, body: { ok: false, error: e.message } };
  }
}

/** 删除自定义壁纸（仅 custom- 前缀，防误删官方壁纸）。 */
function deleteCustom(ctx, name) {
  try {
    if (!media.CUSTOM_NAME_RE.test(String(name || ''))) return { status: 400, body: { ok: false, error: '仅支持删除自定义壁纸（custom-*）' } };
    const { wallpapersDir } = dirsFor(ctx);
    const file = path.join(wallpapersDir, name);
    if (!fs.existsSync(file)) return { status: 404, body: { ok: false, error: '壁纸不存在: ' + name } };
    fs.unlinkSync(file);
    if (ctx.log) ctx.log('删除自定义壁纸 -> ' + name);
    return { status: 200, body: { ok: true, name } };
  } catch (e) {
    return { status: 500, body: { ok: false, error: e.message } };
  }
}

/**
 * 替换主题背景（/api/theme-bg）。三种来源：body.dataUrl / body.wallpaper（官方图库文件名）/ body.custom（自定义壁纸名）。
 * 保持主题配色不变，只换 background.<ext> 并更新 theme.json.image，随后应用主题。
 * CDP 未连接时应用失败不判为整体失败：文件与 current-theme.json 已落盘，连接恢复后自动应用。
 */
function saveBackground(ctx, body) {
  try {
    const id = String(body.id || '').replace(/[^A-Za-z0-9_-]/g, '_');
    if (!id) return { status: 400, body: { ok: false, error: '缺少 id' } };
    const { wallpapersDir } = dirsFor(ctx);
    let buf = null;
    let ext = 'webp';
    const wpName = String(body.wallpaper || '');
    const customName = String(body.custom || '');
    if (wpName) {
      const safeName = path.basename(wpName).replace(/[^A-Za-z0-9._-]/g, '_');
      const src = path.join(wallpapersDir, safeName);
      if (!fs.existsSync(src)) return { status: 400, body: { ok: false, error: '壁纸不存在: ' + safeName } };
      buf = fs.readFileSync(src);
      ext = media.extOfName(safeName) || 'webp';
    } else if (customName) {
      const safeName = path.basename(customName).replace(/[^A-Za-z0-9._-]/g, '_');
      if (!/^custom-/i.test(safeName)) return { status: 400, body: { ok: false, error: '壁纸不存在: ' + safeName } };
      const src = path.join(wallpapersDir, safeName);
      if (!fs.existsSync(src)) return { status: 400, body: { ok: false, error: '壁纸不存在: ' + safeName } };
      buf = fs.readFileSync(src);
      ext = media.extOfName(safeName) || 'webp';
    } else {
      const parsed = media.parseDataUrl(body.dataUrl);
      if (!parsed) return { status: 400, body: { ok: false, error: '仅支持 PNG/JPEG/WebP/GIF 图片或 WebM/MP4 视频' } };
      buf = parsed.buf;
      ext = parsed.ext;
    }
    const isVid = media.VIDEO_EXTS.indexOf('.' + ext) !== -1;
    const sizeLimit = isVid ? media.VIDEO_MAX_BYTES : media.IMAGE_MAX_BYTES;
    if (buf.length > sizeLimit) return { status: 400, body: { ok: false, error: isVid ? '视频不能超过 80MB' : '图片不能超过 10MB' } };
    const dir = themeDir(ctx, id);
    fs.mkdirSync(dir, { recursive: true });
    const bgFileName = 'background.' + ext;
    cleanupOldBackgrounds(dir, bgFileName);
    fs.writeFileSync(path.join(dir, bgFileName), buf);
    // 更新 theme.json：image 指向新背景；bgVideo 仅在视频时置 true，否则删除（与原始实现一致）
    updateThemeJson(ctx, id, (t) => {
      t.image = bgFileName;
      if (isVid) t.bgVideo = true; else delete t.bgVideo;
    });
    writeCurrentTheme(ctx, id);
    if (ctx.log) ctx.log('替换背景图 -> ' + id + '/' + bgFileName + ' (' + buf.length + 'B' + (isVid ? ', 视频' : '') + ')');
    return { status: 200, body: { ok: true, image: bgFileName, id, saved: true } };
  } catch (e) {
    return { status: 500, body: { ok: false, error: e.message } };
  }
}

/** 应用主题（/api/theme-bg 的第二步；独立宿主可直接调）。缺 applyTheme 回调 → pending。 */
async function applyThemeId(ctx, id) {
  if (!id) return { applied: false, pending: true };
    // 无 applyTheme（standalone / 插件降级）或应用抛错时，一律判为「已保存，待应用」
    if (!ctx.applyTheme) {
      return { applied: false, pending: true, id, warn: '背景已保存，主题将在连接恢复后自动应用' }
    }
    try {
      const info = await ctx.applyTheme(id);
      return { applied: !!(info && info.ok), id };
    } catch (_) {
      return { applied: false, pending: true, id, warn: '背景已保存，主题将在连接恢复后自动应用' };
    }
}

/** /api/theme-bg 兼容入口：落盘 + 应用（行为与拆分前完全一致）。R5 后建议宿主直接组合 saveBackground/applyThemeId。 */
async function writeThemeBg(ctx, body) {
  const saved = saveBackground(ctx, body);
  if (!saved.body || saved.body.ok !== true) return saved;
  const applied = await applyThemeId(ctx, saved.body.id);
  return { status: 200, body: { ok: true, image: saved.body.image, id: saved.body.id, ...applied } };
}

module.exports = {
  readThemeJson,
  dirsFor,
  saveBackground,
  applyThemeId,
  themeDir,
  writeCurrentTheme,
  updateThemeJson,
  patchThemeJson,
  cleanupOldBackgrounds,
  listWallpapers,
  listCustom,
  saveCustom,
  deleteCustom,
  writeThemeBg,
};
