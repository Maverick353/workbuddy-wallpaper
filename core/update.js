// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
/**
 * update.js · 版本检测与更新推送（零依赖）
 * ------------------------------------------------------------------
 * 设计要点（为什么是这样）：
 *
 * ① **只有静态站可用，所以只能轮询，不能真推送。**
 *    实测：本机 curl 直连 github.com / raw.githubusercontent.com 全部 `HTTP 000`（连接被重置），
 *    而自建静态站 `workbuddy-wallpaper.app.workbuddy.host` 是 HTTP 200 / 0.57s。
 *    所以 feed 主源 = 静态站，GitHub raw 只作兜底（海外/直连可用时）。
 *    "准推送"靠**四条触发时机**叠加：服务启动后延迟一次 + 运行中每 N 小时 + 面板打开时按需 +
 *    用户手动点。效果是「发布后最长 N 小时内本机就知道」。
 *
 * ② **绝不阻塞**。任何网络失败都只是一行日志 + 面板上「上次检查失败 + 原因」，
 *    绝不影响服务启动、绝不影响壁纸显示。
 *
 * ③ **不静默替换**。检测到新版 → 面板提示 → 用户点「立即更新」才动手；
 *    动手前**整包备份**，失败回滚，面板可手动回滚到上一版。
 *
 * ④ **零依赖**：zip 解压自己写（zip 的 deflate 就是 raw deflate，用内置 zlib 即可），
 *    不依赖 `tar`/`unzip`/PowerShell —— 这些在受限机器上可能被策略拦。
 *
 * ⑤ **可测**：所有路径（targetDir/dataDir/pkgRoot/feed URL）都能注入，
 *    所以端到端能在临时目录里跑，不动真实安装。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

// ── 默认配置（用 `<pkgRoot>/update.json` 可覆盖；用户再用 `<dataDir>/update.json` 覆盖）──
const DEFAULTS = {
  // feed 列表：按顺序尝试，第一个成功的即采用（主源=静态站，兜底=GitHub raw）
  feeds: [
    'https://workbuddy-wallpaper.app.workbuddy.host/version.json',
    'https://raw.githubusercontent.com/Maverick353/workbuddy-wallpaper/main/landing/version.json',
  ],
  channel: 'stable',
  // 服务启动后延迟多久做首次检查（秒）—— 让开服务、注入壁纸先跑完
  startupDelaySeconds: 25,
  // 运行中每多少小时检查一次
  checkIntervalHours: 6,
  // 同一进程内两次「主动检查」之间的最小间隔（秒），防止用户狂点
  minCheckIntervalSeconds: 300,
  // 保留多少个旧版本备份（用于回滚）
  keepBackups: 3,
  // 网络超时
  timeoutMs: 12000,
};

const FEED_SCHEMA = 1;

// ── 版本比对 ────────────────────────────────────────────────────────────────
/**
 * 解析 semver（宽松）：允许 `v1.2.3`、`1.2`、`1.2.3-beta.1`、`1.2.3+build`。非法返回 null。
 * ⚠️ 构元数据（`+xxx`）**不参与优先级比较**（semver 规定），必须与 `-xxx` 预发布分开捕获 ——
 *    写成一个 `[-+](.*)` 会把 `1.2.0+build` 误判成「低于 1.2.0」（我第一版就是这么错的，单测当场抓到）。
 */
function parseVersion(v) {
  const m = String(v == null ? '' : v).trim()
    .match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: m[2] === undefined ? 0 : Number(m[2]),
    patch: m[3] === undefined ? 0 : Number(m[3]),
    pre: m[4] || '',
  };
}

/**
 * 比较两个版本：a > b → 1，a < b → -1，相等 → 0。
 * 非法版本号一律当「最小」处理（返回 -1），**绝不抛异常** —— 版本号脏不该让更新检查崩掉。
 * 预发布版（有 `-xxx`）小于同号正式版（semver 规则）。
 */
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (const k of ['major', 'minor', 'patch']) {
    if (pa[k] !== pb[k]) return pa[k] > pb[k] ? 1 : -1;
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;   // 正式版 > 预发布
  if (!pb.pre) return -1;
  return pa.pre > pb.pre ? 1 : -1;
}

