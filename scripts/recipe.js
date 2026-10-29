// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
/**
 * recipe.js · 主题配方（theme recipe）导出 / 导入
 * ==================================================================
 * P0-4.1：不分享成品图，只分享「配方」—— 提示词 + 参数 + 动画设置 + 素材哈希。
 * 一份配方 JSON 体积 KB 级，天然契合 AI 生成的可复现性，绕开图片体积/版权/仓库存储问题。
 *
 * 配方内容：
 *   · name/prompt/params   —— 生成这个壁纸的提示词与生成参数（AI 可复现的输入）
 *   · fx                   —— 昼夜循环 frames（time+素材哈希）与视差 parallax 配置
 *   · assets               —— 素材清单（file + sha256 + size），只记哈希不内联 base64
 *
 * 语义：
 *   · 导出：读 themes/<id>/theme.json，产出 .recipe.json（不含大图）
 *   · 导入：校验 schema，落成新主题目录；素材哈希用于校验——本地若已有同哈希素材则复用，
 *           否则提示「需另行提供素材文件」（配方本身可离线重建生成参数，但成品像素需素材）。
 *
 * 用法：
 *   node scripts/recipe.js export <themeId> [--out <file.recipe.json>] [--data-dir <dir>]
 *   node scripts/recipe.js import <file.recipe.json> [--data-dir <dir>] [--dry-run]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const APP = 'workbuddy-wallpaper';
const RECIPE_SCHEMA = 1;

function defaultDataDir() {
  const base = process.env.APPDATA ||
    (process.platform === 'win32' ? path.join(os.homedir(), 'AppData', 'Roaming') : path.join(os.homedir(), '.config'));
  return path.join(base, APP);
}

function themesDir(dataDir) { return path.join(dataDir, 'themes'); }
function safeId(id) { return String(id || '').replace(/[^A-Za-z0-9_-]/g, '_'); }

/** 读 themes/<id>/theme.json；不存在/损坏返回 null。 */
function readTheme(dataDir, id) {
  try {
    const file = path.join(themesDir(dataDir), safeId(id), 'theme.json');
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  } catch (_) { return null; }
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

/**
 * 收集主题目录下所有「素材」文件（背景 + frames 帧文件），只记哈希与大小，不内联内容。
 * 素材 = background.* 与 theme.frames[].file 指向的文件（frames 用 dataUrl 内联的则跳过——已在配方 fx 里）。
 */
function collectAssets(dataDir, theme, id) {
  const root = path.join(themesDir(dataDir), safeId(id));
  const assets = [];
  const seen = new Set();
  function add(rel) {
    if (!rel || seen.has(rel)) return;
    seen.add(rel);
    const abs = path.join(root, String(rel).replace(/^\.\.?[/\\]/, ''));
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return;
    const buf = fs.readFileSync(abs);
    assets.push({ file: String(rel), sha256: sha256(buf), size: buf.length });
  }
  if (theme && theme.image) add(theme.image);
  if (theme && Array.isArray(theme.frames)) {
    for (const f of theme.frames) {
      if (f && typeof f.file === 'string') add(f.file);
    }
  }
  return assets;
}

/**
 * 导出配方：theme.json 的可复现字段 + 素材哈希。
 * 返回配方对象（调用方可自行落盘）。
 */
function exportRecipe(opts) {
  const o = opts || {};
  const dataDir = o.dataDir || defaultDataDir();
  const id = o.id;
  if (!id) throw new Error('缺少主题 id（export <themeId>）');
  const theme = readTheme(dataDir, id);
  if (!theme) throw new Error('找不到主题：' + id + '（themes/' + safeId(id) + '/theme.json）');

  const fx = {};
  if (theme.parallax) fx.parallax = theme.parallax;
  // frames：dataUrl 内联的只记 time（成品像素由 dataUrl 承载时属于「已含素材」），file 型记 time+file 由 assets 管哈希
  if (Array.isArray(theme.frames) && theme.frames.length >= 2) {
    fx.frames = theme.frames.map(function (f) {
      const out = { time: Number(f.time) };
      if (f && typeof f.file === 'string') out.file = f.file;
      if (f && typeof f.dataUrl === 'string') out.dataUrlInline = true;
      return out;
    });
  }

  const recipe = {
    schema: RECIPE_SCHEMA,
    app: APP,
    kind: 'theme-recipe',
    id: safeId(id),
    name: (theme.recipeName || theme.weTitle || safeId(id)),
    prompt: theme.prompt || '',
    params: theme.params || {},
    fx: fx,
    assets: collectAssets(dataDir, theme, id),
    sourceTheme: safeId(id),
    exportedAt: new Date().toISOString(),
  };

  if (o.out) {
    const out = path.resolve(o.out);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(recipe, null, 2));
    return { ok: true, out, recipe, assetCount: recipe.assets.length };
  }
  return { ok: true, recipe };
}

