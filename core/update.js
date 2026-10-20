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
// pid 存活判定统一走 proc.js —— Windows 会回收 pid，只看 pidAlive 会误判（见 proc.js 顶部与修复计划）
const proc = require('./proc.js');

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
  // 网络超时（feed 请求）
  timeoutMs: 12000,
  // 更新包下载：单源超时 & 多源累计总时长上限（P1-2）
  downloadTimeoutMs: 180000,
  downloadTotalTimeoutMs: 300000,
};

const FEED_SCHEMA = 1;

// ── 更新包签名公钥（P1-1）────────────────────────────────────────────────────
/**
 * 为什么是**数组**而不是单把：轮换钥匙时新旧两把并存 —— 新款客户端同时认两把，
 * 等用户升上来之后，下一版再把旧的删掉。单把钥匙等于"一换钥匙，所有老客户端全部失效"。
 * `publicKey` 是 **DER(SPKI) 的 base64**（不是 PEM），省掉头尾与换行。
 *
 * 生成/轮换：`node scripts/init-signing-key.js --out <目录> --key-id <id>`
 * 签发：     `node scripts/sign-release.js --zip <包> --key <私钥> --key-id <id>`
 * ⚠️ 私钥只在本机，**永远不要提交、也不要放进 CI Secrets** —— 那等于把签名权交给托管方。
 */
const UPDATE_PUBKEYS = [
  { keyId: 'wbwp-2026a', publicKey: 'MCowBQYDK2VwAyEAtRoBG94CxEu31mT7puEKYSlxFvqte03fsxcUhJpn9MY=' },
];

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

// ── 下载面加固（P1-2）──────────────────────────────────────────────────────
/** 除"本轮初始 host"外，允许重定向到的额外主机。不在这份名单里的 host 一律拒绝跳转。 */
const REDIRECT_HOSTS = ['github.com', 'objects.githubusercontent.com', 'raw.githubusercontent.com'];

/** 体积上限：至少 8 MB，且不小于 feed 声明大小的 4 倍 —— 既留"包以后变大"的余量，又挡住"无限响应"式打爆磁盘。 */
function maxDownloadBytes(declaredSize) {
  return Math.max(8 * 1024 * 1024, 4 * (Number(declaredSize) || 0));
}

/** 是否允许作为下载源：必须 https；仅本机回环允许 http（本地自检用）。 */
function urlAllowed(u) {
  const loop = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  return u.protocol === 'https:' || (loop && u.protocol === 'http:');
}

/**
 * 下载到文件并算 sha256（流式，避免大文件占内存）。
 *
 * P1-2 加固三条：
 *  ① **体积上限** `maxBytes`：超了立即中止并删掉 `.part`。原实现**完全没有上限** ——
 *     一个"永远不结束"的响应就能把磁盘写满（这正是计划里列的"打爆磁盘"）。
 *  ② **跳转白名单**：只跟随 https，且目标 host 必须 ∈「初始 host + 固定 GitHub 域」。
 *     原实现**无条件跟随**，等于把 SSRF / 诱导跳转的口子完全敞开。
 *  ③ **跳转次数上限**：原实现是无限递归，恶意源可以绕圈耗尽句柄。
 *
 * `maxBytes` 不传则不限（保持旧行为，供 verify 脚本的普通读取用）。
 */
function downloadTo(url, dest, opts) {
  const o = opts || {};
  const allowedHosts = Array.isArray(o.allowedHosts) && o.allowedHosts.length
    ? o.allowedHosts.slice()
    : (() => {
        try { return [new URL(url).host].concat(REDIRECT_HOSTS); } catch (_) { return REDIRECT_HOSTS.slice(); }
      })();
  return downloadOnce(url, dest, o, allowedHosts, 0);
}