/** b 是否比 a 新。 */
function isNewer(a, b) { return compareVersions(b, a) > 0; }

// ── 配置 ────────────────────────────────────────────────────────────────────
function readJsonSafe(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return fallback; }
}

/**
 * 解析生效配置。优先级（低 → 高）：
 *   DEFAULTS  <  `<pkgRoot>/update.json`（随包分发）  <  `<dataDir>/update.json`（用户覆盖，升级不丢）
 *   <  环境变量 `WBWP_UPDATE_FEED`（逗号分隔的 URL 列表）/ `WBWP_UPDATE_OFF=1`
 */
function loadConfig(opts) {
  const o = opts || {};
  const pkgRoot = o.pkgRoot || path.resolve(__dirname, '..');
  const dataDir = o.dataDir;
  let cfg = Object.assign({}, DEFAULTS);

  const packaged = readJsonSafe(path.join(pkgRoot, 'update.json'), null);
  if (packaged && typeof packaged === 'object') cfg = Object.assign(cfg, packaged);

  if (dataDir) {
    const user = readJsonSafe(path.join(dataDir, 'update.json'), null);
    if (user && typeof user === 'object') cfg = Object.assign(cfg, user);
  }

  if (process.env.WBWP_UPDATE_FEED) {
    cfg.feeds = String(process.env.WBWP_UPDATE_FEED).split(',').map((s) => s.trim()).filter(Boolean);
  }
  cfg.disabled = String(process.env.WBWP_UPDATE_OFF || '') === '1';
  if (!Array.isArray(cfg.feeds)) cfg.feeds = DEFAULTS.feeds.slice();
  cfg.channel = String(cfg.channel || 'stable');
  return cfg;
}

// ── HTTP（零依赖，自带重定向/超时/上限）─────────────────────────────────────
function requestOnce(url, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('feed URL 非法: ' + url)); }
    const mod = u.protocol === 'http:' ? require('http') : require('https');
    const req = mod.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || undefined,
      path: u.pathname + u.search, method: o.method || 'GET',
      headers: Object.assign({ 'User-Agent': 'workbuddy-wallpaper-updater' }, o.headers || {}),
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > (o.maxBytes || 512 * 1024)) { req.destroy(new Error('响应过大')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.setTimeout(o.timeoutMs || DEFAULTS.timeoutMs, () => req.destroy(new Error('超时 ' + (o.timeoutMs || DEFAULTS.timeoutMs) + 'ms')));
    req.on('error', reject);
    req.end();
  });
}

/** 带重定向跟随的 GET（JSON）。 */
async function httpGetJson(url, opts) {
  const o = opts || {};
  let cur = url;
  for (let i = 0; i < 5; i++) {
    const r = await requestOnce(cur, o);
    if (r.status >= 300 && r.status < 400 && r.headers.location) {
      cur = new URL(r.headers.location, cur).toString();
      continue;
    }
    return { status: r.status, headers: r.headers, text: r.body.toString('utf8') };
  }
  throw new Error('重定向过多: ' + url);
}

/** 下载到文件并算 sha256（流式，避免大文件占内存）。 */
function downloadTo(url, dest, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('下载 URL 非法: ' + url)); }
    const mod = u.protocol === 'http:' ? require('http') : require('https');
    const req = mod.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || undefined,
      path: u.pathname + u.search, method: 'GET',
      headers: Object.assign({ 'User-Agent': 'workbuddy-wallpaper-updater' }, o.headers || {}),
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return downloadTo(new URL(res.headers.location, url).toString(), dest, o).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = dest + '.part';
      const out = fs.createWriteStream(tmp);
      const hash = crypto.createHash('sha256');
      let size = 0;
      res.on('data', (c) => { size += c.length; hash.update(c); });
      res.on('error', reject);
      out.on('error', reject);
      res.pipe(out);
      out.on('finish', () => {
        out.close(() => {
          try { fs.renameSync(tmp, dest); } catch (_) { fs.copyFileSync(tmp, dest); try { fs.unlinkSync(tmp); } catch (__) {} }
          resolve({ size, sha256: hash.digest('hex') });
        });
      });
    });
    req.setTimeout(o.timeoutMs || 120000, () => req.destroy(new Error('下载超时')));
    req.on('error', reject);
    req.end();
  });
}

