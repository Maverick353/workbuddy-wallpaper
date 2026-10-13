// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
/**
 * fonts.js · 本机字体枚举（纯 Node，不依赖任何外部命令）
 * ==================================================================
 * 为什么要自己解析：面板要让用户「搜得到本机装了什么字体」。
 *   · 浏览器侧 `queryLocalFonts()` 在 Electron 默认被拒（实测返回 0）；
 *   · Windows 注册表 `reg.exe` 在受管沙箱里被程序黑名单拦（实测 EPERM）。
 * 于是直接读字体目录 + 解析 OpenType `name` 表（nameID 16 优先，退 1）。
 *
 * 覆盖：.ttf / .otf / .ttc（TrueType Collection 会遍历其中每个子字体）
 * 结果缓存到 <dataDir>/fonts-cache.json（默认 24h），避免每次启动都扫盘。
 */

const fs = require('fs');
const path = require('path');

const CACHE_FILE = 'fonts-cache.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const TTC_TAG = 0x74746366; // 'ttcf'

/** 字体目录候选（系统 + 当前用户）。 */
function fontDirs() {
  const out = [];
  const windir = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows';
  out.push(path.join(windir, 'Fonts'));
  if (process.env.LOCALAPPDATA) out.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts'));
  return out;
}

/** 候选字符串打分：越像正常字体名分越高（用于在多种解码里择优选）。 */
function score(s) {
  if (!s) return -1;
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c === 0xFFFD || c < 0x20) { n -= 6; continue; }            // 替换符/控制符：重罚
    if ((c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A)) { n += 4; continue; }  // 拉丁字母
    if (c >= 0x30 && c <= 0x39) { n += 3; continue; }
    if (c >= 0x20 && c <= 0x7E) { n += 2; continue; }
    if (c >= 0x4E00 && c <= 0x9FFF) { n += 2; continue; }          // 中日韩统一表意
    if (c >= 0x3000 && c <= 0x303F) { n += 2; continue; }          // CJK 标点
    if (c >= 0xAC00 && c <= 0xD7AF) { n -= 3; continue; }          // 谚文：多为字节序错位的产物
    n -= 1;
  }
  // 字体名几乎都含拉丁字母（中文名亦有英文别名）→ 含字母的候选强加分，
  // 可把「UTF-16 字节序搞反」产生的一串生僻汉字压下去。
  if (/[A-Za-z]/.test(s)) n += 8;
  return n;
}

/**
 * 从 name 记录解码。按平台给出候选，逐个打分取最优：
 *  pid 0/3 规范是 UTF-16BE，但实测有非规范字体写成 LE → 两种都试；
 *  pid 1 是 MacRoman（latin1 近似），也有写成 UTF-16 的 → 都试。
 */
function decodeName(raw, pid) {
  const cands = [];
  const pushUtf16 = (swap) => {
    try {
      const b = swap ? Buffer.from(raw).swap16() : raw;
      cands.push(b.toString('utf16le'));
    } catch (_) {}
  };
  if (pid === 0 || pid === 3) { pushUtf16(true); pushUtf16(false); }
  else { try { cands.push(raw.toString('latin1')); } catch (_) {} pushUtf16(true); pushUtf16(false); }
  let best = '', bestScore = -Infinity;
  for (const c of cands) {
    const s = String(c || '').replace(/\u0000/g, '').trim();
    const sc = score(s);
    if (sc > bestScore) { bestScore = sc; best = s; }
  }
  return best || null;
}

/** 解析单个 sfnt 表的字体族名（nameID 16 = typographic family，退 1 = family）。 */
function parseSfnt(buf, off) {
  let numTables;
  try { numTables = buf.readUInt16BE(off + 4); } catch (_) { return null; }
  let nameOff = 0;
  for (let i = 0; i < numTables; i++) {
    const rec = off + 12 + i * 16;
    if (rec + 16 > buf.length) break;
    if (buf.toString('ascii', rec, rec + 4) === 'name') { nameOff = buf.readUInt32BE(rec + 8); break; }
  }
  if (!nameOff || nameOff + 6 > buf.length) return null;
  const count = buf.readUInt16BE(nameOff + 2);
  const strOff = nameOff + buf.readUInt16BE(nameOff + 4);
  const byKey = {};   // key -> {s, w}
  for (let i = 0; i < count; i++) {
    const r = nameOff + 6 + i * 12;
    if (r + 12 > buf.length) break;
    const pid = buf.readUInt16BE(r);
    const nid = buf.readUInt16BE(r + 6);
    if (nid !== 1 && nid !== 16) continue;
    const len = buf.readUInt16BE(r + 8);
    const ofs = buf.readUInt16BE(r + 10);
    const raw = buf.slice(strOff + ofs, strOff + ofs + len);
    const s = decodeName(raw, pid);
    if (!s) continue;
    // 权重：Windows 平台 + nameID 16 最可信
    const w = (pid === 3 ? 4 : 1) + (nid === 16 ? 2 : 0);
    const key = nid;
    if (!byKey[key] || byKey[key].w < w) byKey[key] = { s, w };
  }
  return (byKey[16] && byKey[16].s) || (byKey[1] && byKey[1].s) || null;
}