function downloadOnce(url, dest, o, allowedHosts, depth) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error('重定向过多（>5 次）: ' + url));
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('下载 URL 非法: ' + url)); }
    if (!urlAllowed(u)) return reject(new Error('拒绝非 https 的下载源: ' + url));
    const mod = u.protocol === 'http:' ? require('http') : require('https');
    let aborted = false;
    const req = mod.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || undefined,
      path: u.pathname + u.search, method: 'GET',
      headers: Object.assign({ 'User-Agent': 'workbuddy-wallpaper-updater' }, o.headers || {}),
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        let next;
        try { next = new URL(res.headers.location, url); } catch (_) { return reject(new Error('重定向地址非法')); }
        if (!urlAllowed(next)) return reject(new Error('拒绝跳转到非 https: ' + next.toString()));
        if (allowedHosts.indexOf(next.host) < 0) {
          return reject(new Error('拒绝跳转到白名单外的 host: ' + next.host + '（允许：' + allowedHosts.join(', ') + '）'));
        }
        return downloadOnce(next.toString(), dest, o, allowedHosts, depth + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }

      const maxBytes = Number(o.maxBytes) || 0;
      const declared = Number(res.headers['content-length']) || 0;
      if (maxBytes && declared && declared > maxBytes) {
        res.resume();
        return reject(new Error('更新包过大：响应声明 ' + declared + ' 字节 > 上限 ' + maxBytes + '，已中止'));
      }

      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = dest + '.part';
      const out = fs.createWriteStream(tmp);
      const hash = crypto.createHash('sha256');
      let size = 0;
      const abort = (msg) => {
        if (aborted) return;
        aborted = true;
        try { res.unpipe(out); } catch (_) {}
        try { req.destroy(); } catch (_) {}
        // Windows 上"还开着的文件"删不掉，所以等写流把句柄关掉再删 .part（并留一个兜底超时）
        const fail = () => { try { fs.unlinkSync(tmp); } catch (_) {} reject(new Error(msg)); };
        const to = setTimeout(fail, 2000);
        if (to.unref) to.unref();
        out.once('close', () => { clearTimeout(to); fail(); });
        try { out.destroy(); } catch (_) { clearTimeout(to); fail(); }
      };
      res.on('data', (c) => {
        if (aborted) return;
        size += c.length;
        if (maxBytes && size > maxBytes) {
          return abort('更新包过大：已收 ' + size + ' 字节 > 上限 ' + maxBytes + '，已中止并删除临时文件');
        }
        hash.update(c);
      });
      res.on('error', (e) => abort('下载中断: ' + ((e && e.message) || e)));
      out.on('error', (e) => abort('写文件失败: ' + ((e && e.message) || e)));
      res.pipe(out);
      out.on('finish', () => {
        if (aborted) return;
        out.close(() => {
          try { fs.renameSync(tmp, dest); } catch (_) { fs.copyFileSync(tmp, dest); try { fs.unlinkSync(tmp); } catch (__) {} }
          resolve({ size, sha256: hash.digest('hex') });
        });
      });
    });
    req.setTimeout(o.timeoutMs || 120000, () => req.destroy(new Error('下载超时 ' + (o.timeoutMs || 120000) + 'ms')));
    req.on('error', (e) => { if (!aborted) reject(e); });
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
  // P1-1：sha256 / signature / keyId 三者**都必填**。
  // 此前 sha256 是可选的，缺失即跳过完整性校验 —— 那等于"根本没有完整性校验"，只是看起来有。
  if (zip) {
    if (!zip.sha256) throw new Error('feed 的 assets.zip 缺少 sha256（P1-1 起必填）');
    if (!zip.signature) throw new Error('feed 的 assets.zip 缺少 signature（P1-1 起必填）');
    if (!zip.keyId) throw new Error('feed 的 assets.zip 缺少 keyId（无法确定用哪把公钥验签）');
  }
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
      signature: zip.signature ? String(zip.signature) : null,
      keyId: zip.keyId ? String(zip.keyId) : null,
    } : null,
  };
}

/**
 * 校验更新包签名（P1-1）。
 *
 * 签名对象 = **包文件的字节**（分离式签名）。理由：`sha256` 必填之后客户端本来就要对整包算一次哈希，
 * 在同一份字节上验签几乎零额外成本；而"签 feed 文档"要引入 JSON 规范化，序列化差一个空格就全挂。
 *
 * ⚠️ Ed25519 **不支持 `createVerify()` 流式**，必须把包整体读进内存（2.6 MB，可接受）。
 * ⚠️ `keyId` 未知一律拒绝，**绝不"遍历所有公钥挨个试"** —— 那会让轮换形同虚设，
 *    也把"用哪把钥匙签的"这个信息丢掉（出事时无法判断是哪一代密钥泄露）。
 *
 * @param {string} filePath    已下载到本地的包路径
 * @param {string} signatureB64 feed 里给的 base64 签名
 * @param {string} keyId       feed 里给的密钥标识
 * @returns {true}             验签通过
 * @throws  {Error}            缺签名 / keyId 未知 / 公钥坏 / 签名不匹配
 */