// ── zip 解压（手写；method 0=stored / 8=deflate）─────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/** 条目名安全化：拒绝绝对路径 / 盘符 / 越级（zip-slip）。返回 null 表示要跳过。 */
function safeEntryName(name) {
  const s = String(name).replace(/\\/g, '/');
  if (!s || s.startsWith('/') || /^[A-Za-z]:/.test(s)) return null;
  const parts = [];
  for (const seg of s.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') return null;
    parts.push(seg);
  }
  return parts.length ? parts.join('/') : null;
}

/**
 * 解压 zip 到 destDir。返回 `{ files, skipped }`。
 * 校验每个条目的 CRC32（解压器自带正确性证明，也便于单测）。
 */
function unzipTo(zipPath, destDir) {
  const buf = fs.readFileSync(zipPath);
  let eocd = -1;
  const floor = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip（找不到 EOCD）');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (cdOff === 0xffffffff || count === 0xffff) throw new Error('zip64 暂不支持');

  const entries = [];
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 中央目录损坏 @' + p);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const rawName = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.push({ rawName, method, crc, compSize, uncompSize, localOff });
    p += 46 + nameLen + extraLen + commentLen;
  }

  let files = 0, skipped = 0;
  for (const e of entries) {
    if (e.rawName.endsWith('/')) { skipped++; continue; }         // 目录条目
    const rel = safeEntryName(e.rawName);
    if (!rel) { skipped++; continue; }                            // 越级/绝对路径 → 丢弃
    if (buf.readUInt32LE(e.localOff) !== 0x04034b50) throw new Error('zip 局部头损坏: ' + e.rawName);
    const lNameLen = buf.readUInt16LE(e.localOff + 26);
    const lExtraLen = buf.readUInt16LE(e.localOff + 28);
    const dataStart = e.localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + e.compSize);
    let data;
    if (e.method === 0) data = Buffer.from(raw);
    else if (e.method === 8) data = zlib.inflateRawSync(raw);
    else { skipped++; continue; }                                 // 其它压缩法跳过
    if (e.uncompSize && data.length !== e.uncompSize) throw new Error('长度不符: ' + rel);
    if (crc32(data) !== e.crc) throw new Error('CRC 校验失败: ' + rel);
    const out = path.join(destDir, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, data);
    files++;
  }
  return { files, skipped, total: entries.length };
}

// ── 目录同步 / 删除 ────────────────────────────────────────────────────────
function walkFiles(root, base) { return walkImpl(root, base || root); }
function walkImpl(root, base, acc) {
  const out = acc || [];
  let items = [];
  try { items = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return out; }
  for (const it of items) {
    const abs = path.join(root, it.name);
    if (it.isDirectory()) walkImpl(abs, base, out);
    else out.push(path.relative(base, abs).split(path.sep).join('/'));
  }
  return out;
}

/** 列出所有**子目录**（相对路径）。清理空目录要用它 —— 只按文件推目录会漏掉目标里本来就空的那种。 */
function walkDirs(root, base, acc) {
  const out = acc || [];
  const b = base || root;
  let items = [];
  try { items = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return out; }
  for (const it of items) {
    if (!it.isDirectory()) continue;
    const abs = path.join(root, it.name);
    out.push(path.relative(b, abs).split(path.sep).join('/'));
    walkDirs(abs, b, out);
  }
  return out;
}

/**
 * 探测解压后的**有效根**。
 *
 * 为什么需要它：发布包由 `git archive --prefix=workbuddy-wallpaper/` 打出，
 * **所有条目都带一层顶层目录前缀**，根下没有 `package.json`。
 * 直接按根读会必然失败——这正是 v1.2.0「点『立即更新』必失败」的根因
 * （错误表现为「更新包内版本(undefined) 与目标版本(x) 不一致」）。
 *
 * 规则：根下有 `package.json` → 用根；
 *       根下恰好只有一个目录、没有其它文件、且那个目录里有 `package.json` → 下沉一层；
 *       其它情况 → 用根（让后面的冒烟校验去报明确的错，不在这里猜）。
 *
 * ⚠️ 不写死 `workbuddy-wallpaper` 这个名字：打包前缀将来可能变，靠"形状"判断而不是靠名字。
 */
