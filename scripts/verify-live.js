'use strict';
/**
 * 线上守门（P0-4）：核对"更新链路在线上是否真的通"。
 *
 * 为什么必须有它：v1.2.0 那次我们有五条本地断言全绿、却把更新机制发布成了一个**根本不能用**的东西
 * （feed 从没上线；更新包被静态站 WAF 拦成 403；applyUpdate 对真包 100% 失败）。
 * 三者都是"本地看不出来、只有线上能看出来"的问题 —— 发布后必须有一道自动关卡。
 *
 * 检查六项：
 *   ① feed 可达且是合法 JSON        ② latest 与本次要发布的版本一致
 *   ③ minSupported ≤ latest         ④ 包 URL 可达，字节数 == feed.size
 *   ⑤ 包 sha256 == feed.sha256      ⑥ **真解压**，包内 package.json 版本 == latest
 *
 * 用法：
 *   node scripts/verify-live.js                                  # 打线上正式源
 *   node scripts/verify-live.js --feed <url> --expect <version>   # 指定源与期望版本
 *   node scripts/verify-live.js --feed http://127.0.0.1:8000/version.json \
 *                               --pkg-base http://127.0.0.1:8000   # 部署前用本地目录先自检
 *
 * `--pkg-base` 会把包地址换成该前缀（只替换 origin/前缀，保留文件名）——
 * 于是同一份脚本既能守线上，也能在部署前把 landing/ 整体验一遍。
 *
 * 任一项不过 → 非 0 退出 = **本次发布判定为失败**。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const update = require(path.resolve(__dirname, '..', 'core', 'update.js'));

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  (cond ? pass++ : fail++);
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg + (!cond && extra ? '   [' + extra + ']' : ''));
};

/** 默认源 = update.json 里的第一个 feed。 */
function defaultFeed() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'update.json'), 'utf8'));
    return (cfg.feeds || [])[0] || null;
  } catch (_) { return null; }
}

/** 把包地址改写到另一个前缀（自检用），保留最后一段文件名。 */
function rebase(url, base) {
  if (!base) return url;
  try {
    const u = new URL(url);
    return base.replace(/\/+$/, '') + '/' + u.pathname.split('/').filter(Boolean).pop();
  } catch (_) { return url; }
}

(async () => {
  const feedUrl = arg('--feed') || defaultFeed();
  const pkgBase = arg('--pkg-base');
  const expect = arg('--expect') || JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

  console.log('=== 线上守门 verify-live ===');
  console.log('  feed      : ' + (feedUrl || '(未配置)'));
  console.log('  期望版本  : ' + expect);
  if (pkgBase) console.log('  包地址改写: ' + pkgBase + '（部署前自检模式）');
  console.log();

  if (!feedUrl) { console.error('没有可用的 feed 地址（update.json 里没配，也没传 --feed）'); process.exit(1); }

  // ① feed 可达且是合法 JSON
  let feed = null, feedErr = null;
  try {
    const res = await fetch(feedUrl, { redirect: 'follow' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    try { feed = JSON.parse(text); } catch (_) {
      throw new Error('返回的不是 JSON（前 80 字：' + text.slice(0, 80).replace(/\s+/g, ' ') + '）');
    }
  } catch (e) { feedErr = e; }
  ok(!!feed, '① feed 可达且是合法 JSON', feedErr && feedErr.message);
  if (!feed) {
    console.log('\n✗ 通过 ' + pass + ' / 失败 ' + fail + '  —— 发布失败：feed 读不到，后面几项无法继续。');
    process.exit(1);
  }

  // ② latest 与期望版本一致
  ok(String(feed.latest) === String(expect), '② latest（' + feed.latest + '）== 本次要发布的版本（' + expect + '）');

  // ③ minSupported ≤ latest
  const ms = feed.minSupported;
  ok(!ms || update.compareVersions(ms, feed.latest) <= 0,
    '③ minSupported（' + (ms || '未设') + '）≤ latest（' + feed.latest + '）',
    ms ? '填反了会让所有用户被判「必须更新」' : '');

  const zip = (feed.assets && feed.assets.zip) || {};
  const urls = [zip.url].concat(zip.mirrors || []).filter(Boolean);
  ok(urls.length >= 1, '存在更新包地址');
  if (!urls.length) { console.log('\n✗ 发布失败：feed 里没有包地址。'); process.exit(1); }

  // ④⑤ 逐个源试：可达 + 字节数 + sha256
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wbwp-live-'));
  const dest = path.join(tmp, 'pkg.bin');
  let got = null, lastErr = null, usedUrl = null;
  for (const raw of urls) {
    const u = rebase(raw, pkgBase);
    try {
      const dl = await update.downloadTo(u, dest, { timeoutMs: 180000 });
      got = dl; usedUrl = u;
      break;
    } catch (e) { lastErr = e; got = null; }
  }
  ok(!!got, '④ 更新包可下载（任一个源成功即可）', lastErr && lastErr.message);
  if (!got) {
    console.log('    试过的地址：' + urls.map((x) => rebase(x, pkgBase)).join(' ; '));
    update.removeTree(tmp);
    console.log('\n✗ 通过 ' + pass + ' / 失败 ' + fail + '  —— 发布失败：包下不动（这正是"feed 能读、更新必失败"的那类故障）。');
    process.exit(1);
  }
  console.log('    命中的源：' + usedUrl);
  ok(!zip.size || got.size === zip.size, '④ 字节数 == feed.size（得到 ' + got.size + '，期望 ' + (zip.size || '未设') + '）');
  ok(!zip.sha256 || got.sha256 === zip.sha256,
    '⑤ sha256 逐字节一致',
    '得到 ' + String(got.sha256).slice(0, 16) + '… 期望 ' + String(zip.sha256 || '').slice(0, 16) + '…');

  // ⑥ 真解压：包内版本必须等于 latest
  let innerVersion = null, innerErr = null;
  try {
    const staging = path.join(tmp, 'x');
    update.unzipTo(dest, staging);
    const root = update.effectiveRoot(staging);
    innerVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    ok(fs.existsSync(path.join(root, 'SKILL.md')), '包结构正常（含 SKILL.md）');
  } catch (e) { innerErr = e; }
  ok(!!innerVersion, '⑥ 包能真解压并读出 package.json', innerErr && innerErr.message);
  ok(String(innerVersion) === String(feed.latest),
    '⑥ 包内版本（' + innerVersion + '）== feed.latest（' + feed.latest + '）',
    '对不上就是"用户点更新必然失败"');

  update.removeTree(tmp);
  console.log('\n' + (fail ? '✗ ' : '✓ ') + '通过 ' + pass + ' / 失败 ' + fail);
  if (fail) console.log('发布判定：**失败** —— 先修好再用这个 feed。');
  else console.log('发布判定：通过。');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', (e && e.stack) || e); process.exit(1); });