/**
 * 导入配方：落成新主题目录 themes/<newId>/theme.json（写入 prompt/params/fx 字段）。
 * 素材不随配方走（配方只有哈希）；若本地已有同哈希素材则自动复用，否则只写配方字段并提示缺素材。
 */
function importRecipe(opts) {
  const o = opts || {};
  const dataDir = o.dataDir || defaultDataDir();
  const file = o.file;
  if (!file || !fs.existsSync(file)) throw new Error('找不到配方文件：' + (file || ''));

  const recipe = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!recipe || recipe.schema !== RECIPE_SCHEMA || recipe.kind !== 'theme-recipe' || recipe.app !== APP) {
    throw new Error('不是本技能的配方（schema/kind/app 不匹配）');
  }

  const newId = safeId(o.as || recipe.id || 'recipe-' + Date.now().toString(36));
  const dir = path.join(themesDir(dataDir), newId);
  if (fs.existsSync(dir) && !o.force) {
    throw new Error('目标主题已存在：' + newId + '（--as 换名 或 --force 覆盖）');
  }
  if (o.dryRun) return { ok: true, dryRun: true, willCreate: newId, willWrite: 'theme.json' };

  fs.mkdirSync(dir, { recursive: true });

  // 重组 theme.json：只写入可复现字段；image 不写（成品像素需素材另给）
  const theme = {};
  if (recipe.name) theme.recipeName = recipe.name;
  if (recipe.prompt) theme.prompt = recipe.prompt;
  if (recipe.params && typeof recipe.params === 'object') theme.params = recipe.params;
  if (recipe.fx && recipe.fx.parallax) theme.parallax = recipe.fx.parallax;
  if (recipe.fx && Array.isArray(recipe.fx.frames)) {
    // 帧还原：file 型保持 file 引用（素材待补）；dataUrlInline 型不写 dataUrl（配方不含像素）
    theme.frames = recipe.fx.frames.map(function (f) {
      const out = { time: f.time };
      if (f.file) out.file = f.file;
      return out;
    });
  }
  fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify(theme, null, 2));

  // 素材复用探测：本地其它主题目录里若有同哈希文件，直接拷过来（省得用户手动补）
  let reused = 0, missing = 0;
  if (Array.isArray(recipe.assets)) {
    for (const a of recipe.assets) {
      if (!a || !a.file || !a.sha256) continue;
      let found = null;
      try {
        for (const sub of fs.readdirSync(themesDir(dataDir))) {
          if (sub === newId) continue;
          const cand = path.join(themesDir(dataDir), sub, a.file);
          if (fs.existsSync(cand) && sha256(fs.readFileSync(cand)) === a.sha256) { found = cand; break; }
        }
      } catch (_) {}
      if (found) {
        const to = path.join(dir, a.file);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(found, to);
        reused++;
      } else {
        missing++;
      }
    }
  }

  return { ok: true, created: newId, themeDir: dir, reusedAssets: reused, missingAssets: missing };
}

// ── CLI ───────────────────────────────────────────────────────────────────
function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (require.main === module) {
  const cmd = process.argv[2];
  const dataDir = arg('--data-dir');
  const dryRun = process.argv.includes('--dry-run');
  try {
    if (cmd === 'export') {
      const id = process.argv[3];
      const r = exportRecipe({ id, dataDir, out: arg('--out') || (safeId(id) + '.recipe.json') });
      console.log('已导出配方：' + r.out + '（素材 ' + r.assetCount + ' 项，仅哈希不内联）');
    } else if (cmd === 'import') {
      const file = process.argv[3];
      const r = importRecipe({ file, dataDir, dryRun, as: arg('--as'), force: process.argv.includes('--force') });
      if (r.dryRun) console.log('试运行：将创建主题 ' + r.willCreate);
      else console.log('已导入配方 → 主题 ' + r.created + '（复用素材 ' + r.reusedAssets + '，缺 ' + r.missingAssets + ' 项）');
    } else {
      console.log('用法：\n  node scripts/recipe.js export <themeId> [--out file.recipe.json]\n  node scripts/recipe.js import <file.recipe.json> [--as newId] [--dry-run]');
    }
  } catch (e) {
    console.error('配方操作失败：' + e.message);
    process.exit(1);
  }
}

module.exports = { exportRecipe, importRecipe, collectAssets, readTheme, safeId, defaultDataDir, RECIPE_SCHEMA };