function effectiveRoot(dir) {
  if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return dir; }
  const dirs = items.filter((it) => it.isDirectory());
  const files = items.filter((it) => !it.isDirectory());
  if (dirs.length === 1 && files.length === 0) {
    const inner = path.join(dir, dirs[0].name);
    if (fs.existsSync(path.join(inner, 'package.json'))) return inner;
  }
  return dir;
}

/**
 * 把 src 的内容同步到 dest（**文件级**，不删 dest 目录本身）。
 * 为什么不像 install.js 那样 `removeTree(dest)`：正在跑的服务/看门狗可能以 dest 为当前目录，
 * Windows 删不掉「某进程的当前目录」。文件级覆盖 + 删除多余文件 + 清空目录，效果等价且更安全。
 */
function syncTree(src, dest) {
  const want = walkFiles(src);
  const had = walkFiles(dest);
  const wantSet = new Set(want);
  let written = 0;
  for (const rel of want) {
    const to = path.join(dest, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(src, rel), to);
    written++;
  }
  let removed = 0;
  for (const rel of had) {
    if (wantSet.has(rel)) continue;
    try { fs.unlinkSync(path.join(dest, rel)); removed++; } catch (_) {}
  }
  // 清理空目录：**用目标里真实存在的子目录列表**，自底向上（按路径长度降序）逐层尝试。
  // ⚠️ 不能只从「被删文件」反推目录 —— 目标里原本就存在的空目录会漏掉（单测当场抓到）。
  const dirs = walkDirs(dest, dest).sort((a, b) => b.length - a.length);
  for (const d of dirs) {
    const abs = path.join(dest, d);
    try { if (fs.readdirSync(abs).length === 0) fs.rmdirSync(abs); } catch (_) {}
  }
  return { written, removed };
}

/** 递归删除（自写：宿主托管 Node 的 fs.rmSync 被 safe-delete shim 接管会抛错）。 */
function removeTree(p) {
  let st;
  try { st = fs.lstatSync(p); } catch (_) { return false; }
  if (st.isDirectory()) {
    let items = [];
    try { items = fs.readdirSync(p); } catch (_) {}
    for (const n of items) removeTree(path.join(p, n));
    try { fs.rmdirSync(p); } catch (_) { return false; }
  } else {
    try { fs.unlinkSync(p); } catch (_) { return false; }
  }
  return true;
}

// ── 备份 / 回滚 ────────────────────────────────────────────────────────────
function versionsDir(dataDir) { return path.join(dataDir, 'versions'); }

function listBackups(dataDir) {
  const root = versionsDir(dataDir);
  let items = [];
  try { items = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return []; }
  return items.filter((d) => d.isDirectory()).map((d) => {
    let at = 0;
    try { at = fs.statSync(path.join(root, d.name)).mtimeMs; } catch (_) {}
    const pj = readJsonSafe(path.join(root, d.name, 'package.json'), null);
    return { version: d.name, at, versionFromPkg: pj && pj.version ? pj.version : null };
  }).sort((a, b) => b.at - a.at);
}

function pruneBackups(dataDir, keep) {
  const list = listBackups(dataDir);
  const n = Number.isFinite(Number(keep)) ? Number(keep) : DEFAULTS.keepBackups;
  const dropped = [];
  for (const b of list.slice(Math.max(0, n))) {
    if (removeTree(path.join(versionsDir(dataDir), b.version))) dropped.push(b.version);
  }
  return dropped;
}

// ── feed 检查 ──────────────────────────────────────────────────────────────
function cachePath(dataDir) { return path.join(dataDir, 'update-cache.json'); }

function readCache(dataDir) {
  return readJsonSafe(cachePath(dataDir), { lastCheckAt: 0, etag: null, source: null, result: null });
}
function writeCache(dataDir, c) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(cachePath(dataDir), JSON.stringify(c, null, 2));
  } catch (_) {}
}