function verifySignature(filePath, signatureB64, keyId) {
  if (!signatureB64) throw new Error('更新包缺少签名（P1-1 起必须验签，拒绝安装）');
  if (!keyId) throw new Error('更新包缺少 keyId（无法确定用哪把公钥）');
  const key = UPDATE_PUBKEYS.find((k) => k.keyId === keyId);
  if (!key) throw new Error('未知的签名密钥 keyId=' + keyId + '（拒绝安装）');
  let pub;
  try {
    pub = crypto.createPublicKey({ key: Buffer.from(key.publicKey, 'base64'), format: 'der', type: 'spki' });
  } catch (_) {
    throw new Error('内置公钥无法解析（keyId=' + keyId + '）');
  }
  const sig = Buffer.from(String(signatureB64), 'base64');
  if (!sig.length) throw new Error('签名是空的（拒绝安装）');
  const data = fs.readFileSync(filePath);
  let ok = false;
  try { ok = crypto.verify(null, data, pub, sig); } catch (_) { ok = false; }
  if (!ok) throw new Error('签名校验失败（keyId=' + keyId + '）—— 包被篡改，或不是用这把钥匙签的');
  return true;
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
      // 换成 nodePidAlive：pid 可能已被 Windows 回收给无关进程，只看 pidAlive 会让锁永远"被占着"
      const alive = info && info.pid ? proc.nodePidAlive(info.pid) : false;
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

  // P1-1 前置检查：签名三件套缺任何一样都不必浪费流量去下载 —— 下了也装不上。
  if (!zip.sha256) throw new Error('更新包缺少 sha256（P1-1 起必填，拒绝安装）');
  if (!zip.signature) throw new Error('更新包缺少签名（P1-1 起必须验签，拒绝安装）');
  if (!zip.keyId) throw new Error('更新包缺少 keyId（无法确定用哪把公钥）');
  if (!UPDATE_PUBKEYS.some((k) => k.keyId === zip.keyId)) {
    throw new Error('未知的签名密钥 keyId=' + zip.keyId + '（拒绝安装）');
  }

  const work = path.join(dataDir, 'update');
  const zipPath = path.join(work, 'download', 'wbwp-' + version + '.zip');
  const staging = path.join(work, 'staging', version);
  removeTree(staging);

  // ① 下载（多源依次试）
  //    P1-2 加固：
  //    · 单源 180s、**累计总时长 300s** —— 逐源超时挡不住"每个源都慢一点"这种慢性耗尽；
  //    · 体积上限 = max(8MB, 4×feed.size)，超了立即中止并删临时文件 —— 不给"无限响应"打爆磁盘的机会。
  const dlErrors = [];
  let dl = null;
  const dlStart = Date.now();
  const totalMs = Number(cfg.downloadTotalTimeoutMs) || 300000;
  const perSourceMs = Number(cfg.downloadTimeoutMs) || 180000;
  const maxBytes = maxDownloadBytes(zip.size);
  for (const u of urls) {
    if (Date.now() - dlStart > totalMs) {
      dlErrors.push('跳过 ' + u + ' → 累计下载时长已超过 ' + Math.round(totalMs / 1000) + 's 上限，停止换源');
      break;
    }
    try {
      dl = await downloadTo(u, zipPath, { timeoutMs: perSourceMs, maxBytes });
      if (zip.sha256 && dl.sha256 !== zip.sha256) throw new Error('sha256 不符（拿到 ' + dl.sha256.slice(0, 12) + '…）');
      if (zip.size && dl.size !== zip.size) throw new Error('大小不符（拿到 ' + dl.size + '，期望 ' + zip.size + '）');
      // P1-1：验签。sha256 只能证明"没下坏"，只有签名能证明"这是我们发的"。
      // 放在**循环内**逐源验，而不是循环之后：某个镜像被投毒时还能自动换下一个源。
      verifySignature(zipPath, zip.signature, zip.keyId);
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
 * 看门狗是否**真的**活着（`.companion.lock` 里的 pid 是 node.exe，且心跳新鲜）。
 * 为什么要判：apply 完成后本进程会 `exit(0)`，靠看门狗在 5s 内用**新代码**把服务拉回来。
 * 如果看门狗不在（例如用户是双击 启动.cmd 手动起的服务），退出就等于壁纸消失 —— 得先自己补一个。
 *
 * ⚠️ 必须比 `pidAlive` 更严：Windows 会把死进程的 pid 回收给别的进程（2026-10-20 事故）。
 *    只看 pid 会误判"看门狗还在"→ 更新后本进程退出、没人接手 → 壁纸消失。
 * ⚠️ 但没有心跳文件时**保守判定为活着**：那说明跑的是旧版看门狗（升级过渡期），
 *    此时宁可"信它一次"，也不要误判成"没人"去多起一个。
 */
function watchdogAlive(dataDir) {
  try {
    const pid = parseInt(String(fs.readFileSync(path.join(dataDir, '.companion.lock'), 'utf8')).trim(), 10);
    if (!pid) return false;
    if (!proc.nodePidAlive(pid)) return false;
    let age;
    try { age = Date.now() - fs.statSync(path.join(dataDir, '.companion.hb')).mtimeMs; }
    catch (_) { return true; }                     // 无心跳文件 = 旧版看门狗，信它
    return age < 90000;
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
  loadConfig, httpGetJson, downloadTo, maxDownloadBytes,
  crc32, safeEntryName, unzipTo,
  walkFiles, walkDirs, syncTree, removeTree, effectiveRoot,
  versionsDir, listBackups, pruneBackups,
  readCache, writeCache, cachePath, normalizeFeed,
  checkForUpdate, applyUpdate, rollbackTo,
  verifySignature, UPDATE_PUBKEYS,
  watchdogAlive, scheduleRestart,
  acquireUpdateLock, releaseUpdateLock, pidAlive,
};