/** 读一个字体文件，返回其包含的族名数组（.ttc 会遍历子字体）。 */
function familiesOfFile(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch (_) { return []; }
  if (buf.length < 12) return [];
  const out = [];
  if (buf.readUInt32BE(0) === TTC_TAG) {
    let n = 0;
    try { n = buf.readUInt32BE(8); } catch (_) { return []; }
    for (let i = 0; i < Math.min(n, 64); i++) {
      const off = buf.readUInt32BE(12 + i * 4);
      const f = parseSfnt(buf, off);
      if (f) out.push(f);
    }
  } else {
    const f = parseSfnt(buf, 0);
    if (f) out.push(f);
  }
  return out;
}

/** 扫描本机字体，返回去重排序的族名列表。 */
function scanFonts() {
  const names = new Set();
  for (const dir of fontDirs()) {
    let files = [];
    try { files = fs.readdirSync(dir); } catch (_) { continue; }
    for (const f of files) {
      const ext = path.extname(f).toLowerCase();
      if (ext !== '.ttf' && ext !== '.otf' && ext !== '.ttc') continue;
      for (const fam of familiesOfFile(path.join(dir, f))) {
        const clean = String(fam).replace(/\s+/g, ' ').trim();
        if (!clean || clean.length > 60) continue;
        if (/\uFFFD/.test(clean)) continue;
        names.add(clean);
      }
    }
  }
  return Array.from(names).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

/**
 * 常见字体的中文别名：系统里字体族名多是英文（Microsoft YaHei），
 * 中文用户搜「雅黑」会搜不到 → 命中英文名时把中文名也加进列表（两个都可见、都可搜）。
 */
const ALIASES = {
  'Microsoft YaHei': '微软雅黑',
  'Microsoft YaHei UI': '微软雅黑 UI',
  'SimSun': '宋体',
  'NSimSun': '新宋体',
  'SimHei': '黑体',
  'KaiTi': '楷体',
  'STKaiti': '华文楷体',
  'DengXian': '等线',
  'FangSong': '仿宋',
  'STFangsong': '华文仿宋',
  'YouYuan': '幼圆',
  'STXihei': '华文细黑',
  'STZhongsong': '华文中宋',
  'LiSu': '隶书',
  'Source Han Serif SC': '思源宋体',
  'Source Han Sans SC': '思源黑体',
  'MiSans': '小米兰亭',
  'Consolas': '等宽 Consolas',
  'Cascadia Code': 'Cascadia Code（等宽）',
  'Cascadia Mono': 'Cascadia Mono（等宽）',
};

/** 按别名表补中文名（原名保留）。 */
function expandAliases(names) {
  const set = new Set(names);
  const extra = [];
  for (const n of names) {
    const a = ALIASES[n];
    if (a && !set.has(a)) { extra.push(a); set.add(a); }
  }
  return names.concat(extra);
}

/** 内置兜底（扫不到时至少能用）。 */
const FALLBACK = [
  '微软雅黑', 'Microsoft YaHei', '等线', 'DengXian', '黑体', 'SimHei', '宋体', 'SimSun',
  '楷体', 'KaiTi', '仿宋', 'FangSong', '华文细黑', 'STXihei', '幼圆', 'YouYuan',
  '思源黑体', 'Source Han Sans SC', '思源宋体', 'Source Han Serif SC',
  'Arial', 'Segoe UI', 'Times New Roman', 'Georgia', 'Verdana', 'Tahoma',
  'Consolas', 'Courier New', 'Cambria', 'Calibri', 'Trebuchet MS',
];

/**
 * 取字体列表（带磁盘缓存）。
 * @param {string} dataDir 数据目录
 * @param {{refresh?: boolean, log?: Function}} [opts]
 * @returns {{fonts: string[], source: 'cache'|'scan'|'fallback', at: number}}
 */
function listFonts(dataDir, opts) {
  const o = opts || {};
  const cachePath = dataDir ? path.join(dataDir, CACHE_FILE) : null;
  if (!o.refresh && cachePath) {
    try {
      const c = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (c && Array.isArray(c.fonts) && c.fonts.length && (Date.now() - (c.at || 0)) < CACHE_TTL_MS) {
        return { fonts: c.fonts, source: 'cache', at: c.at || 0 };
      }
    } catch (_) {}
  }
  let fonts = [];
  try { fonts = scanFonts(); } catch (e) { if (typeof o.log === 'function') o.log('[fonts] 扫描失败: ' + e.message); }
  const source = fonts.length ? 'scan' : 'fallback';
  if (!fonts.length) fonts = FALLBACK.slice();
  fonts = expandAliases(fonts).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  if (cachePath) {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(cachePath, JSON.stringify({ at: Date.now(), source, fonts }));
    } catch (_) {}
  }
  return { fonts, source, at: Date.now() };
}

module.exports = { listFonts, scanFonts, fontDirs };