/** 校验 feed 结构，返回规范化对象；结构不对抛错（调用方换下一个源）。 */
function normalizeFeed(j, source) {
  if (!j || typeof j !== 'object') throw new Error('feed 不是对象');
  if (j.schema && Number(j.schema) > FEED_SCHEMA) throw new Error('feed schema ' + j.schema + ' 过新');
  if (!parseVersion(j.latest)) throw new Error('feed 缺少合法 latest');
  const assets = j.assets && typeof j.assets === 'object' ? j.assets : {};
  const zip = assets.zip && typeof assets.zip === 'object' ? assets.zip : null;
  // latest / minSupported 一律**去掉前导 v** 再对外给 —— 否则面板会显示成「vv1.2.0」。
  const strip = (s) => String(s).trim().replace(/^v/i, '');
  return {
    source,
    channel: String(j.channel || 'stable'),
    latest: strip(j.latest),
    minSupported: j.minSupported ? strip(j.minSupported) : null,
    releasedAt: j.releasedAt || null,
    notes: typeof j.notes === 'string' ? j.notes : '',
    homepage: j.url || null,
    zip: zip ? {
      url: String(zip.url || ''),
      mirrors: Array.isArray(zip.mirrors) ? zip.mirrors.map(String) : [],
      size: Number(zip.size) || 0,
      sha256: zip.sha256 ? String(zip.sha256).toLowerCase() : null,
    } : null,
  };
}

/**
 * 检查更新。
 * @returns {object} 永远 resolve：
 *   { ok, disabled?, fromCache?, error?, currentVersion, latest, hasUpdate, mustUpdate,
 *     canUpdate, notes, zip, source, lastCheckAt, checkedAt, minSupported }
 */
async function checkForUpdate(opts) {
  const o = opts || {};
  const dataDir = o.dataDir;
  const cfg = loadConfig({ pkgRoot: o.pkgRoot, dataDir });
  const currentVersion = String(o.currentVersion || '0.0.0');
  const now = Date.now();
  const cache = readCache(dataDir);

  const minGapMs = Math.max(0, Number(cfg.minCheckIntervalSeconds || 0)) * 1000;
  if (!o.force && cache.result && now - Number(cache.lastCheckAt || 0) < minGapMs) {
    return Object.assign({}, cache.result, { fromCache: true });
  }
  if (cfg.disabled) {
    return { ok: false, disabled: true, error: '更新检查已关闭（WBWP_UPDATE_OFF=1）', currentVersion, lastCheckAt: cache.lastCheckAt || 0 };
  }

  const errors = [];
  for (const feedUrl of cfg.feeds) {
    try {
      const headers = {};
      if (cache.etag && cache.source === feedUrl) headers['If-None-Match'] = cache.etag;
      const r = await httpGetJson(feedUrl, { timeoutMs: cfg.timeoutMs, headers });
      if (r.status === 304 && cache.result) {
        const out = Object.assign({}, cache.result, { fromCache: true, source: feedUrl });
        writeCache(dataDir, { lastCheckAt: now, etag: cache.etag, source: feedUrl, result: out });
        return out;
      }
      if (r.status !== 200) throw new Error('HTTP ' + r.status);
      let j;
      try { j = JSON.parse(r.text); } catch (e) { throw new Error('feed 不是合法 JSON'); }
      const feed = normalizeFeed(j, feedUrl);

      const hasUpdate = isNewer(currentVersion, feed.latest);
      const mustUpdate = feed.minSupported ? compareVersions(currentVersion, feed.minSupported) < 0 : false;
      const out = {
        ok: true,
        currentVersion,
        latest: feed.latest,
        minSupported: feed.minSupported,
        hasUpdate,
        mustUpdate,
        // 能不能一键更新：有 zip 且不是「本地比 feed 还新」
        canUpdate: !!(feed.zip && feed.zip.url) && compareVersions(currentVersion, feed.latest) < 0,
        notes: feed.notes,
        releasedAt: feed.releasedAt,
        homepage: feed.homepage,
        channel: feed.channel,
        zip: feed.zip,
        source: feedUrl,
        lastCheckAt: now,
        checkedAt: new Date(now).toISOString(),
        errors: errors,
      };
      writeCache(dataDir, { lastCheckAt: now, etag: r.headers && r.headers.etag ? r.headers.etag : null, source: feedUrl, result: out });
      return out;
    } catch (e) {
      errors.push(feedUrl + ' → ' + ((e && e.message) || e));
    }
  }

  // 全部源都失败：**不覆盖上次成功的结论**，只更新错误信息
  const out = {
    ok: false,
    error: errors.join(' ; '),
    currentVersion,
    hasUpdate: cache.result ? !!cache.result.hasUpdate : false,
    latest: cache.result ? cache.result.latest : null,
    source: cache.result ? cache.result.source : null,
    lastCheckAt: cache.lastCheckAt || 0,
    checkedAt: new Date(now).toISOString(),
    stale: true,
    errors: errors,
  };
  writeCache(dataDir, { lastCheckAt: cache.lastCheckAt || 0, etag: cache.etag || null, source: cache.source || null, result: cache.result || null, lastError: out.error, lastErrorAt: now });
  return out;
}

