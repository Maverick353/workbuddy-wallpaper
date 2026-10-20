#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
/**
 * release-feed.js · 生成更新用的 feed（version.json）并把更新包镜像到 landing/
 * ------------------------------------------------------------------
 * 用法：
 *   node scripts/release-feed.js [--from-release v1.2.0] [--version 1.2.0]
 *                               [--min-supported 1.1.0] [--notes "一句话"] [--notes-file x.md]
 *                               [--zip <本地包>] [--no-mirror] [--dry-run] [--allow-downgrade]
 *                               (--signature <b64> | --signature-file <文件>) --key-id <id>
 *
 * ⭐ **P1-1 起签名是硬门禁**：没给签名、或签名验不过这份包，一律 `exit 1`。
 *    绝不生成一个"看起来有更新、点下去必然失败"的 feed —— 新客户端 sha256 与签名都必填。
 *    正确顺序（先签、再生成 feed）：
 *      node scripts/sign-release.js --zip <包> --key <私钥> --key-id wbwp-2026a --out _tmp/sig.txt
 *      node scripts/release-feed.js --from-release v1.2.0 --signature-file _tmp/sig.txt --key-id wbwp-2026a
 *
 * ⭐ **默认从 GitHub Release 拉那份包来生成 feed**（`--from-release`，默认 `v<version>`）。
 *    为什么必须这样：`git archive` 打的 zip **不是跨环境字节确定的** ——
 *    实测同一提交，本地 Git for Windows 打出来 2717135 字节，CI（windows-latest）打出来 2717134 字节，
 *    sha256 不同。若拿本地包算 sha256 写进 feed，而用户走 GitHub 兜底源下载，
 *    校验必然失败（用户看到明确报错，不会装坏，但兜底源等于废了）。
 *    所以策略是：**feed 的 sha256 必须来自真正对外发布的那份字节**，
 *    并且把**同一份文件**镜像到静态站 —— 两个源发的是同一份字节，sha256 才成立。
 *    真的想用本地包就显式 `--zip`，脚本会大声警告。
 *
 * 为什么需要它：
 *   · 客户端只认一个 JSON（`version.json`），其中**必须**有 zip 的 url + sha256 + size ——
 *     sha256 是「下载的东西没被中间人换过/没下坏」的唯一凭据。
 *   · 主源是自建静态站（国内可直连），所以更新包也要**镜像一份到 landing/** 一起部署。
 *
 * 注意顺序（来自 release-and-ship 的教训）：**发布与部署是两件事**。
 *   本脚本只产出 `landing/version.json` + 镜像 zip；真正上线要另外跑一次 landing 部署。
 *   不要把它挂在打 tag 之后自动执行 —— tag 推出去不可回滚，部署失败会留下
 *   「版本已发、更新源还是旧的」的残局。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const update = require('../core/update.js');

const ROOT = path.resolve(__dirname, '..');
const REPO_SLUG = 'Maverick353/workbuddy-wallpaper';
const ZIP_NAME = 'workbuddy-wallpaper.zip';

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : null;
}
const has = (flag) => process.argv.includes(flag);

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = String(arg('--version') || pkg.version);
const landingDir = path.join(ROOT, 'landing');
const feedPath = path.join(landingDir, 'version.json');
const dryRun = has('--dry-run');
const noMirror = has('--no-mirror');
const explicitZip = arg('--zip');
const releaseTag = arg('--from-release') || ('v' + version);

let zipPath, zipSource;
let fetched = null;
if (explicitZip) {
  zipPath = path.resolve(ROOT, explicitZip);
  zipSource = '本地文件（--zip）';
} else {
  // 从 Release 拉官方产物：这是唯一能保证「sha256 == 用户真正下到的那份字节」的做法
  fetched = fs.mkdtempSync(path.join(os.tmpdir(), 'wbwp-ghzip-'));
  zipPath = path.join(fetched, ZIP_NAME);
  zipSource = 'GitHub Release ' + releaseTag;
  console.log('从 Release 取官方产物：' + releaseTag);
  const r = cp.spawnSync('gh', ['release', 'download', releaseTag, '-R', REPO_SLUG, '-p', ZIP_NAME, '-D', fetched, '--clobber'],
    { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (r.status !== 0 || !fs.existsSync(zipPath)) {
    console.error('取 Release 产物失败：' + ((r.stderr || r.stdout || '').trim().slice(0, 300)));
    console.error('  确认 tag 已推、release 工作流已跑完；或显式传 --zip <文件>。');
    process.exit(1);
  }
}

if (explicitZip) {
  console.log('');
  console.log('⚠️  你显式传了 --zip（本地包）。提醒：`git archive` 的 zip **不是跨环境字节确定的** ——');
  console.log('    同一提交在本机与 CI 可能差几个字节、sha256 不同。若走 GitHub 兜底源的用户拿到的');
  console.log('    是另一个字节序列，校验会失败。**除非你确认这份就是对外发布的那份，否则别加 --zip。**');
}

if (!update.parseVersion(version)) {
  console.error('版本号非法: ' + version);
  process.exit(1);
}
if (!fs.existsSync(zipPath)) {
  console.error('找不到更新包：' + zipPath);
  process.exit(1);
}

// ── 静态站上的镜像文件名：**绝不能是压缩包后缀** ─────────────────────────────
// 实测（2026-10-17）：静态站前置 WAF 按 URL 后缀拦截压缩包类扩展名
// （.zip / .gz / .tar / .7z / .rar 一律 403「WAF拦截页面」，**与文件是否存在无关**）。
// 客户端本就不看扩展名（下载写 .part 再 rename），所以换个后缀即可 —— 但这条必须机器守住，
// 否则哪天改回去，线上会出现"feed 能读、包下不动"的静默故障。
// GitHub Release 那边仍用 .zip（那边不拦），两个源是**同一份字节**。
const MIRROR_NAME = 'workbuddy-wallpaper-' + version + '.bin';
if (/\.(zip|gz|tgz|tar|7z|rar|bz2|xz)$/i.test(MIRROR_NAME)) {
  console.error('镜像文件名不能以压缩包后缀结尾（会被静态站 WAF 拦掉）：' + MIRROR_NAME);
  process.exit(1);
}

// ── ① 校验：包里的 package.json 版本必须等于要发布的版本（防串包）───────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wbwp-feed-'));
let innerVersion = null;
try {
  update.unzipTo(zipPath, tmp);
  const inner = JSON.parse(fs.readFileSync(path.join(tmp, 'workbuddy-wallpaper', 'package.json'), 'utf8'));
  innerVersion = String(inner.version);
} catch (e) {
  console.error('无法读取更新包内容：' + ((e && e.message) || e));
  process.exit(1);
} finally {
  update.removeTree(tmp);
}
if (innerVersion !== version) {
  console.error('版本不一致：包内 package.json = ' + innerVersion + '，要发布的是 ' + version + '。');
  console.error('  （zip 多半是旧提交打的。重新用当前 HEAD 打一次。）');
  process.exit(1);
}

// ── ② 算 sha256 / size ─────────────────────────────────────────────────────
const buf = fs.readFileSync(zipPath);
const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
const size = buf.length;

// ── ②′ 签名（P1-1，硬门禁）──────────────────────────────────────────────────
// 没签名就不生成 feed：新客户端要求 sha256 + 签名俱全，一份没签名的 feed 会被全部拒绝，
// 发出去等于"告诉用户有新版本、点下去必然失败"。
const keyId = arg('--key-id') || process.env.WBWP_SIGN_KEY_ID || '';
const sigFile = arg('--signature-file');
const signature = (sigFile
  ? fs.readFileSync(path.resolve(ROOT, sigFile), 'utf8')
  : (arg('--signature') || process.env.WBWP_SIGNATURE || '')).trim();

if (!signature) {
  console.error('拒绝生成 feed：缺少更新包签名。');
  console.error('  P1-1 起 feed 的 assets.zip 必须有 signature + keyId，否则新客户端一律拒绝安装。');
  console.error('  先签：node scripts/sign-release.js --zip <包> --key <私钥> --key-id <id> --out _tmp/sig.txt');
  console.error('  再跑：node scripts/release-feed.js ... --signature-file _tmp/sig.txt --key-id <id>');
  process.exit(1);
}
if (!keyId) {
  console.error('拒绝生成 feed：给了签名但没给 --key-id（客户端要靠它选公钥）。');
  process.exit(1);
}
if (!update.UPDATE_PUBKEYS.some((k) => k.keyId === keyId)) {
  console.error('拒绝生成 feed：keyId=' + keyId + ' 不在客户端内置的 UPDATE_PUBKEYS 里。');
  console.error('  客户端认的 keyId：' + update.UPDATE_PUBKEYS.map((k) => k.keyId).join(', '));
  process.exit(1);
}
// 自检：签名必须对**这份字节**验得过。签了另一份包（例如本地重打、与 Release 字节不同）会在这里被抓住。
try {
  update.verifySignature(zipPath, signature, keyId);
} catch (e) {
  console.error('拒绝生成 feed：签名与这份包不匹配 —— ' + ((e && e.message) || e));
  console.error('  （多半是签了另一份包：本地重打的 zip 与 Release 那份字节不同，sha256 都不一样。）');
  process.exit(1);
}

// ── ②″ P2-1：feed 字段校验（能在本地发现的，就别留到线上让用户发现）─────────
const minSupported = arg('--min-supported') || null;
if (minSupported !== null && !update.parseVersion(minSupported)) {
  console.error('--min-supported 非法：' + minSupported + '（要 x.y.z，可带前导 v）');
  process.exit(1);
}
if (minSupported !== null && update.compareVersions(minSupported, version) > 0) {
  console.error('--min-supported(' + minSupported + ') 不能高于 latest(' + version + ')。');
  console.error('  否则客户端会认为「连最新版都不受支持」→ 每次检查都提示必须更新。');
  process.exit(1);
}

// ── ③ 组装 feed ───────────────────────────────────────────────────────────
const NOTES_MAX = 4000;
const notesFile = arg('--notes-file');
const notes = notesFile
  ? fs.readFileSync(path.resolve(ROOT, notesFile), 'utf8').trim()
  : (arg('--notes') || '');
if (notes.length > NOTES_MAX) {
  console.error('notes 过长：' + notes.length + ' 字符，上限 ' + NOTES_MAX + '。');
  console.error('  这串会被塞进 feed 显示在面板「关于」页，太长会把面板撑坏 → 请精简后再发。');
  process.exit(1);
}
const ghUrl = 'https://github.com/' + REPO_SLUG + '/releases/download/v' + version + '/' + ZIP_NAME;
const siteBase = 'https://workbuddy-wallpaper.app.workbuddy.host';

// P2-1（幂等）：重跑**同一版本**时保留上一次的 releasedAt。
// 否则每次生成都刷一个新时间 —— 内容没变、时间变了，既产生无意义 diff，也让人以为发布时间是今天。
let prevReleasedAt = null;
let prevLatest = null;
try {
  const prev = JSON.parse(fs.readFileSync(feedPath, 'utf8'));
  if (prev.latest) prevLatest = String(prev.latest);
  if (String(prev.latest) === version && prev.releasedAt) prevReleasedAt = prev.releasedAt;
} catch (_) {}

// P2-1（降级保护）：不允许把线上 feed 的 latest **往下调**。
// 客户端用 compareVersions 判 hasUpdate —— latest 变小等于「已是最新版」，老用户永远收不到更新；
// 而已经升上去的人回不去（回滚是本地备份的事，不是 feed 的事）。这种"手滑打错版本号"必须拦下。
if (prevLatest && update.compareVersions(version, prevLatest) < 0 && !has('--allow-downgrade')) {
  console.error('拒绝生成 feed：这是降级（新 latest=' + version + ' < 现有 latest=' + prevLatest + '）。');
  console.error('  latest 变小会让所有老用户永远收不到更新。确实要降级就显式加 --allow-downgrade。');
  process.exit(1);
}

const feed = {
  schema: 1,
  channel: 'stable',
  latest: version,
  minSupported: minSupported,
  releasedAt: prevReleasedAt || new Date().toISOString(),
  url: siteBase + '/',
  notes: notes,
  assets: {
    zip: {
      // 主源 = 自建静态站（国内可直连）；GitHub Release 作镜像兜底。
      // ⚠️ 两个源必须是**同一份字节**：镜像就是这份 zip 原样拷进 landing/ 的（只换文件名），
      //    所以 sha256 对两边都成立（本地重打的包不保证字节相同，见文件头说明）。
      // ⚠️ 静态站那份**不能叫 .zip**：改名前实测该域名对压缩包后缀一律 403（WAF 拦截页）。
      url: noMirror ? ghUrl : siteBase + '/' + MIRROR_NAME,
      mirrors: noMirror ? [] : [ghUrl],
      size: size,
      sha256: sha256,
      // P1-1：对**这份字节**的分离式 Ed25519 签名（base64）+ 密钥标识。
      // 客户端：下载 → 核 sha256 → 用 keyId 选公钥验签 → 才解压安装。
      signature: signature,
      keyId: keyId,
    },
  },
};

console.log('更新包来源: ' + zipSource);
console.log('  大小  : ' + size + ' 字节 (' + (size / 1048576).toFixed(2) + ' MB)');
console.log('  sha256: ' + sha256);
console.log('  签名  : keyId=' + keyId + '  ' + signature.slice(0, 16) + '…（已用内置公钥自检通过）');
console.log('  包内版本: ' + innerVersion + '  ✓ 与发布版本一致');
console.log('主线地址: ' + feed.assets.zip.url);
console.log('镜像地址: ' + (feed.assets.zip.mirrors[0] || '(无)'));

if (dryRun) {
  console.log('\n--dry-run：什么都没写。');
  if (fetched) update.removeTree(fetched);
  process.exit(0);
}

fs.mkdirSync(landingDir, { recursive: true });
fs.writeFileSync(feedPath, JSON.stringify(feed, null, 2) + '\n');
console.log('\n已写 ' + path.relative(ROOT, feedPath));

if (!noMirror) {
  const dest = path.join(landingDir, MIRROR_NAME);
  fs.copyFileSync(zipPath, dest);
  console.log('已镜像更新包 → ' + path.relative(ROOT, dest) + '（与 feed 里 sha256 对应的就是这份字节）');
}
if (fetched) update.removeTree(fetched);

// ── ④ P2-1（产出后自检）：把**写下去的东西**读回来再验一遍 ───────────────────
// 前面的检查都是对"准备写的内容"做的；这一段验的是"磁盘上真实落下的字节"——
// 能抓住 zip/feed 写坏、镜像文件被截断、copyFileSync 落在别的盘上失败等"写得进去、读不出来"的情况。
{
  const problems = [];
  let back = null;
  try { back = JSON.parse(fs.readFileSync(feedPath, 'utf8')); }
  catch (e) { problems.push('feed 读不回来：' + e.message); }

  if (back) {
    if (String(back.latest) !== version) problems.push('回读 latest=' + back.latest + ' ≠ ' + version);
    if (String(back.minSupported) !== String(minSupported)) problems.push('回读 minSupported 不一致');
    if (!back.assets || !back.assets.zip) problems.push('回读缺 assets.zip');
    else {
      const z = back.assets.zip;
      if (!z.signature || !z.keyId) problems.push('回读缺 signature/keyId');
      if (!noMirror) {
        const mirror = path.join(landingDir, MIRROR_NAME);
        if (!fs.existsSync(mirror)) problems.push('镜像文件不存在：' + MIRROR_NAME);
        else {
          const mbuf = fs.readFileSync(mirror);
          const msha = crypto.createHash('sha256').update(mbuf).digest('hex');
          if (mbuf.length !== Number(z.size)) problems.push('镜像字节数 ' + mbuf.length + ' ≠ feed.size ' + z.size);
          if (msha !== z.sha256) problems.push('镜像 sha256 与 feed.sha256 不符');
          try { update.verifySignature(mirror, z.signature, z.keyId); }
          catch (e) { problems.push('镜像验签失败：' + e.message); }
        }
      }
    }
  }

  if (problems.length) {
    console.error('\n❌ 产出后自检未通过（文件已写，但**不可发布**）：');
    for (const p of problems) console.error('   · ' + p);
    process.exit(1);
  }
  console.log('\n✓ 产出后自检通过：回读 feed 合法 · 镜像字节数与 sha256 与 feed 一致 · 镜像验签通过');
}

console.log('\n下一步：部署 landing/ 到静态站（发布与部署分开跑），然后**必须**跑一次线上守门：');
console.log('  node scripts/verify-live.js        # 核对 feed 可读、包可下、sha256 逐字节一致');
console.log('  只在 ' + siteBase + '/version.json 与 ' + siteBase + '/' + MIRROR_NAME + ' 都验过之后，才算发布完成。');