// ── 应用更新 / 回滚 ────────────────────────────────────────────────────────
/**
 * 下载 → 校验 → 解压 → 备份当前 → 同步覆盖。
 * @param {object} o
 *   targetDir  要更新的目录（默认 = 本模块的上一级，即技能目录）
 *   dataDir    数据目录
 *   version    目标版本
 *   zip        来自 feed 的 zip 描述 { url, mirrors, sha256, size }
 *   keepBackups
 * @returns {object} { ok, version, from, backup, written, removed, zipSha256, staged }
 */
/**
 * 公开入口：先拿单飞锁，再执行真正的更新（P0-5）。
 *
 * 为什么需要锁：检查是**定时**触发的（启动后 25s / 每 6h），而「立即更新」是**手动**点的，
 * 两者完全可能同时进来。没有锁时它们会撞同一个 staging 目录、同一个备份目录、
 * 同一份缓存文件 → 目录被写坏且原因难查。
 */
async function applyUpdate(o) {
  const opts = o || {};
  if (!opts.dataDir) throw new Error('applyUpdate 需要 dataDir');
  const lockFile = acquireUpdateLock(opts.dataDir);
  try {
    return await applyUpdateUnlocked(opts);
  } finally {
    releaseUpdateLock(lockFile);
  }
}

/**
 * 单飞锁：`<dataDir>/update/.lock`，内容 `{pid, ts}`。
 * 用 `flag:'wx'` 原子创建；已存在时判断持有者是否还活着、以及是否已超时——
 * **陈旧锁可被接管**（否则一次崩溃会让更新永久卡死）。
 */
function acquireUpdateLock(dataDir, opts) {
  const dir = path.join(dataDir, 'update');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '.lock');
  const staleMs = (opts && opts.staleMs) || 30 * 60 * 1000;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, ts: Date.now() }), { flag: 'wx' });
      return file;
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      let info = null;
      try { info = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
      const age = info && info.ts ? (Date.now() - info.ts) : Infinity;
      const alive = info && info.pid ? pidAlive(info.pid) : false;
      if (alive && age < staleMs) {
        throw new Error('已有一次更新正在进行（pid ' + info.pid + '，' + Math.round(age / 1000) + 's 前开始），请稍后再试');
      }
      try { fs.unlinkSync(file); } catch (_) {}   // 陈旧锁 → 接管
    }
  }
  throw new Error('无法获取更新锁：' + file);
}

function releaseUpdateLock(file) { try { fs.unlinkSync(file); } catch (_) {} }

/** 进程存活探测（EPERM 也算活着：它在，只是我们无权给它发信号）。 */
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return !!(e && e.code === 'EPERM'); }
}

async function applyUpdateUnlocked(o) {
  const opts = o || {};
  const cfg = loadConfig({ pkgRoot: opts.pkgRoot, dataDir: opts.dataDir });
  const targetDir = opts.targetDir || path.resolve(__dirname, '..');
  const dataDir = opts.dataDir;
  const version = String(opts.version || '');
  const zip = opts.zip || {};
  if (!parseVersion(version)) throw new Error('目标版本非法: ' + version);
  const urls = [zip.url].concat(zip.mirrors || []).filter(Boolean);
  if (!urls.length) throw new Error('feed 没给更新包地址');

  const work = path.join(dataDir, 'update');
  const zipPath = path.join(work, 'download', 'wbwp-' + version + '.zip');
  const staging = path.join(work, 'staging', version);
  removeTree(staging);

  // ① 下载（多源依次试）
  const dlErrors = [];
  let dl = null;
  for (const u of urls) {
    try {
      dl = await downloadTo(u, zipPath, { timeoutMs: 180000 });
      if (zip.sha256 && dl.sha256 !== zip.sha256) throw new Error('sha256 不符（拿到 ' + dl.sha256.slice(0, 12) + '…）');
      if (zip.size && dl.size !== zip.size) throw new Error('大小不符（拿到 ' + dl.size + '，期望 ' + zip.size + '）');
      break;
    } catch (e) { dl = null; dlErrors.push(u + ' → ' + ((e && e.message) || e)); }
  }
  if (!dl) throw new Error('下载失败：' + dlErrors.join(' ; '));

  // ② 解压
  const uz = unzipTo(zipPath, staging);
  if (!uz.files) throw new Error('更新包里没有文件');

  // ②′ 有效根探测（P0-1）：发布包带一层顶层目录前缀，直接按根读会 100% 失败。
  const root = effectiveRoot(staging);

  // ③ 冒烟校验：解压出来的 package.json 版本必须等于目标版本（防串包/防 feed 写错）
  const stagedPkg = readJsonSafe(path.join(root, 'package.json'), null);
  if (!stagedPkg || String(stagedPkg.version) !== version) {
    throw new Error('更新包内版本(' + (stagedPkg && stagedPkg.version) + ') 与目标版本(' + version + ') 不一致');
  }
  if (!fs.existsSync(path.join(root, 'SKILL.md'))) throw new Error('更新包缺少 SKILL.md（不像本技能的包）');

  // ④ 备份当前 → dataDir/versions/<旧版本>
  const curPkg = readJsonSafe(path.join(targetDir, 'package.json'), null);
  const from = (curPkg && curPkg.version) || 'unknown';
  let backup = null;
  if (fs.existsSync(targetDir)) {
    const bdir = path.join(versionsDir(dataDir), from);
    removeTree(bdir);
    fs.mkdirSync(bdir, { recursive: true });
    const bk = syncTree(targetDir, bdir);
    backup = { version: from, dir: bdir, files: bk.written };
  }

  // ⑤ 同步覆盖（从**有效根**开始，不是解压目录根）
  //
  // P0-5：覆盖**中途**失败也必须能回到原样。
  // 原实现只在「同步成功、但版本号不对」时回滚；`syncTree` 自己抛错（文件被占用 / 磁盘满 /
  // 只读 / 路径被同名文件占住）时异常直接冒泡，**没人回滚** → 留下半新半旧的目录，
  // 而且下次启动就是坏的、用户无从恢复。
  const rollbackTo = (why) => {
    if (!backup) return false;
    try { syncTree(backup.dir, targetDir); return true; }
    catch (e2) {
      throw new Error(why + '；且自动回滚也失败(' + ((e2 && e2.message) || e2) + ')，'
        + '请手动从备份恢复：' + backup.dir);
    }
  };

  let sync = null;
  try {
    sync = syncTree(root, targetDir);
  } catch (e) {
    const msg = '覆盖过程中失败：' + ((e && e.message) || e);
    const restored = rollbackTo(msg);
    throw new Error(msg + (restored ? '（已自动回滚到 ' + from + '）' : '（没有可用备份，未回滚）'));
  }

  const afterPkg = readJsonSafe(path.join(targetDir, 'package.json'), null);
  if (!afterPkg || String(afterPkg.version) !== version) {
    const restored = rollbackTo('覆盖后版本校验失败（期望 ' + version + '，实得 ' + (afterPkg && afterPkg.version) + '）');
    throw new Error('覆盖后版本校验失败' + (restored ? '，已回滚到 ' + from : '，且没有可用备份'));
  }
  pruneBackups(dataDir, cfg.keepBackups);

  return {
    ok: true, version, from, backup, zipSha256: dl.sha256, zipSize: dl.size,
    written: sync.written, removed: sync.removed, staged: uz.files,
    watchdogChanged: opts.watchdogChanged !== undefined ? opts.watchdogChanged : null,
  };
}

/** 从备份回滚到指定版本（默认最近一份）。 */
function rollbackTo(o) {
  const opts = o || {};
  const dataDir = opts.dataDir;
  const targetDir = opts.targetDir || path.resolve(__dirname, '..');
  const list = listBackups(dataDir);
  if (!list.length) throw new Error('没有可回滚的备份');
  const pick = opts.version ? list.find((b) => b.version === String(opts.version)) : list[0];
  if (!pick) throw new Error('找不到备份: ' + opts.version);
  const bdir = path.join(versionsDir(dataDir), pick.version);
  const sync = syncTree(bdir, targetDir);
  const afterPkg = readJsonSafe(path.join(targetDir, 'package.json'), null);
  if (!afterPkg || String(afterPkg.version) !== pick.version) {
    throw new Error('回滚后版本校验失败（期望 ' + pick.version + '，实得 ' + (afterPkg && afterPkg.version) + '）');
  }
  return { ok: true, version: pick.version, written: sync.written, removed: sync.removed };
}

// ── 更新后的重启编排 ──────────────────────────────────────────────────────
/**
 * 看门狗是否活着（`.companion.lock` 里的 pid 是否存活）。
 * 为什么要判：apply 完成后本进程会 `exit(0)`，靠看门狗在 5s 内用**新代码**把服务拉回来。
 * 如果看门狗不在（例如用户是双击 启动.cmd 手动起的服务），退出就等于壁纸消失 —— 得先自己补一个。
 */
function watchdogAlive(dataDir) {
  try {
    const pid = parseInt(String(fs.readFileSync(path.join(dataDir, '.companion.lock'), 'utf8')).trim(), 10);
    if (!pid) return false;
    process.kill(pid, 0);   // 不真发信号，只探测存在性
    return true;
  } catch (_) { return false; }
}

/**
 * 安排一次「代码已换、进程需要换新」的重启：
 *   ① 看门狗活着 → 直接退出，它会在下一个 tick（≤5s）用磁盘上的新代码拉起服务；
 *   ② 看门狗不在 → 先 detached 拉起一个，再退出（否则没人接手，壁纸会消失）。
 * @returns {string} 'watchdog' | 'spawned-watchdog'
 */
function scheduleRestart(o) {
  const opts = o || {};
  const dataDir = opts.dataDir;
  const delayMs = Number.isFinite(Number(opts.delayMs)) ? Number(opts.delayMs) : 1500;

  // P0-6：用户点过「关闭壁纸」（面板会写 `.stopped`）→ **不要擅自把服务拉起来**。
  // 版本这时已经换好了，等他下次启用时自然生效。
  // 原实现不看这个标记：要么白等一场（看门狗活着但 companion 拒绝拉起 → 服务一直不回来），
  // 要么真被拉起来（start-ui 启动时会删掉 `.stopped`）→ 把用户「我关了」的意图抹掉。
  if (dataDir && fs.existsSync(path.join(dataDir, '.stopped'))) {
    return 'skipped-stopped';
  }

  const hadWatchdog = watchdogAlive(dataDir);
  if (!hadWatchdog) {
    try {
      const comp = path.join(opts.pkgRoot || path.resolve(__dirname, '..'), 'scripts', 'companion.js');
      const cp = require('child_process');
      const child = cp.spawn(process.execPath, [comp, '--start-detached'], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
    } catch (_) {}
  }
  const t = setTimeout(() => { try { process.exit(0); } catch (_) {} }, delayMs);
  if (t.unref) t.unref();
  return hadWatchdog ? 'watchdog' : 'spawned-watchdog';
}

module.exports = {
  DEFAULTS, FEED_SCHEMA,
  parseVersion, compareVersions, isNewer,
  loadConfig, httpGetJson, downloadTo,
  crc32, safeEntryName, unzipTo,
  walkFiles, walkDirs, syncTree, removeTree, effectiveRoot,
  versionsDir, listBackups, pruneBackups,
  readCache, writeCache, cachePath, normalizeFeed,
  checkForUpdate, applyUpdate, rollbackTo,
  watchdogAlive, scheduleRestart,
  acquireUpdateLock, releaseUpdateLock, pidAlive,
};
