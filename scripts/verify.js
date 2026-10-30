#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
/**
 * verify.js · 自验证（完全离线，起临时服务打真实请求）
 *   node scripts/verify.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const { start } = require(path.join(ROOT, 'server', 'standalone.js'));
const dshUI = require(path.join(ROOT, 'ui', 'dsh-ui', 'index.js'));
const bg = require(path.join(ROOT, 'ui', 'background.js'));
const themeCss = require(path.join(ROOT, 'core', 'theme-css.js'));
const { seedWallpapers } = require('./server.js');

let pass = 0, fail = 0;
const ok = (c, label, extra) => {
  if (c) { pass++; process.stdout.write('  ✓ ' + label + (extra ? '  ' + extra : '') + '\n'); }
  else { fail++; process.stdout.write('  ✗ ' + label + (extra ? '  ' + extra : '') + '\n'); }
};
const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbwp-'));
  const seeded = seedWallpapers(dataDir);
  const applied = [];
  const { server, port, apiToken } = await start({ port: 47899, dataDir, log: () => {}, applyTheme: async (id) => { applied.push(id); return { ok: true }; } });
  const BASE = 'http://127.0.0.1:' + port;
  // P1-3：受保护接口（/api/update* /api/shutdown）要带令牌；其它接口不需要
  const TK = { 'x-wbwp-token': apiToken };
  // 失败时把 undici 的 cause 也带出来 —— 不然只有一句 "fetch failed"，查不出是拒绝连接还是超时。
  // ⚠️ 每个请求都带 `connection: close`：undici 会复用空闲 socket，而 Node 的 http server
  //    默认 5s 空闲就断掉 keep-alive 连接 —— 测试跑得稍慢一点就会复用到"已死"的连接，
  //    表现为随机 `ECONNRESET`（2026-10-21 排查了半天，服务端连 request 事件都没收到）。
  const J = async (u, o) => {
    const opt = Object.assign({}, o || {}, {
      headers: Object.assign({ connection: 'close' }, (o && o.headers) || {}),
    });
    let r;
    try { r = await fetch(u, opt); } catch (e) {
      const c = e && e.cause;
      throw new Error('fetch ' + u + ' 失败: ' + (c && (c.code || c.message) || e.message));
    }
    return r.json();
  };

  process.stdout.write('\n[1] 服务与健康\n');
  const h = await J(BASE + '/api/wallpaper/health');
  ok(h && h.ok === true, 'GET /api/wallpaper/health → ok');
  ok(h && h.renderer && h.renderer.upToDate === true, '随包渲染器已就绪（自愈部署生效）', JSON.stringify(h && h.renderer));
  ok(seeded >= 12, '首启种子官方壁纸', seeded + ' 张');

  process.stdout.write('\n[2] 壁纸列表与静态服务\n');
  const list = await J(BASE + '/api/wallpapers');
  ok(list && list.ok && (list.wallpapers || []).length >= 12, 'GET /api/wallpapers → 官方壁纸', (list.wallpapers || []).length + ' 张');
  const first = (list.wallpapers || [])[0];
  const f = await fetch(BASE + '/wallpapers/' + encodeURIComponent(first.name));
  ok(f.status === 200 && Number(f.headers.get('Content-Length') || 0) > 0, '静态取回壁纸文件 200');
  const r = await fetch(BASE + '/wallpapers/' + encodeURIComponent(first.name), { headers: { Range: 'bytes=0-99' } });
  ok(r.status === 206 && /bytes 0-99\//.test(r.headers.get('Content-Range') || ''), 'Range 断点续传 206', r.headers.get('Content-Range'));

  process.stdout.write('\n[3] 自定义壁纸：上传 → 取回 → 删除\n');
  await J(BASE + '/api/custom-wallpapers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dataUrl: PNG_1PX }) });
  const after = await J(BASE + '/api/custom-wallpapers');
  const name = (after.wallpapers || [])[0] && after.wallpapers[0].name;
  ok(!!name, '上传成功并出现在列表', name);
  const st = await fetch(BASE + '/wallpapers/' + encodeURIComponent(name));
  ok(st.status === 200, '上传的文件可静态取回');
  await fetch(BASE + '/api/custom-wallpapers?name=' + encodeURIComponent(name), { method: 'DELETE' });
  const after2 = await J(BASE + '/api/custom-wallpapers');
  ok((after2.wallpapers || []).length === 0, '删除后列表归零');

  process.stdout.write('\n[4] 蒙版与应用回调\n');
  const m0 = await J(BASE + '/api/mask');
  ok(m0 && typeof m0.opacity === 'number', 'GET /api/mask', JSON.stringify(m0));
  const m1 = await J(BASE + '/api/mask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ opacity: 0.42 }) });
  ok(m1 && m1.opacity === 0.42, 'POST /api/mask 写入生效');
  const bad = await fetch(BASE + '/api/mask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ opacity: 'abc' }) });
  ok(bad.status === 400, '非法值 → 400');
  // ⚠️ 还原调用前的蒙版值：本用例为验证写入会把蒙版改成 0.42，若不还原等于每次跑测试
  // 都悄悄改掉用户的「背景蒙版」设置（实测踩过）。此处静默还原，不计入 ok。
  await J(BASE + '/api/mask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ opacity: m0.opacity }) });
  process.stdout.write('  · 蒙版已还原为 ' + m0.opacity + '\n');
  const ap = await J(BASE + '/api/theme-bg', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'demo', dataUrl: PNG_1PX }) });
  ok(ap && ap.ok && ap.applied === true && applied.length === 1, '应用壁纸 → 触发宿主 applyTheme 回调', JSON.stringify(ap));

  process.stdout.write('\n[5] 场景渲染页与边界\n');
  const scene = await fetch(BASE + '/wallpaper-engine/scene-live/index.html');
  ok(scene.status === 200 && /renderer-.*\.js/.test(await scene.text()), '场景渲染页可访问（WebWallGL）');
  const we = await J(BASE + '/api/we-wallpapers');
  ok(we && we.ok && Array.isArray(we.items), 'GET /api/we-wallpapers 可用', (we.items || []).length + ' 项');
  const nf = await fetch(BASE + '/api/does-not-exist');
  ok(nf.status === 404, '未知接口 → 404');

  process.stdout.write('\n[6] 注入产物（不需宿主即可校验结构）\n');
  const ui = dshUI.dshUIExpression({ apiBase: 'http://127.0.0.1:' + port, hostApi: false });
  ok(/wallpaperRopeBuddy/.test(ui) && /wallpaperPanel/.test(ui), 'UI 表达式含拉绳与面板');
  ok(/data:image\/png;base64,/.test(ui), '吉祥物立绘已内联');
  ok(/body\.wdw-dsh-ui #wbs-wallpaper-card/.test(ui), '含旧卡片让位样式（宿主共存时用）');
  const bge = bg.backgroundExpression({ css: '#root{background:red}', videoUrl: null, sceneUrl: null });
  ok(/wallpaperBackground/.test(bge) && /wdw-theme-style/.test(bge), '背景注入表达式结构正确');
  ok(/__wdwLoadVideo|__wdwLoadToken/.test(bg.backgroundExpression({})) || /loadVideo/.test(bge), '视频加载走直链流式（带令牌）');
  // ── 昼夜循环 + 鼠标视差（P0，2026-10-29 功能升级）──
  {
    ok(/resolveFrames/.test(String(themeCss.resolveFrames)) && /theme\.frames/.test(String(themeCss.resolveFrames)),
      '昼夜循环钉子：resolveFrames 读 theme.frames（≥2 帧才启用，否则页面侧保持单图）');
    const fxd = bg.backgroundExpression({ css: '', frames: [{ time: 6, url: 'data:image/png;base64,AA' }, { time: 18, url: 'data:image/png;base64,BB' }] });
    ok(/wdw-bg-fx/.test(fxd) && /installDaynight/.test(fxd) && /daynightBlend/.test(fxd),
      '昼夜循环钉子：注入表达式含 wdw-bg-fx 多帧层与插值逻辑');
    ok(/localHour|getHours/.test(fxd), '昼夜循环钉子：按本地时钟（getHours）驱动，运行时零网络');
    const px = bg.backgroundExpression({ css: '', parallax: { enabled: true, amp: 8 } });
    ok(/installParallax/.test(px) && /mousemove/.test(px) && /translate3d/.test(px),
      '视差钉子：注入表达式含 mousemove → translate3d 位移');
    ok(/translate3d\(0,0,0\)|mouseleave/.test(px), '视差钉子：鼠标离开后回中（回中/离场监听）');
    const bare = bg.backgroundExpression({ css: '#root{background:red}', videoUrl: null, sceneUrl: null });
    ok(/wdw-bg-fx/.test(bare), '昼夜循环钉子：无 frames 时也应注入含 fx 的表达式（结构稳定，只是不建帧层）');
  }

  // 说明：这里用**合成**的 .lnk，不提交真实文件 —— 真实 .lnk 的 ExtraData 里带机器名，
  // 属于不该进公开仓库的信息。合成结构覆盖了真正要紧的那几条格式契约。
  process.stdout.write('\n[7] lnk 纯字节补丁（改写快捷方式参数）\n');
  const lnk = require('./lnk.js');
  const STR_ORDER = [['NAME', 0x04], ['WORKING_DIR', 0x10], ['ARGUMENTS', 0x20]];
  const buildLnk = (opts) => {
    const unicode = opts.unicode !== false;
    const strs = [];
    const add = (n, bit, v) => { if (v != null) strs.push({ n, bit, v }); };
    add('NAME', 0x04, opts.name || 'Probe');
    add('WORKING_DIR', 0x10, opts.workdir || 'C:\\probe');
    add('ARGUMENTS', 0x20, opts.args);
    let flags = 0x01 | 0x02 | (unicode ? 0x80 : 0);   // ⚠️ ANSI 模式必须清掉 IsUnicode(0x80)，
                                                      // 否则解析端按 2 字节/字符读会越界（夹具坑，不是 lnk.js 的问题）
    for (const s of strs) flags |= s.bit;
    const idBody = Buffer.alloc(20, 0xAA);
    const idList = Buffer.concat([(() => { const h = Buffer.alloc(2); h.writeUInt16LE(idBody.length, 0); return h; })(), idBody]);
    const li = Buffer.alloc(40, 0xBB);
    li.writeUInt32LE(40, 0);
    const strings = Buffer.concat(strs.map((s) => {
      const body = unicode ? Buffer.from(s.v, 'utf16le') : Buffer.from(s.v, 'latin1');
      const h = Buffer.alloc(2);
      h.writeUInt16LE(unicode ? body.length / 2 : body.length, 0);
      return Buffer.concat([h, body]);
    }));
    const extra = Buffer.alloc(9, 0xCC);
    extra.writeUInt32LE(9, 0);
    const header = Buffer.alloc(76, 0);
    header.writeUInt32LE(0x4C, 0);
    header.writeUInt32LE(flags, 20);
    return Buffer.concat([header, idList, li, strings, extra]);
  };
  const idListSizeAt = (b) => b.readUInt16LE(76);

  {
    const noArgs = buildLnk({});
    const st = lnk.parse(noArgs);
    ok(st.items.map((i) => i.name).join(',') === 'NAME,WORKING_DIR', '解析出 StringData 存在项', st.items.map((i) => i.name).join(','));
    ok(lnk.readArguments(noArgs) === null, '无参 .lnk 读出 ARGUMENTS = null');

    const withArg = lnk.setArguments(noArgs, '--remote-debugging-port=9222');
    ok(lnk.readArguments(withArg) === '--remote-debugging-port=9222', '插入 ARGUMENTS 后可读回');
    ok((lnk.parse(withArg).flags & 0x20) !== 0, '插入后 HasArguments(0x20) 置位');
    ok(idListSizeAt(withArg) === idListSizeAt(noArgs), '★ IDList 长度字段未被改动（StringData 在它之后，无需回填）');
    ok(withArg.length === noArgs.length + 2 + 28 * 2, '总长度 = 原长 + 2 字节计数 + 28 字符×2', withArg.length + ' vs ' + (noArgs.length + 58));
    ok(lnk.parse(withArg).items.find((i) => i.name === 'NAME').value === 'Probe', '原有 NAME 未被破坏');
    ok(lnk.parse(withArg).extraStart === lnk.parse(noArgs).extraStart + 58, 'ExtraData 起点随之后移（自身 size 字段无需回填）');

    const replaced = lnk.setArguments(withArg, '--remote-debugging-port=9333');
    ok(lnk.readArguments(replaced) === '--remote-debugging-port=9333', '已有 ARGUMENTS 时原位替换');
    ok(replaced.length === withArg.length, '等长替换时总长度不变');

    const ansi = lnk.setArguments(buildLnk({ unicode: false }), '--x=1');
    ok(lnk.readArguments(ansi) === '--x=1', '非 Unicode(ANSI) .lnk 也能写入');
  }

  // ⚠️ 这一段的重点是**不抛异常**：WorkBuddy 托管的 Node 给 fs.rmSync 打了 safe-delete shim，
  // 它会抛 "Error during a 'trash' operation" —— 曾导致真实安装流程中断。removeTree 就是为绕开它而写。
  process.stdout.write('\n[8] 关键路径纯函数（安装/自毁防护/Node 解析）\n');
  const installMod = require('./install.js');
  const resolveNode = require('./resolve-node.js');

  ok(installMod.sameOrNested('C:/a', 'C:/a') === true, 'sameOrNested：同一路径 → true');
  ok(installMod.sameOrNested('C:/a', 'C:/a/b') === true, 'sameOrNested：源包含目标 → true');
  ok(installMod.sameOrNested('C:/a/b', 'C:/a') === true, 'sameOrNested：目标包含源 → true（正是自毁场景）');
  ok(installMod.sameOrNested('C:/a', 'C:/b') === false, 'sameOrNested：无关路径 → false');

  {
    const deep = path.join(dataDir, 'rmtree-probe', 'x', 'y');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'a.txt'), 'a');
    fs.writeFileSync(path.join(dataDir, 'rmtree-probe', 'b.txt'), 'b');
    let threw = null;
    try { installMod.removeTree(path.join(dataDir, 'rmtree-probe')); } catch (e) { threw = e; }
    ok(threw === null, 'removeTree 不抛异常（safe-delete shim 回归）', threw ? threw.message : '');
    ok(!fs.existsSync(path.join(dataDir, 'rmtree-probe')), 'removeTree 真的删干净了');
  }

  ok(resolveNode.majorOf('v22.22.2') === 22, 'majorOf 解析 v 前缀版本');
  ok(resolveNode.majorOf('20.11.0') === 20, 'majorOf 解析无前缀版本');
  ok(resolveNode.majorOf('') === 0, 'majorOf 对空串返回 0（不抛）');
  const nodeOk = resolveNode.currentNodeOk(22);
  ok(nodeOk.ok === true, '当前 Node 满足 ≥22（本项目硬性要求）', process.version);
  ok(typeof resolveNode.resolveNode().exe === 'string', 'resolveNode 能解析出一个 node 路径');

  // ── [9] 版本号一致性（防漂移）─────────────────────────────────────────
  // 起因：v1.1.0 发布时才发现 SKILL.md / STORE.md 还停在 1.0.0，
  //       README 里的安装包文件名也还是旧版本。版本号散在 6 个文件里，靠人记必漂 → 钉死在这里。
  process.stdout.write('\n[9] 版本号一致性\n');
  const pkgVer = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const readT = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  ok(/^\d+\.\d+\.\d+$/.test(pkgVer), 'package.json 版本号格式合法', 'v' + pkgVer);
  ok(readT('core/index.js').includes("PLUGIN_VERSION = '" + pkgVer + "'"), 'core/index.js 的 PLUGIN_VERSION 与 package.json 一致');
  ok(readT('installer/setup.iss').includes('#define MyAppVersion "' + pkgVer + '"'), 'setup.iss 的 MyAppVersion 一致（决定 .exe 文件名）');
  // 面板「关于」页的版本显示：允许带或不带前导 v（页面里用的是变量兜底 + 'v' 前缀拼接），
  // 但**必须**出现这个版本号的字面量 —— 否则就是漏改了。
  const panelSrcForVer = readT('ui/dsh-ui/panel.js');
  ok(panelSrcForVer.includes('v' + pkgVer) || panelSrcForVer.includes("'" + pkgVer + "'") || panelSrcForVer.includes('"' + pkgVer + '"'),
    '面板「关于」页显示的版本一致');
  ok(readT('README.md').includes('workbuddy-wallpaper-setup-' + pkgVer + '.exe'), 'README 里的安装包文件名一致');
  ok(readT('SKILL.md').includes('version: ' + pkgVer), 'SKILL.md 的 version 一致');
  ok(readT('STORE.md').includes('`' + pkgVer + '`'), 'STORE.md 的版本一致');

  // ── [9′] P2-2：两处此前**零断言**的版本号（漏改会静默发错版）──────────────
  // 为什么必须补：其余 7 处改漏了 `verify.js` 立刻红，唯独这两处没有任何东西兜底 ——
  //   ① `release.yml` 的默认 tag：CI 手动触发时用它去找 Release；写错就打到旧 tag 上，
  //      出来的包是旧版本的字节，而 workflow 名字却报成功。
  //   ② `landing/version.json` 的 latest/minSupported：feed 就是靠它告诉客户端"有新版本"。
  //      它停旧版本 = 发了新包但**没人收到更新通知**（最典型的"发布了却没人升级"）。
  process.stdout.write('\n[9′] 版本号断言补齐（release.yml / landing feed）\n');
  // 这里在 [12] 段之前，`upd` 还没定义 —— 单独取一次（Node 的 require 有缓存，不会重复加载）。
  const updVer = require(path.join(ROOT, 'core', 'update.js'));
  const relYml = readT('.github/workflows/release.yml');
  const relDefault = (relYml.match(/default:\s*'([^']+)'/) || [])[1] || null;
  ok(relDefault === 'v' + pkgVer,
    'release.yml 的默认 tag == v' + pkgVer + '（否则手动触发会打到旧 tag）',
    '实际 ' + relDefault);

  let feedJson = null;
  try { feedJson = JSON.parse(readT('landing/version.json')); } catch (e) {
    ok(false, 'landing/version.json 可解析', e.message);
  }
  if (feedJson) {
    // ⚠️ 这里**刻意不要求** feed.latest === package.json 的版本。
    // 开发期本来就该是「代码已升版、feed 还是上一个已发布版本」—— 卡死这个等式会让每次改版前
    // 都红一片，逼得人加旁路。**发版那一刻的相等**由 `verify-live.js` 的第②项守
    // （它拿 feed.latest 和 package.json 的版本硬比，非 0 退出即判发布失败）。
    // 这里守的是另外两件同样致命、却不会自己暴露的事：
    ok(!feedJson.latest || updVer.compareVersions(String(feedJson.latest), pkgVer) <= 0,
      'landing/version.json 的 latest 不高于 package.json（feed 不能承诺代码里还没有的版本）',
      'feed=' + feedJson.latest + ' pkg=' + pkgVer);
    ok(!feedJson.minSupported || !feedJson.latest ||
      updVer.compareVersions(String(feedJson.minSupported), String(feedJson.latest)) <= 0,
      'landing/version.json 的 minSupported ≤ latest（填反会让所有用户被判必须更新）',
      'min=' + feedJson.minSupported + ' latest=' + feedJson.latest);
    // 镜像文件必须与 feed 声明同名 —— 三者（feed.latest / 镜像名 / 实际文件）任一错位都是静默故障：
    // feed 说有更新 → 客户端按镜像名去下 → 404 → 用户看到"更新失败"，却查不出为什么。
    // ⚠️ 比的是 **pathname**，不是整条 URL：静态站地址带 `?sharecode=`（2026-10-21 起），
    //    直接 endsWith 会被 query 骗过去。
    const z = (feedJson.assets && feedJson.assets.zip) || {};
    let mainPath = '';
    try { mainPath = new URL(String(z.url || '')).pathname; } catch (_) {}
    ok(mainPath.endsWith('/workbuddy-wallpaper-' + feedJson.latest + '.bin'),
      'feed 的主源文件名与 latest 对应（workbuddy-wallpaper-<latest>.bin）',
      String(z.url || '(空)'));
  }

  // P2-1 的结构钉：发版脚本的 5 道门禁不许被删掉（删了不会有任何测试变红，只会某天静默发错 feed）
  const feedSrc = readT('scripts/release-feed.js');
  ok(feedSrc.includes('不能高于 latest('),
    '结构钉：release-feed 拒绝 minSupported > latest');
  ok(feedSrc.includes('--min-supported 非法'),
    '结构钉：release-feed 校验 minSupported 合法性');
  ok(feedSrc.includes('notes 过长'),
    '结构钉：release-feed 限制 notes 长度');
  ok(feedSrc.includes('这是降级') && feedSrc.includes('--allow-downgrade'),
    '结构钉：release-feed 拒绝把 latest 往下调（降级保护）');
  ok(feedSrc.includes('产出后自检') && feedSrc.includes('镜像 sha256 与 feed.sha256 不符'),
    '结构钉：release-feed 写完回读自检（字节数/sha256/验签）');

  // ── [9″] 发布目录与站址一致性（2026-10-21 换域名后新增）────────────────────
  // 背景：旧应用被删后平台**不允许原目录再发布**，只能换新目录 `landing-site/` 重新发布。
  // 于是出现两份副本 —— 这正是本项目反复吃过亏的形态。两道防线：
  //   ① `scripts/sync-site.js --check` 严格镜像（下面直接比对两个关键文件）；
  //   ② feed 的「主页地址」与客户端「检查地址」必须同源同 query，否则客户端检查的是另一个站。
  process.stdout.write('\n[9″] 发布目录与站址一致性\n');
  ok(fs.existsSync(path.join(ROOT, 'scripts', 'sync-site.js')), '存在 scripts/sync-site.js（landing/ → landing-site/ 的严格镜像）');
  const siteIdx = path.join(ROOT, 'landing-site', 'index.html');
  if (fs.existsSync(siteIdx)) {
    ok(readT('landing-site/index.html') === readT('landing/index.html'),
      'landing-site/index.html 与 landing/index.html 逐字节一致（改完源要跑 sync-site）');
    ok(readT('landing-site/version.json') === readT('landing/version.json'),
      'landing-site/version.json 与 landing/version.json 逐字节一致');
  } else {
    process.stdout.write('  · 发布目录 landing-site/ 不在本地 → 跳过镜像比对\n');
  }

  // 站址一致性：客户端从 update.json 的 feeds[0] 检查，feed 自己声明的主页是 url。
  // 两者必须同源 + 同 query（这个站每条路径都要 ?sharecode=，漏了就是 403）。
  const updJsonCfg = JSON.parse(readT('update.json'));
  const homepage = String((feedJson && feedJson.url) || '');
  try {
    const h = new URL(homepage);
    const expected = h.origin + '/version.json' + h.search;
    ok(updJsonCfg.feeds[0] === expected,
      'update.json 的 feeds[0] 与 feed 声明的主页同源同 query',
      'feed=' + expected + '  update.json=' + updJsonCfg.feeds[0]);
  } catch (e) {
    ok(false, 'feed 的 url 是合法 URL', e.message);
  }
  ok(/^https:\/\/raw\.githubusercontent\.com\//.test(String((updJsonCfg.feeds || [])[1] || '')),
    'feeds[1] 仍是 GitHub raw 兜底（主源挂掉时才用到）');

  // ── [9‴] 交付工具链：数据导出/导入 · 接口文档防漂 · 注入探针 ──────────────
  process.stdout.write('\n[9‴] 交付工具链（导出导入 / 接口文档 / 注入探针）\n');

  // ① 导出→导入 往返（真实文件系统，不 mock）
  //    只导出用户资产；**绝不能**把 .api-token 这类凭据带进备份包。
  {
    const ex = require('../scripts/export.js');
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'wbwp-exp-'));
    const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'wbwp-imp-'));
    fs.mkdirSync(path.join(src, 'themes', 'standalone'), { recursive: true });
    fs.writeFileSync(path.join(src, 'themes', 'standalone', 'theme.json'), '{"bgScene":true}');
    fs.writeFileSync(path.join(src, 'mask.json'), '{"opacity":0.3}');
    fs.writeFileSync(path.join(src, '.api-token'), 'SHOULD_NOT_LEAK');
    fs.writeFileSync(path.join(src, 'companion.log'), 'x');
    const zp = path.join(os.tmpdir(), 'wbwp-exp-' + process.pid + '.zip');
    try {
      const r1 = ex.exportData({ dataDir: src, out: zp });
      ok(r1.ok && r1.files >= 2, '导出：产出 zip 且至少含 2 个文件', JSON.stringify(r1));
      const raw = fs.readFileSync(zp).toString('latin1');
      ok(!raw.includes('.api-token') && !raw.includes('SHOULD_NOT_LEAK') && !raw.includes('companion.log'),
        '导出：凭据与运行态（.api-token / 日志）不进包');
      const r2 = ex.importData({ zip: zp, dataDir: dst, noBackup: true });
      ok(r2.ok && r2.imported === r1.files, '导入：文件数与导出一致', r2.imported + '/' + r1.files);
      ok(fs.readFileSync(path.join(dst, 'mask.json'), 'utf8') === '{"opacity":0.3}',
        '导入：内容逐字节还原');
      ok(!fs.existsSync(path.join(dst, '.api-token')), '导入：没有把凭据写进目标目录');
    } finally {
      for (const d of [src, dst]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
      try { fs.unlinkSync(zp); } catch (_) {}
    }
  }

  // ①b 主题配方（P0-4.1）：导出只记哈希不内联像素，导入可复现（真实文件系统）
  {
    const rp = require('../scripts/recipe.js');
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'wbwp-recipe-'));
    const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'wbwp-recipe-'));
    // 造一个带背景 + 两帧 + 提示词的主题
    const themeDir = path.join(src, 'themes', 'demo');
    fs.mkdirSync(themeDir, { recursive: true });
    const bg = Buffer.from('fake-bg-pixels-0123456789');
    fs.writeFileSync(path.join(themeDir, 'background.webp'), bg);
    fs.writeFileSync(path.join(themeDir, 'frame-day.webp'), Buffer.from('day-frame'));
    fs.writeFileSync(path.join(themeDir, 'frame-night.webp'), Buffer.from('night-frame'));
    const themeJson = {
      image: 'background.webp',
      recipeName: '星夜列车',
      prompt: 'cyberpunk night train, cinematic, depth of field',
      params: { seed: 42, steps: 28 },
      frames: [{ time: 6, file: 'frame-day.webp' }, { time: 18, file: 'frame-night.webp' }],
      parallax: { enabled: true, amp: 8 },
    };
    fs.writeFileSync(path.join(themeDir, 'theme.json'), JSON.stringify(themeJson));
    const recipeFile = path.join(os.tmpdir(), 'wbwp-recipe-' + process.pid + '.json');
    try {
      const ex = rp.exportRecipe({ dataDir: src, id: 'demo', out: recipeFile });
      ok(ex.ok && ex.recipe.prompt === 'cyberpunk night train, cinematic, depth of field',
        '配方导出：提示词/参数进配方（AI 可复现的输入）');
      ok(ex.recipe.assets.length === 3, '配方导出：素材哈希齐全（背景+2帧）', ex.recipe.assets.length + ' 项');
      const raw = fs.readFileSync(recipeFile, 'utf8');
      ok(!raw.includes('fake-bg-pixels'), '配方导出：不内联像素（只有哈希，体积 KB 级）');
      ok(/sha256/.test(raw) && /frame-day\.webp/.test(raw), '配方导出：素材只记 file+sha256');

      // 导入到全新目录：素材复用（dst 里没有同哈希素材 → missing）
      const im = rp.importRecipe({ dataDir: dst, file: recipeFile, as: 'imported' });
      ok(im.ok && im.created === 'imported', '配方导入：落成新主题目录');
      const t2 = JSON.parse(fs.readFileSync(path.join(dst, 'themes', 'imported', 'theme.json'), 'utf8'));
      ok(t2.prompt === 'cyberpunk night train, cinematic, depth of field' && t2.parallax && t2.frames.length === 2,
        '配方导入：prompt/parallax/frames 还原');
      ok(im.missingAssets === 3, '配方导入：缺素材如实上报（dst 无同哈希素材）', 'missing=' + im.missingAssets);
      // 再导入一次到 src（src 有同哈希素材 → 复用）
      const im2 = rp.importRecipe({ dataDir: src, file: recipeFile, as: 'reused' });
      ok(im2.ok && im2.reusedAssets === 3 && im2.missingAssets === 0,
        '配方导入：本地已有同哈希素材 → 自动复用（省手动补）', 'reused=' + im2.reusedAssets + ' missing=' + im2.missingAssets);
    } finally {
      for (const d of [src, dst]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
      try { fs.unlinkSync(recipeFile); } catch (_) {}
    }
  }

  // ② 接口文档防漂：重新生成的结果必须与磁盘文件一致
  {
    const gen = require('../scripts/gen-api-docs.js');
    let built = null, err = null;
    try { built = gen.build(); } catch (e) { err = e; }
    ok(!!built, '接口文档可生成（每条 ROUTES 都有说明）', err && err.message);
    if (built) {
      const cur = fs.existsSync(gen.OUT) ? fs.readFileSync(gen.OUT, 'utf8') : '';
      ok(cur === built.text,
        'docs/api/接口清单.md 与 routes.js 一致（加了接口没更新文档 → 这里红）',
        '跑 node scripts/gen-api-docs.js 重新生成');
    }
  }

  // ③ 注入探针：入库且判据正确（不依赖 CDP 是否开着）
  {
    const probe = readT('scripts/probe-injection.js');
    ok(probe.includes('wdwCount >= 10') && probe.includes('rootTransparent'),
      '结构钉：注入探针的判据是「元素数 + 吉祥物 + 背景透明」');
    ok(probe.includes('innerHTML 恒为空'), '结构钉：探针里写明「场景是 iframe，innerHTML 恒空」这个易误判点');
    ok(probe.includes('process.exit(out.ok ? 0 : 1)'), '注入探针以退出码表达结论（可进 CI）');
  }

  // ── [10] 卸载路径不允许有交互提问 ─────────────────────────────────────
  // 起因：install.js 的 uninstall() 里原本有个「数据目录要一并删除吗？[y/N]」的交互提问。
  // 卸载器用 `runhidden` 跑 uninstall.cmd，提问窗口看不见、也没人能输入，
  // 而 process.stdin.isTTY 仍为真（继承自控制台）→ fs.readSync(0) 永久阻塞
  // → **用户点「卸载」只看到进度条卡死**。实测卡了 4 分钟以上，得靠任务管理器结束。
  process.stdout.write('\n[10] 卸载路径不阻塞\n');
  const installSrc = readT('scripts/install.js');
  ok(!/function\s+promptYesNo\s*\(/.test(installSrc), 'install.js 里没有交互提问函数（会把隐藏运行的卸载器挂死）');
  ok(!/readSync\(\s*0\s*,/.test(installSrc), 'install.js 里没有对 stdin 的同步读（会永久阻塞）');
  ok(installMod.uninstall.length >= 1, 'uninstall(purgeData) 接受参数：删数据必须显式 --purge-data');

  // ── [11] 背景层特异性：不能被同机第二套注入压掉（2026-10-16 事故回归）────
  // 起因：本机同时跑着 WorkDaddy 的 daemon（127.0.0.1:47832），它经**同一个 CDP 9222**
  //   往 WorkBuddy 窗口注入自己的 `#wbs-theme-style`（131KB），其中也给 `#root` 挂
  //   background-image：90deg 40% 左渐暗 + 180deg 底部渐暗 + 一张内嵌 base64 壁纸。
  //   我们那条 `#root{background:...!important}` 与它**同优先级 (1,0,0)、同样 !important**
  //   → 纯靠「谁后注入谁赢」，而注入顺序取决于两个服务谁先起来 → **偶发**。
  //   实测表现：整张场景壁纸被盖成「偏蓝 + 底部山脉」，用户看到的就是「壁纸没了」。
  // 修法：`#root` / `html,body` 一律挂 `:not(#wdw-noop)` 抬到 (1,1,0)，不看顺序稳赢。
  process.stdout.write('\n[11] 背景层特异性（不被同机第二套注入压掉）\n');
  const cssFor = (theme) => {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'wbwp-css-'));
    const td = path.join(t, 'themes', 'standalone');
    fs.mkdirSync(td, { recursive: true });
    fs.writeFileSync(path.join(td, String(theme.image)), Buffer.from('x'));
    const out = themeCss.resolveBackgroundAssets({
      theme, id: 'standalone', themesDir: path.join(t, 'themes'), port, dataDir: t, log: () => {},
    });
    fs.rmSync(t, { recursive: true, force: true });
    return out.bgCssStr || '';
  };
  const sceneCss = cssFor({ image: 'background.pkg', weId: '3345659324' });
  const imgCss = cssFor({ image: 'background.webp' });
  ok(sceneCss.indexOf('#root:not(#wdw-noop){background:') >= 0, '场景壁纸：#root 带 :not(#wdw-noop) 特异性提升');
  ok(imgCss.indexOf('#root:not(#wdw-noop){background:') >= 0, '图片壁纸：#root 同样带特异性提升');
  ok(!/#root\{background/.test(sceneCss), '没有低特异性的裸 `#root{background` 残留（那会输给同优先级规则）');
  ok(sceneCss.indexOf('html:not(#wdw-noop),body:not(#wdw-noop)') >= 0, 'html/body 也一并抬了特异性');
  ok(String(dshUI.CHROME_CSS).indexOf('#root:not(#wdw-noop){background-image:none') >= 0, 'dsh-ui 的 #root 兜底规则同样抬了特异性');

  // ── [12] 更新机制（离线部分）────────────────────────────────────────────
  // 联网部分（真去拉 feed / 真下载）不放进 CI：CI 里没有稳定的外部源，
  // 端到端另有一份本地起 HTTP 假源跑通 check → apply → rollback 的验证。
  process.stdout.write('\n[12] 更新机制（版本比对 / zip 解压 / 配置 / 目录同步 / 备份）\n');
  const upd = require(path.join(ROOT, 'core', 'update.js'));

  // 版本比对（含「构建元数据不参与优先级」—— 我第一版写成 [-+](.*) 被单测当场抓到）
  const vcases = [
    ['1.1.3', '1.2.0', -1], ['1.2.0', '1.1.3', 1], ['1.2.0', '1.2.0', 0],
    ['v1.2.0', '1.2.0', 0], ['1.2', '1.2.0', 0], ['1.10.0', '1.9.0', 1],
    ['1.2.0-beta.1', '1.2.0', -1], ['1.2.0', '1.2.0-beta.1', 1],
    ['1.2.0+build', '1.2.0', 0], ['bogus', '1.0.0', -1], ['1.0.0', 'bogus', 1], ['', '', 0],
  ];
  const vbad = vcases.filter((c) => upd.compareVersions(c[0], c[1]) !== c[2]);
  ok(vbad.length === 0, 'compareVersions 全部符合预期（预发布/构建元数据/非法串都不抛）',
    vbad.length ? JSON.stringify(vbad) : vcases.length + ' 例');

  // zip 条目名安全化（zip-slip / 绝对路径 / 盘符 / UNC）
  const evilNames = ['../../x', 'a/../../x', '/etc/passwd', 'C:/Windows/x', '\\\\srv\\share\\x', ''];
  ok(evilNames.every((n) => upd.safeEntryName(n) === null), 'zip 条目名拒绝越级 / 绝对路径 / 盘符 / UNC');
  ok(upd.safeEntryName('a/./b/c.txt') === 'a/b/c.txt', 'zip 条目名规范化正常路径');
  ok(upd.crc32(Buffer.from('123456789')) === 0xCBF43926, 'crc32 与标准值一致（0xCBF43926）');

  // 最小 zip 写入器（只为测试解压器；产品侧不需要写 zip）
  const makeZip = (entries) => {
    const locals = [], centrals = [];
    let offset = 0;
    for (const [name, data] of entries) {
      const nameBuf = Buffer.from(name, 'utf8');
      const comp = zlib.deflateRawSync(data);
      const crc = upd.crc32(data);
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
      lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc, 14);
      lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22);
      lh.writeUInt16LE(nameBuf.length, 26);
      locals.push(lh, nameBuf, comp);
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
      ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(crc, 16);
      ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24);
      ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
      centrals.push(ch, nameBuf);
      offset += 30 + nameBuf.length + comp.length;
    }
    const localBuf = Buffer.concat(locals), centralBuf = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralBuf.length, 12); eocd.writeUInt32LE(localBuf.length, 16);
    return Buffer.concat([localBuf, centralBuf, eocd]);
  };
  const zt = fs.mkdtempSync(path.join(os.tmpdir(), 'wbwp-zip-'));
  const helloBuf = Buffer.from('hello 世界\n');
  fs.writeFileSync(path.join(zt, 't.zip'), makeZip([
    ['hello.txt', helloBuf],
    ['sub/中文名.txt', Buffer.from('中文内容')],
  ]));
  const zres = upd.unzipTo(path.join(zt, 't.zip'), path.join(zt, 'out'));
  ok(zres.files === 2, 'zip 解压条目数正确', JSON.stringify(zres));
  ok(fs.readFileSync(path.join(zt, 'out', 'hello.txt')).equals(helloBuf), 'zip 解压内容逐字节一致（含 CRC 校验通过）');
  ok(fs.existsSync(path.join(zt, 'out', 'sub', '中文名.txt')), 'zip 解压保留中文文件名（UTF-8 flag 生效）');
  // 恶意条目：解压时必须**丢弃**，且绝不能写到 destDir 之外
  fs.writeFileSync(path.join(zt, 'evil.zip'), makeZip([['../evil.txt', Buffer.from('pwned')]]));
  const eout = path.join(zt, 'eout');
  const eres = upd.unzipTo(path.join(zt, 'evil.zip'), eout);
  ok(eres.files === 0 && eres.skipped === 1, 'zip 里的越级条目被丢弃（files=0 / skipped=1）', JSON.stringify(eres));
  ok(!fs.existsSync(path.join(zt, 'evil.txt')), '越级条目没有写到 destDir 之外（zip-slip 被挡住）');
  upd.removeTree(zt);

  // 配置优先级：默认 < 包内 update.json < 用户 update.json < 环境变量
  const ct = fs.mkdtempSync(path.join(os.tmpdir(), 'wbwp-cfg-'));
  const c1 = upd.loadConfig({ dataDir: ct });
  ok(Array.isArray(c1.feeds) && c1.feeds.length >= 1, 'loadConfig 读到了随包 update.json 的 feeds', c1.feeds.length + ' 条');
  fs.writeFileSync(path.join(ct, 'update.json'), JSON.stringify({ checkIntervalHours: 1, feeds: ['https://user.example/v.json'] }));
  const c2 = upd.loadConfig({ dataDir: ct });
  ok(c2.checkIntervalHours === 1 && c2.feeds.length === 1 && c2.feeds[0] === 'https://user.example/v.json',
    '用户 <dataDir>/update.json 覆盖包内默认值');
  process.env.WBWP_UPDATE_FEED = 'https://env.example/a.json,https://env.example/b.json';
  const c3 = upd.loadConfig({ dataDir: ct });
  delete process.env.WBWP_UPDATE_FEED;
  ok(c3.feeds.length === 2 && c3.feeds[0] === 'https://env.example/a.json', '环境变量 WBWP_UPDATE_FEED 优先于配置文件');
  process.env.WBWP_UPDATE_OFF = '1';
  const c4 = upd.loadConfig({ dataDir: ct });
  delete process.env.WBWP_UPDATE_OFF;
  ok(c4.disabled === true, 'WBWP_UPDATE_OFF=1 能整体关闭更新检查');

  // feed 结构校验
  ok((() => { try { upd.normalizeFeed({ latest: 'x.y' }, 't'); return false; } catch (_) { return true; } })(),
    'normalizeFeed 拒绝非法 latest');
  const normFeed = upd.normalizeFeed({
    latest: 'v1.2.0',
    assets: { zip: { url: 'u', sha256: 'AB', signature: 'SIG', keyId: 'wbwp-2026a' } },
  }, 't');
  ok(normFeed.latest === '1.2.0' && normFeed.zip.sha256 === 'ab', 'normalizeFeed 规范化版本号与 sha256 大小写');
  ok(normFeed.zip.signature === 'SIG' && normFeed.zip.keyId === 'wbwp-2026a', 'normalizeFeed 解析出 signature 与 keyId');

  // ── P1-1：feed 三件套必填 ──────────────────────────────────────────────
  const feedErr = (zip) => {
    try { upd.normalizeFeed({ latest: '1.2.0', assets: { zip } }, 't'); return ''; } catch (e) { return String(e.message); }
  };
  ok(/sha256/.test(feedErr({ url: 'u', signature: 'S', keyId: 'k' })),
    'P1-1：feed 缺 sha256 → 拒绝（此前是可选项，缺失即跳过完整性校验）');
  ok(/signature/.test(feedErr({ url: 'u', sha256: 'ab', keyId: 'k' })),
    'P1-1：feed 缺 signature → 拒绝');
  ok(/keyId/.test(feedErr({ url: 'u', sha256: 'ab', signature: 'S' })),
    'P1-1：feed 缺 keyId → 拒绝');

  // ── P1-1：apply 的前置检查（缺签名时不该浪费流量去下载）────────────────
  const preflightErr = async (zip) => {
    try {
      await upd.applyUpdate({ dataDir: path.join(os.tmpdir(), 'wbwp-pf-' + process.pid), targetDir: ct, version: '1.0.0', zip });
      return '';
    } catch (e) { return String(e.message); }
  };
  ok((await preflightErr({ url: 'http://127.0.0.1:1/x.bin', sha256: 'ab' })).includes('签名'),
    'P1-1：apply 前置拒绝"缺签名"（不会去下载）');
  ok((await preflightErr({ url: 'http://127.0.0.1:1/x.bin', sha256: 'ab', signature: 'S' })).includes('keyId'),
    'P1-1：apply 前置拒绝"缺 keyId"');
  ok((await preflightErr({ url: 'http://127.0.0.1:1/x.bin', sha256: 'ab', signature: 'S', keyId: 'nope-2030' })).includes('未知的签名密钥'),
    'P1-1：apply 前置拒绝"keyId 未知"');
  ok((await preflightErr({ url: 'http://127.0.0.1:1/x.bin', signature: 'S', keyId: upd.UPDATE_PUBKEYS[0].keyId })).includes('sha256'),
    'P1-1：apply 前置拒绝"缺 sha256"');
  ok(upd.UPDATE_PUBKEYS.some((k) => k.keyId === 'wbwp-2026a'), '内置公钥数组里有 wbwp-2026a');

  // ── P1-2：下载面加固（体积上限 / 跳转白名单 / 跳转次数 / 非 https）──────
  const http = require('http');
  const p2srv = http.createServer((req, res) => {
    if (req.url === '/big') {
      res.on('error', () => {});
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      const chunk = Buffer.alloc(64 * 1024, 1);
      for (let i = 0; i < 40; i++) res.write(chunk);          // 共 2.5 MB
      return res.end();
    }
    if (req.url === '/evil') {
      res.writeHead(302, { location: 'http://evil.example.com/x.bin' });
      return res.end();
    }
    if (req.url === '/loop') {
      res.writeHead(302, { location: '/loop' });
      return res.end();
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => p2srv.listen(0, '127.0.0.1', r));
  const p2base = 'http://127.0.0.1:' + p2srv.address().port;
  const p2dest = path.join(os.tmpdir(), 'wbwp-p2-' + process.pid + '.bin');

  let eBig = null;
  try { await upd.downloadTo(p2base + '/big', p2dest, { maxBytes: 512 * 1024 }); } catch (e) { eBig = e; }
  ok(!!eBig && /过大/.test(eBig.message), 'P1-2：超过体积上限 → 中止下载');
  ok(!fs.existsSync(p2dest), 'P1-2：中止后没有生成目标文件');
  ok(!fs.existsSync(p2dest + '.part'), 'P1-2：中止后 .part 临时文件已删除（Windows 句柄已关）');

  let eEvil = null;
  try { await upd.downloadTo(p2base + '/evil', p2dest, {}); } catch (e) { eEvil = e; }
  ok(!!eEvil && /白名单外的 host|非 https/.test(eEvil.message), 'P1-2：跳转到白名单外 host → 拒绝');

  let eLoop = null;
  try { await upd.downloadTo(p2base + '/loop', p2dest, {}); } catch (e) { eLoop = e; }
  ok(!!eLoop && /重定向过多/.test(eLoop.message), 'P1-2：重定向绕圈 → 拒绝（原来是无限递归）');

  let eHttp = null;
  try { await upd.downloadTo('http://example.com/x.bin', p2dest, {}); } catch (e) { eHttp = e; }
  ok(!!eHttp && /非 https/.test(eHttp.message), 'P1-2：非 https 的下载源 → 拒绝（不会真的发请求）');

  ok(upd.maxDownloadBytes(0) === 8 * 1024 * 1024, 'P1-2：体积上限下限 = 8 MB');
  ok(upd.maxDownloadBytes(3 * 1024 * 1024) === 12 * 1024 * 1024, 'P1-2：体积上限 = 4×feed.size（当它 > 8MB 时）');
  p2srv.close();

  // syncTree：覆盖已有 + 新增 + 删除多余 + 清空目录
  const st1 = fs.mkdtempSync(path.join(os.tmpdir(), 'wbwp-sync-'));
  const sSrc = path.join(st1, 'src'), sDst = path.join(st1, 'dst');
  fs.mkdirSync(path.join(sSrc, 'a'), { recursive: true });
  fs.writeFileSync(path.join(sSrc, 'a', 'keep.txt'), 'new');
  fs.writeFileSync(path.join(sSrc, 'added.txt'), 'added');
  fs.mkdirSync(path.join(sDst, 'a'), { recursive: true });
  fs.writeFileSync(path.join(sDst, 'a', 'keep.txt'), 'old');
  fs.writeFileSync(path.join(sDst, 'gone.txt'), 'gone');
  fs.mkdirSync(path.join(sDst, 'emptydir'), { recursive: true });
  const sy = upd.syncTree(sSrc, sDst);
  ok(fs.readFileSync(path.join(sDst, 'a', 'keep.txt'), 'utf8') === 'new', 'syncTree 覆盖已存在文件');
  ok(fs.existsSync(path.join(sDst, 'added.txt')), 'syncTree 新增缺失文件');
  ok(!fs.existsSync(path.join(sDst, 'gone.txt')), 'syncTree 删除目标里多余的文件');
  ok(!fs.existsSync(path.join(sDst, 'emptydir')), 'syncTree 清掉变空的目录');
  ok(sy.written === 2 && sy.removed === 1, 'syncTree 计数正确', JSON.stringify(sy));
  upd.removeTree(st1);

  // 备份列表与裁剪（按 mtime 从新到旧，保留最近 N 份）
  const bt = fs.mkdtempSync(path.join(os.tmpdir(), 'wbwp-bak-'));
  ['1.0.0', '1.0.1', '1.0.2'].forEach((v, i) => {
    const d = path.join(upd.versionsDir(bt), v);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ version: v }));
    const t = 1700000000 + i * 60;
    fs.utimesSync(d, t, t);
  });
  const bl = upd.listBackups(bt);
  ok(bl.length === 3 && bl[0].version === '1.0.2', 'listBackups 按时间从新到旧', bl.map((b) => b.version).join(','));
  const dropped = upd.pruneBackups(bt, 2);
  const bl2 = upd.listBackups(bt);
  ok(bl2.length === 2 && dropped.join(',') === '1.0.0', 'pruneBackups 只留最近 N 份并返回被删的',
    '删除 ' + dropped.join(',') + '；剩余 ' + bl2.map((b) => b.version).join(','));
  upd.removeTree(bt);

  // 接线检查（这些是「漏接就静默失效」的地方，值得钉住）
  const routesSrc = readT('server/routes.js');
  ok(['/api/update', '/api/update/check', '/api/update/apply', '/api/update/rollback']
    .every((p) => routesSrc.includes("'" + p + "'")), '四条 /api/update* 路由都在 routes.js');
  const startSrc = readT('scripts/start-ui.js');
  ok(startSrc.includes('startUpdateLoop(dir)') && startSrc.includes('startUpdateLoop'), 'start-ui.js 挂上了更新检查循环');

  // 结构钉：单实例锁必须验「映像名」，不能只看 pid。Windows 会回收 pid ——
  // 2026-10-20 事故：死掉的看门狗占用的 pid 4316 被 svchost.exe 复用，之后每次启动都判
  // 「已有 companion 在跑」直接退出，壁纸静默停机两天；而 --stop-watchdog 还会 taskkill 到 svchost。
  const compSrc = readT('scripts/companion.js');
  ok(compSrc.includes('function companionAlive(') && compSrc.includes('proc.nodePidAlive(') &&
    readT('core/proc.js').includes('function imageName('),
    '结构钉：看门狗判活经 core/proc.js 的「映像名」判定（防 pid 回收）');
  ok(compSrc.includes('companionAlive(old)') && !compSrc.includes('pidAlive(old)'),
    '结构钉：acquireLock 用 companionAlive(old)，不再裸用 pidAlive(old)');
  ok(compSrc.includes('companionAlive(pid)'),
    '结构钉：stopWatchdogCmd 也走 companionAlive（否则会 taskkill 到被回收 pid 的无关进程）');

  // ── 修复计划 D1-D5：pid 回收这一类的全量清扫 ────────────────────────────
  const procx = require('../core/proc.js');
  ok(procx.pidAlive(process.pid) === true && procx.nodePidAlive(process.pid) === true,
    'proc：当前 node 进程被判定为"我们的进程"',
    'platform=' + process.platform + ' pid=' + process.pid +
    ' pidAlive=' + procx.pidAlive(process.pid) + ' imageName=' + procx.imageName(process.pid));
  // 反例要选一个「**活着、但不是 node**」的进程 —— 正是 pid 回收事故的形态。
  // Windows：PID 4 = System（永远在）；POSIX：父进程（shell，不是 node；CI 上 /proc/4 不一定可读）。
  const otherPid = procx.IS_WIN ? 4 : process.ppid;
  ok(procx.pidAlive(otherPid) === true && procx.nodePidAlive(otherPid) === false,
    'proc：活着的非 node 进程（pid=' + otherPid + '）不被误判为我们的进程');
  ok(procx.imageName(otherPid) !== null && !/^node(js)?(\.exe)?$/.test(String(procx.imageName(otherPid))),
    'proc：imageName 能读出映像名（实得 ' + procx.imageName(otherPid) + '）');
  ok(compSrc.includes('HB_STALE_MS') && compSrc.includes('touchHeartbeat()'),
    '结构钉：看门狗锁判活加了心跳（node.exe + 心跳 < 90s）');
  ok(!compSrc.includes('pid && pidAlive(pid)'),
    '结构钉：companion.js 不再拿 .ui.pid 判服务存活（改用 47851 端口）');
  ok(compSrc.includes('const live = portListening(DEFAULT_PORT)'),
    '结构钉：stopService / ensureService 以端口为准');
  // 端口来源必须两端一致：`start-ui` 认 WBWP_PORT，看门狗也必须认，
  // 且拉起子进程时**显式传 --port**。否则用户改了端口 → 看门狗永远判"服务没起来"
  // → 每 tick 重复拉起 + 误清 .ui.pid（"改了端口反而更不稳"就是这么来的）。
  const startSrcPort = readT('scripts/start-ui.js');
  ok(startSrcPort.includes('process.env.WBWP_PORT'),
    '结构钉：start-ui 的默认端口支持 WBWP_PORT 覆盖');
  ok(compSrc.includes('Number(process.env.WBWP_PORT) || 47851'),
    '结构钉：看门狗的 DEFAULT_PORT 与 start-ui 同源（WBWP_PORT）');
  ok(compSrc.includes("'--port', String(DEFAULT_PORT)"),
    '结构钉：看门狗拉起服务时显式传 --port');
  ok(!compSrc.includes('portDownStreak'),
    '结构钉：整段「假死 → taskkill .ui.pid」已删除（那是误杀的来源）');
  const updSrc2 = readT('core/update.js');
  ok(updSrc2.includes('nodePidAlive') && updSrc2.includes('.companion.hb'),
    '结构钉：update.js 的看门狗判活也用 node + 心跳（否则更新后可能不重启服务）');
  const panelSrc = readT('ui/dsh-ui/panel.js');
  ok(panelSrc.includes("data-act=\"check-update\"") && panelSrc.includes("data-act=\"apply-update\"") &&
    panelSrc.includes("data-act=\"rollback\""), '面板「关于」页有 检查 / 立即更新 / 回滚 三个动作');
  ok(panelSrc.includes("req('/api/update')") && panelSrc.includes("'/api/update/check'") &&
    panelSrc.includes("'/api/update/apply'") && panelSrc.includes("'/api/update/rollback'"),
    '面板四个更新接口都接上了');

  // ── 适配回归钉（2026-10-28 多尺寸/多 DPI 审计后补：7 组视口 × 7 个页面全量扫描发现的回退点）──
  ok(/\.p-btn\{[^}]*white-space:nowrap[^}]*flex:0 0 auto/.test(panelSrc),
    '适配钉：.p-btn 必须 nowrap + 不收缩（中文标签在 .p-row 里会被压成竖排两行，「上传/扫描/关闭壁纸」曾全尺寸复现）');
  ok(panelSrc.includes('top:34px') && panelSrc.includes('height:calc(100vh - 46px)'),
    '适配钉：面板顶部必须让开宿主窗口控制按钮（top:34px，否则面板盖住最小化/关闭按钮）');
  ok(panelSrc.includes('data-act="close"') && panelSrc.includes("a === 'close'"),
    '适配钉：面板头部要有 ✕ 关闭按钮且动作已分发（此前只能再点吉祥物或按 Esc）');
  ok(panelSrc.includes('.p-row>.p-hint.p-tag{flex:0 0 auto;white-space:nowrap}'),
    '适配钉：短状态标签走 .p-tag nowrap；长说明不得一刀切 nowrap（会把按钮顶出面板，实测 +54px 横向滚动）');
  ok(panelSrc.includes('.p-body{flex:1 1 auto;min-height:0;overflow-y:auto'),
    '适配钉：面板主体是唯一滚动容器（min-height:0 不能删，否则 flex 子项撑破面板）');
  ok(panelSrc.includes('filter(passFilter).length'),
    '适配钉：库计数按筛选后计数（曾恒等于总数 ⇒ 场景14/视频1/图片0 都显示「15 项」）');
  ok(readT('core/store.js').includes('currentTitle') && readT('core/store.js').includes('weId:'),
    '适配钉：/api/wallpapers 回传 weId + currentTitle（缺则「当前壁纸」永远显示 —，卡片无使用中标记）');
  const updCfg = JSON.parse(readT('update.json'));
  ok(Array.isArray(updCfg.feeds) && updCfg.feeds.length >= 1 && /^https:\/\//.test(updCfg.feeds[0]),
    'update.json 配了更新源且主源是 https', updCfg.feeds[0]);
  ok(fs.existsSync(path.join(ROOT, 'scripts', 'release-feed.js')), '发版脚本 scripts/release-feed.js 存在');

  // ⭐ 这条是回归钉：真实服务经 HTTP 报的 currentVersion 必须是 package.json 的版本。
  //    踩过：routes.js 原本直接取 ctx.version，而 standalone 传进来的是插件命名空间
  //    （值就是 "standalone"）→ 版本比对永远判「有更新」，每个用户都会看到升不完的新版本。
  const apiUpd = await J(BASE + '/api/update', { headers: TK });
  ok(apiUpd && apiUpd.ok === true, 'GET /api/update 返回 ok');
  ok(apiUpd && apiUpd.currentVersion === pkgVer,
    'HTTP 报的 currentVersion === package.json 的版本（不是插件命名空间）',
    'api=' + (apiUpd && apiUpd.currentVersion) + ' pkg=' + pkgVer);

  // ⭐ 回归钉（2026-10-21 真机自更新后才发现）：**缓存不能覆盖实时状态**。
  //    原实现 `Object.assign({currentVersion: 实时}, 缓存结果)` —— 缓存里的旧 currentVersion
  //    会把实时值盖掉：更新成功、服务重启后，面板仍显示「有新版本」，而且 hasUpdate 永远停在
  //    检查那一刻的结论。用户看到的就是一个永远升不完的版本。
  {
    const stalePath = path.join(dataDir, 'update-cache.json');
    const backupCache = fs.existsSync(stalePath) ? fs.readFileSync(stalePath, 'utf8') : null;
    fs.writeFileSync(stalePath, JSON.stringify({
      lastCheckAt: Date.now() - 5000,
      etag: null,
      source: 'stale-test',
      result: {
        ok: true,
        currentVersion: '0.0.1',           // ← 陈旧：更新前的版本
        latest: pkgVer,                     // 与当前实际版本相同 ⇒ 不该再报"有更新"
        minSupported: '0.0.1',
        hasUpdate: true,
        mustUpdate: true,
        canUpdate: true,
        notes: 'stale',
        zip: { url: 'https://example.com/x.bin' },
      },
    }));
    const st = await J(BASE + '/api/update', { headers: TK });
    ok(st && st.currentVersion === pkgVer,
      '缓存里的旧 currentVersion 不会覆盖实时版本（更新后不会显示"升不完的新版本"）',
      'api=' + (st && st.currentVersion) + ' cache=0.0.1 pkg=' + pkgVer);
    ok(st && st.hasUpdate === false,
      'hasUpdate 用实时版本重算（latest === 当前版本 → 无更新）',
      'api=' + (st && st.hasUpdate));
    if (backupCache !== null) fs.writeFileSync(stalePath, backupCache);
    else { try { fs.unlinkSync(stalePath); } catch (_) {} }
  }

  // ── P1-3：本地接口鉴权（令牌 + Origin 双保险）────────────────────────────
  // 用 http.request 而不是 fetch：浏览器语境里 Origin 是受禁头，fetch 可能把它剥掉；这里必须真设上。
  const rawReq = (p0, headers, method) => new Promise((resolve) => {
    const rq = require('http').request(
      { host: '127.0.0.1', port, path: p0, method: method || 'GET', headers: headers || {} },
      (rs) => { rs.resume(); resolve({ status: rs.statusCode }); }
    );
    rq.on('error', () => resolve({ status: 0 }));
    rq.end();
  });
  ok((await rawReq('/api/update')).status === 401, 'P1-3：不带令牌访问 /api/update → 401（原先完全裸奔）');
  ok((await rawReq('/api/update', { 'x-wbwp-token': 'bogus-token' })).status === 401, 'P1-3：错误令牌 → 401');
  ok((await rawReq('/api/update', TK)).status === 200, 'P1-3：带正确令牌 → 200');
  ok((await rawReq('/api/update', { origin: 'https://evil.example.com', 'x-wbwp-token': apiToken })).status === 403,
    'P1-3：恶意 Origin（即便令牌正确）→ 403 —— 浏览器里的任意网页被挡在门外');
  ok((await rawReq('/api/update', { origin: 'null', 'x-wbwp-token': apiToken })).status === 200,
    'P1-3：file:// 页面的 Origin: null + 正确令牌 → 200（注入面板可用）');
  ok((await rawReq('/api/update/check', { origin: 'null' }, 'OPTIONS')).status === 204, 'P1-3：受信来源的预检 → 204');
  ok((await rawReq('/api/update/check', { origin: 'https://evil.example.com' }, 'OPTIONS')).status === 403,
    'P1-3：恶意来源的预检 → 403');
  ok((await rawReq('/api/wallpapers')).status === 200, 'P1-3：非受保护接口（/api/wallpapers）不需要令牌，未误伤');
  ok(fs.existsSync(path.join(dataDir, '.api-token')), 'P1-3：令牌已持久化到 <dataDir>/.api-token（重启不换，页面不会突然 401）');
  ok(!readT('server/standalone.js').includes("setHeader('Access-Control-Allow-Origin', '*')"),
    '结构钉：standalone.js 不再无条件 ACAO:*');
  ok(readT('ui/dsh-ui/panel.js').includes('x-wbwp-token'), '结构钉：面板 req() 带上了 x-wbwp-token');
  ok(readT('scripts/start-ui.js').includes('apiToken: started.apiToken'),
    '结构钉：start-ui 注入时把令牌送进 payload');
  ok(apiUpd && Array.isArray(apiUpd.feeds) && apiUpd.feeds.length >= 1, 'HTTP 回显生效的更新源');

  // ── P0-1 回归钉：更新包带一层顶层目录前缀 ──────────────────────────────────
  //    踩过（2026-10-16 审计）：release 包由 `git archive --prefix=workbuddy-wallpaper/` 打出，
  //    实测 87/87 条目都带这个顶层前缀、根下没有 package.json；而 applyUpdate 原本直接读
  //    `staging/package.json` → 冒烟校验必抛「包内版本(undefined) 与目标版本(x) 不一致」
  //    ⇒ **用户点「立即更新」100% 失败**。
  //    ⚠️ 为什么之前没测出：本地 e2e 用的是**自造的无前缀合成 zip** ⇒ 假绿。
  //       教训：合成样本只能验分支，不能验协议对接；真包验证见 `_tmp/e2e-apply-realzip.js`。
  {
    const er = fs.mkdtempSync(path.join(os.tmpdir(), 'wbwp-er-'));
    const mk = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };

    mk(path.join(er, 'plain', 'package.json'), '{"version":"1.0.0"}');
    ok(upd.effectiveRoot(path.join(er, 'plain')) === path.join(er, 'plain'),
      '有效根：根下直接有 package.json → 用根');

    mk(path.join(er, 'pref', 'workbuddy-wallpaper', 'package.json'), '{"version":"1.0.0"}');
    ok(upd.effectiveRoot(path.join(er, 'pref')) === path.join(er, 'pref', 'workbuddy-wallpaper'),
      '有效根：单层顶层目录前缀 → 下沉一层（发布包就是这种）');

    fs.mkdirSync(path.join(er, 'two', 'd1'), { recursive: true });
    fs.mkdirSync(path.join(er, 'two', 'd2'), { recursive: true });
    mk(path.join(er, 'two', 'd1', 'package.json'), '{"version":"1.0.0"}');
    ok(upd.effectiveRoot(path.join(er, 'two')) === path.join(er, 'two'),
      '有效根：多个子目录 → 用根（交给冒烟校验报错，不猜）');

    mk(path.join(er, 'lonely', 'x', 'readme.md'), 'x');
    ok(upd.effectiveRoot(path.join(er, 'lonely')) === path.join(er, 'lonely'),
      '有效根：单目录里没有 package.json → 用根');

    // 结构钉：冒烟校验与覆盖都必须走「有效根」，不能再直接摸解压目录根
    const updSrc = readT('core/update.js');
    ok(/readJsonSafe\(\s*path\.join\(root,\s*'package\.json'\)/.test(updSrc),
      'applyUpdate 的包内版本校验读的是 root（不是解压目录根）');
    ok(!/readJsonSafe\(\s*path\.join\(staging,\s*'package\.json'\)/.test(updSrc),
      '已经不再直接读 staging/package.json（那就是 v1.2.0 的死路）');
    ok(/syncTree\(\s*root,\s*targetDir\s*\)/.test(updSrc),
      '覆盖同步从有效根开始（syncTree(root, targetDir)）');

    upd.removeTree(er);
  }

  // ── P0-5 单飞锁 + P0-6 尊重「关闭壁纸」────────────────────────────────────
  //    踩过（2026-10-16 审计）：检查是**定时**触发的、更新是**手动**点的，两者可能同时进来，
  //    而当时没有任何锁 → 撞同一个 staging / 备份目录 / 缓存文件。
  //    又：scheduleRestart 原本不看 `.stopped`，用户点过「关闭壁纸」也会被重新拉起。
  {
    const lk = fs.mkdtempSync(path.join(os.tmpdir(), 'wbwp-lock-'));
    const l1 = upd.acquireUpdateLock(lk);
    ok(fs.existsSync(l1), '更新锁：能取到锁（.lock 原子创建）');
    let dup = null;
    try { upd.acquireUpdateLock(lk); } catch (e) { dup = e; }
    ok(!!dup && /正在进行/.test(dup.message), '更新锁：同一 dataDir 第二次取锁被拒绝', dup && dup.message);
    upd.releaseUpdateLock(l1);
    const l2 = upd.acquireUpdateLock(lk);
    ok(!!l2, '更新锁：释放后可以再次取到');
    upd.releaseUpdateLock(l2);

    const lp = path.join(lk, 'update', '.lock');
    fs.writeFileSync(lp, JSON.stringify({ pid: 999999999, ts: Date.now() }));
    const l3 = upd.acquireUpdateLock(lk);
    ok(!!l3, '更新锁：陈旧锁（持有者进程不存在）可被接管');
    upd.releaseUpdateLock(l3);

    fs.writeFileSync(lp, JSON.stringify({ pid: process.pid, ts: Date.now() - 60 * 60 * 1000 }));
    const l4 = upd.acquireUpdateLock(lk);
    ok(!!l4, '更新锁：陈旧锁（超过 staleMs）即使进程活着也可被接管');
    upd.releaseUpdateLock(l4);

    ok(upd.pidAlive(process.pid) === true, 'pidAlive：当前进程判定为存活');
    ok(upd.pidAlive(999999999) === false, 'pidAlive：不存在的 pid 判定为不存活');

    // P0-6：`.stopped` 存在时**不得**拉起服务（这一条必须早返回，否则会真的 spawn 一个看门狗）
    const sd = fs.mkdtempSync(path.join(os.tmpdir(), 'wbwp-stop-'));
    fs.writeFileSync(path.join(sd, '.stopped'), 'closed by user');
    const rr = upd.scheduleRestart({ dataDir: sd, delayMs: 1 });
    ok(rr === 'skipped-stopped', 'P0-6：用户点过「关闭壁纸」→ scheduleRestart 不拉起服务', String(rr));
    upd.removeTree(sd);

    const updSrc2 = readT('core/update.js');
    ok(/acquireUpdateLock\(opts\.dataDir\)/.test(updSrc2), '结构钉：applyUpdate 入口先取单飞锁');
    ok(/applyUpdateUnlocked/.test(updSrc2), '结构钉：加锁后调用真正的实现（applyUpdateUnlocked）');
    ok(/\.stopped/.test(updSrc2), '结构钉：scheduleRestart 读了 .stopped');

    upd.removeTree(lk);
  }

  // ── P0-2 / P0-4 回归钉：静态站放不下压缩包后缀（WAF 拦截）──────────────────
  //    实测（2026-10-17）：该静态站前置 WAF 按 URL 后缀拦截 .zip/.gz/.tar/.7z/.rar，
  //    一律 403「WAF拦截页面」，**与文件是否存在无关**。
  //    v1.2.0 把更新包镜像成 .zip 放在那儿 → 用户点「立即更新」拿到的是 WAF 的 HTML。
  //    这几条直接检查**产物**，因为当初的错就是产物错。
  {
    const lv = JSON.parse(readT('landing/version.json'));
    const blocked = /\.(zip|gz|tgz|tar|7z|rar|bz2|xz)$/i;
    ok(!!lv.assets && !!lv.assets.zip, 'landing/version.json 有 assets.zip 段');
    ok(!blocked.test(lv.assets.zip.url),
      '★ feed 的**主源**地址不是压缩包后缀（静态站会 403），实为 ' + lv.assets.zip.url.split('/').pop());
    ok((lv.assets.zip.mirrors || []).every((u) => /^https:\/\//.test(u)),
      'feed 的兜底源都是 https');
    ok(Number(lv.assets.zip.size) > 0 && /^[0-9a-f]{64}$/.test(String(lv.assets.zip.sha256)),
      'feed 里带了 size 与 64 位 sha256');

    // 镜像文件名必须与版本对应（这条不依赖产物，CI 里也能验）
    // ⚠️ 用 URL 的 pathname 取文件名，不能直接 basename 整条 URL —— 带 query 时会把 `?sharecode=…` 也带进来
    let mirrorName = '';
    try { mirrorName = new URL(String(lv.assets.zip.url)).pathname.split('/').pop(); } catch (_) {}
    ok(mirrorName === 'workbuddy-wallpaper-' + lv.latest + '.bin',
      '主源文件名 = workbuddy-wallpaper-<latest>.bin（实为 ' + mirrorName + '）');

    // ⚠️ 镜像文件本身是**构建产物**（landing/.gitignore 排除）→ 干净检出（CI）里必然不存在。
    //    所以这里只做**条件式**强校验：本地有就逐字节核对，没有就明确跳过、交给线上守门。
    //    （第一版写成无条件断言"文件必须在"，CI 四个矩阵全红 —— 断言自己写错了。）
    const mirrorPath = path.join(ROOT, 'landing', mirrorName);
    if (fs.existsSync(mirrorPath)) {
      const got = require('crypto').createHash('sha256').update(fs.readFileSync(mirrorPath)).digest('hex');
      ok(got === String(lv.assets.zip.sha256),
        '本地镜像文件的 sha256 == feed.sha256');
    } else {
      process.stdout.write('  · 镜像文件不在本地（构建产物，未入 git）→ 这条由 verify-live 在线上把关\n');
    }

    const rf = readT('scripts/release-feed.js');
    ok(/MIRROR_NAME/.test(rf) && /test\(MIRROR_NAME\)/.test(rf),
      '结构钉：发版脚本里有"镜像名不得是压缩包后缀"的守卫');
    ok(fs.existsSync(path.join(ROOT, 'scripts', 'verify-live.js')),
      '线上守门脚本 scripts/verify-live.js 存在（发布后必须跑）');
    const vl = readT('scripts/verify-live.js');
    ok(/process\.exit\(fail \? 1 : 0\)/.test(vl),
      '结构钉：verify-live 以非 0 退出表示"发布失败"（闸门要有牙齿）');
  }

  // ── 自我进化机制（evolve）：边界比功能重要，全部离线断言 ──────────────────
  {
    const evoCfg = JSON.parse(readT('evolve.config.json'));
    ok(Array.isArray(evoCfg.goals) && evoCfg.goals.length >= 5 && Array.isArray(evoCfg.sources) && evoCfg.sources.length >= 3,
      'evolve 配置：目标 ≥5 且数据源 ≥3（少于这个量判断没有意义）');
    ok(!!evoCfg.self && evoCfg.sources.some((s) => s.repo === evoCfg.self),
      'evolve 配置：声明了 self 仓库（自家发版必须能被识别，否则会淹没外部信号）');

    const evoApply = require(path.join(ROOT, 'core', 'evolve', 'apply.js'));
    ok(evoApply.classifyPath('docs/evolve/backlog.md', evoCfg.apply).ok,
      'evolve 边界：docs/ 下可直接写');
    ok(!evoApply.classifyPath('../etc/passwd', evoCfg.apply).ok && !evoApply.classifyPath('C:/Windows/x.md', evoCfg.apply).ok,
      'evolve 边界：.. 与绝对路径一律拒（路径穿越）');
    ok(!evoApply.classifyPath('core/store.js', evoCfg.apply).ok && !evoApply.classifyPath('ui/dsh-ui/panel.js', evoCfg.apply).ok,
      'evolve 边界：core/ 与 ui/ 不在白名单 —— 代码永远不自动改');
    ok(!evoApply.classifyPath('docs/x.pem', evoCfg.apply).ok && !evoApply.classifyPath('.git/config', evoCfg.apply).ok,
      'evolve 边界：密钥类扩展名与 .git/ 硬拒');

    const evoRank = require(path.join(ROOT, 'core', 'evolve', 'rank.js'));
    const fake = [
      { id: 'a', title: 'Electron 45 has been released', text: 'includes upgrades to Chromium 156 and Node v24', ts: Date.now() - 86400000, sourceKind: 'rss', source: 's', url: 'u1' },
      { id: 'b', title: 'v1.2.3 v1.2.3', text: 'workbuddy wallpaper release', ts: Date.now(), sourceKind: 'repo-release', source: 's', url: 'u2', own: true },
      { id: 'c', title: 'x', text: 'y', ts: Date.now(), sourceKind: 'hn', source: 's', url: 'u3' },
    ];
    const rk = evoRank.rank(fake, evoCfg, { now: Date.now() });
    ok(rk.kept.some((k) => k.id === 'a' && k.kind === 'compat'),
      'evolve 打分：宿主升级类被识别为 compat（要复测 Chromium 行为）');
    ok(!rk.kept.some((k) => k.id === 'b'), 'evolve 打分：自家发版不入候选（own-release 剔除）');
    ok(rk.dropped.some((d) => d.item && d.item.id === 'c'), 'evolve 打分：信息量不足的条目被丢弃');

    const evoPlan = require(path.join(ROOT, 'core', 'evolve', 'plan.js'));
    const evoOps = evoPlan.buildOps(rk.kept, { id: 'EV-TEST' });
    ok(evoOps.length === 1 && evoOps[0].op === 'append-doc' && /^docs\//.test(evoOps[0].file),
      'evolve 方案：自动可应用的操作只有 append-doc 到 docs/（代码改动永远只出建议）');
    ok(evoApply.precheck(ROOT, { id: 'EV-TEST', ops: [{ op: 'append-doc', file: 'core/x.js', body: 'x' }] }, evoCfg, {}).ok === false,
      'evolve 预检：越界目标在 dryRun 之前就被拒（不会出现"先备份再失败"）');
  }

  // ── 页面型内容的可读面（2026-10-28「资料库像图片裂了」事故的回归钉）──
  {
    const themeSrc = readT('core/theme-css.js');
    ok(themeSrc.includes('wb-home-page-pc') && themeSrc.includes('rgba(13,15,20,.97)'),
      '可读面钉子：资料库/知识库页必须有实底（.97）—— 6% 白盖不住亮壁纸，壁纸图案会从卡片中间穿出来');
    ok(!/'\[class\*="wb-home-guide-card"\]' \+ X/.test(themeSrc),
      '可读面钉子：卡片底色只能用 -card-pc，宽匹配会把 -title-pc/-desc-pc 一起上色（文字底下出现浅色方块）');
    ok(!/wb-home-page-pc[^\n]*backdrop-filter/.test(themeSrc),
      '可读面钉子：大面板不许加 backdrop-filter —— 实测 18px 模糊让 GPU 进程从 425% 涨到 629%（≈2 核）');
    // ── 2026-10-29「报告卡片背后一片死黑」回归钉 ──
    ok(themeSrc.includes('automation-run-group__item automation-run-group__item--') && themeSrc.includes('rgba(13,15,20,.62)'),
      '报告卡片钉子：定时任务报告页 automation-run-group__item 必须半透明化（宿主原生 rgb(10,10,10) 不透明底会把壁纸盖死）');
    ok(!/automation-run-group__item[^\n]*backdrop-filter/.test(themeSrc),
      '报告卡片钉子：automation 卡片同样不许加 backdrop-filter（GPU 代价）');
  }

  // ── 面板层级（2026-10-29「面板在特定场景错位」回归钉）──
  {
    const panelSrc = readT('ui/dsh-ui/panel.js');
    ok(/z-index:1500/.test(panelSrc),
      '面板层级钉子：面板 z 必须 > 宿主右缘历史导航栏(1100)，否则导航栏按钮从面板上穿透像错位');
    ok(!/z-index:997/.test(panelSrc),
      '面板层级钉子：旧值 997 不许回来（< 1100 必穿透）');
  }

  // ── 性能护栏（P0-3.x，2026-10-29）：把「已踩的 GPU/性能坑」固化，防未来加功能重踩 ──
  {
    const themeSrc = readT('core/theme-css.js');
    const panelSrc = readT('ui/dsh-ui/panel.js');
    const bgSrc = readT('ui/background.js');
    // ① backdrop-filter 禁令：历史实测 18px 模糊让 GPU 进程 425% → 629%（≈多烧 2 核）。
    //    大面板 / 大卡片 / 页面级容器都不许加。白名单：只有小面积输入框/弹层可用（chat-input 等）。
    ok(!/wb-home-page-pc[^\n]*backdrop-filter/.test(themeSrc),
      '性能护栏：页面级容器（wb-home-page-pc）禁 backdrop-filter（实测 GPU 425%→629%）');
    ok(!/knowledge-sidebar-pc[^\n]*backdrop-filter/.test(themeSrc),
      '性能护栏：知识库左栏禁 backdrop-filter（大面板代价不划算）');
    ok(!/automation-run-group__item[^\n]*backdrop-filter/.test(themeSrc),
      '性能护栏：报告卡片禁 backdrop-filter（GPU 代价）');
    // ② 面板本体只允许**一处** backdrop-filter（.wdw 面板根），其余大面积元素不得再加
    const panelBf = (panelSrc.match(/backdrop-filter/g) || []).length;
    ok(panelBf <= 2, '性能护栏：面板 backdrop-filter 数量 ≤2（根+输入框），大面积元素再加会把 GPU 顶起来');
    // ③ 视差只改 transform（合成器层），不许引入 will-change 到整个背景根 / 触发 layout 的 width/height 动画
    ok(/translate3d/.test(bgSrc) && !/background[^\n]*will-change:left/.test(bgSrc),
      '性能护栏：视差只走 translate3d（合成器层，不触发重排重绘）');
    ok(!/wdw-bg-fx[^\n]*backdrop-filter/.test(bgSrc),
      '性能护栏：昼夜循环多帧层禁 backdrop-filter（全屏层，加 blur 等于给整屏套毛玻璃）');
    // ④ 昼夜循环用 setInterval 分钟级 + opacity 过渡，禁 requestAnimationFrame 全帧跑（空转烧 CPU）
    ok(/setInterval\(paint, 60000\)/.test(bgSrc),
      '性能护栏：昼夜循环用 60s 低频重算，不得 rAF 全帧空转');
  }

  // ── 注入可观测性（2026-10-28「开机 45 分钟注入全丢、health 仍 ok」的回归钉）──
  {
    const cdpSrc = readT('scripts/cdp.js');
    ok(/EVAL_TIMEOUT_MS/.test(cdpSrc) && /CDP 求值超时/.test(cdpSrc),
      '可观测钉子：Runtime.evaluate 必须有超时（否则一次不返回就让自愈轮询永久停摆）');
    const suiSrc = readT('scripts/start-ui.js');
    ok(/function openLog/.test(suiSrc) && /start-ui\.log/.test(suiSrc),
      '可观测钉子：注入器必须写 <dataDir>/start-ui.log（看门狗用 stdio:ignore 拉起，否则日志全丢）');
    ok(/injectState\.markFail/.test(suiSrc) && /injectState\.markOk/.test(suiSrc),
      '可观测钉子：注入成功/失败都要记状态（health.injection 的数据源）');
    ok(/split\('\?'\)\[0\]/.test(suiSrc),
      '可观测钉子：pageUrl 必须砍掉 query —— 宿主 URL 带 wbSeedToken/uid，摊在面板上既占行又是敏感信息');
    const routesSrc = readT('server/routes.js');
    ok(/injection: ctx\.injection/.test(routesSrc), '可观测钉子：/api/wallpaper/health 必须回传 injection');
    ok(/POST', '\/api\/inject'/.test(routesSrc), '可观测钉子：POST /api/inject 路由已注册');
    // ⚠️ 不要用 `/'\/api\/inject'\]/` 这种锚定数组结尾的写法 —— 只要往名单里加一项就误报，
    //    2026-10-28 加 /api/pause 时就是这样把一条好断言弄红的。直接解析数组字面量。
    const protLine = (readT('server/standalone.js').match(/const PROTECTED_PREFIXES = \[([^\]]*)\]/) || [])[1] || '';
    ok(/'\/api\/inject'/.test(protLine),
      '可观测钉子：/api/inject 必须在 PROTECTED_PREFIXES 里（否则本机任意页面都能强制重注入）');
    ok(/'\/api\/pause'/.test(protLine),
      '可观测钉子：/api/pause 必须在 PROTECTED_PREFIXES 里（它能改变壁纸可见状态）');
    const panelSrcNow = readT('ui/dsh-ui/panel.js');
    ok(/data-act="reinject"/.test(panelSrcNow) && /mask-preset/.test(panelSrcNow) && /wdw-mask/.test(panelSrcNow),
      '可观测钉子：面板「系统」页要有「重新注入」与蒙版滑块（接口一直在，缺的是入口）');
    // ── 动态效果面板入口（P0-2.3，2026-10-29）──
    ok(/动态效果/.test(panelSrcNow) && /data-fx=/.test(panelSrcNow) && /setFx/.test(panelSrcNow),
      '动态效果钉子：面板「系统」页要有昼夜循环/视差开关（data-fx），且 setFx 落地');
    ok(/LS_FX_DAYNIGHT = 'wdw\.fx\.daynight'/.test(panelSrcNow) && /LS_FX_PARALLAX = 'wdw\.fx\.parallax'/.test(panelSrcNow),
      '动态效果钉子：面板开关键必须与 background.js 的 wdw.fx.* 一致（否则开了开关背景层不认）');
    ok(/lsFxDaynight: LS_FX_DAYNIGHT, lsFxParallax: LS_FX_PARALLAX/.test(panelSrcNow) && /var LS_FX_DAYNIGHT = payload\.lsFxDaynight/.test(panelSrcNow),
      '动态效果钉子：开关键必须走 payload（面板被 toString 注入，模块级 const 页面侧取不到——同字体页常量）');
    ok(/daynight: !!.+frames\.length >= 2/.test(readT('core/store.js')) && /parallax: !!.+parallax\.enabled !== false/.test(readT('core/store.js')),
      '动态效果钉子：/api/wallpapers 要回传 fx 能力（daynight=frames≥2），面板据此置灰不支持项');
    ok(/wdw-bg-fx/.test(panelSrcNow),
      '动态效果钉子：teardown 拆除清单要含 wdw-bg-fx（否则退出插件会残留多帧层）');
  }

  // ── 场景属性可视化调节（P0-2.3：读 project.json 的 general.properties 生成控件）──
  {
    const weSrc = readT('core/we.js');
    ok(/function readSceneProperties/.test(weSrc) && /general\.properties/.test(weSrc),
      '场景属性钉子：readSceneProperties 读 project.json 的 general.properties（WE 官方可调属性契约）');
    ok(/\['bool', 'slider', 'color', 'combo'\]/.test(weSrc),
      '场景属性钉子：属性类型白名单 bool/slider/color/combo（未知类型降级为只读展示，不臆造控件）');
    ok(/function applySceneProperties/.test(weSrc) && /weUserProperties/.test(weSrc),
      '场景属性钉子：applySceneProperties 落盘 weUserProperties（透传给注入表达式，页面侧 __weSeedProps 写回）');
    ok(/typeof v === 'boolean' \|\| typeof v === 'number' \|\| typeof v === 'string'/.test(weSrc),
      '场景属性钉子：属性值只接受标量（boolean/number/string），杜绝注入任意结构');
    const routesSrc3 = readT('server/routes.js');
    ok(/GET', '\/api\/we-properties'/.test(routesSrc3) && /POST', '\/api\/we-properties'/.test(routesSrc3),
      '场景属性钉子：GET/POST /api/we-properties 路由已注册');
    const bgSrc2 = readT('ui/background.js');
    ok(/sceneProps/.test(bgSrc2) && /__weSeedProps/.test(bgSrc2) && /applyProps/.test(bgSrc2),
      '场景属性钉子：background.js 要把 sceneProps 经 __weSeedProps/applyProps 写进 WebWallGL 渲染器（含跨源 postMessage 兜底）');
  }

  // ── 遮挡暂停 + 主色 accent + 智能降级（P0 功能升级：2.2 / 2.3 / 3.1）──
  {
    const bgSrc3 = readT('ui/background.js');
    ok(/function installVisibilityPause/.test(bgSrc3) && /visibilitychange/.test(bgSrc3),
      '遮挡暂停钉子：background.js 要监听 visibilitychange/blur，失焦暂停视频与场景');
    ok(/__weSetPaused/.test(bgSrc3) && /op: 'setPaused'/.test(bgSrc3),
      '遮挡暂停钉子：场景暂停要走 __weSetPaused + postMessage setPaused 双通道（同源/跨源都覆盖）');
    ok(/function applyAccentFromImage/.test(bgSrc3) && /--wdw-accent-bg/.test(bgSrc3),
      '主色 accent 钉子：图片壁纸采样主色写 --wdw-accent-bg（面板 --wdw-accent 读它，玻璃拟态随壁纸换肤）');
    ok(/max < 60/.test(bgSrc3) && /max - min < 30/.test(bgSrc3),
      '主色 accent 钉子：过暗/过灰的主色不覆盖（避免黑壁纸把 accent 也拉黑，保持默认蓝）');
    const panelSrc2 = readT('ui/dsh-ui/panel.js');
    ok(/--wdw-accent:var\(--wdw-accent-bg,var\(--wb-accent,#4f8cff\)\)/.test(panelSrc2),
      '主色 accent 钉子：面板 --wdw-accent 必须读 --wdw-accent-bg 兜底（否则 background 注入的主色被子级变量遮蔽）');
    ok(/data-act="scene-fps"/.test(panelSrc2) && /function setSceneFps/.test(panelSrc2),
      '场景帧率钉子：面板要有场景帧率档位（30/24/15）且 setSceneFps 落地');
    ok(/bad \? 15 : st\.sceneFps/.test(panelSrc2),
      '智能降级钉子：软件渲染时场景帧率强制 15 fps（3.1 自动降级，省核）');
  }

  // ── 可读性下限 + 玻璃浓度（借鉴 dsh-wallpaper-engine 的 Readability Floor）──
  {
    const panelSrc3 = readT('ui/dsh-ui/panel.js');
    ok(/--wdw-floor:0\.59/.test(panelSrc3),
      '可读性钉子：面板要有 --wdw-floor 下限（深色 0.59，玻璃透明层下垫固定主题底）');
    ok(/--wdw-glass-amount:62%/.test(panelSrc3) && /--wdw-glass-amount/.test(panelSrc3),
      '可读性钉子：玻璃浓度 --wdw-glass-amount 默认 62%（对齐旧观感），且滑条只调这一层');
    ok(/calc\(var\(--wdw-floor,0\.59\)\*100%\)/.test(panelSrc3),
      '可读性钉子：floor 底用 color-mix 固定不透明度，玻璃浓度滑条「alive above the floor」压不到它');
    ok(/function setGlass/.test(panelSrc3) && /function loadGlass/.test(panelSrc3),
      '可读性钉子：面板要有玻璃浓度 setGlass/loadGlass（localStorage + CSS 变量，纯前端）');
    ok(/wdw-glass/.test(panelSrc3) && /data-glass-pct/.test(panelSrc3),
      '可读性钉子：玻璃浓度滑条（wdw-glass + data-glass-pct 实时百分比）已接线');
  }

  // ── 外观预设 + 动效分类（借鉴 dsh-wallpaper-engine 的 glass-presets 与动效曲线）──
  {
    const panelSrc4 = readT('ui/dsh-ui/panel.js');
    ok(/LOOK_PRESETS/.test(panelSrc4) && /applyLookPreset/.test(panelSrc4),
      '外观预设钉子：要有 LOOK_PRESETS 整套快照 + applyLookPreset 一键切换（accent+玻璃+蒙版）');
    ok(/setAccent/.test(panelSrc4) && /--wdw-accent-bg/.test(panelSrc4) && /loadAccent/.test(panelSrc4),
      '外观预设钉子：手动强调色 setAccent 写 --wdw-accent-bg（空串=清除覆盖跟随壁纸主色），loadAccent 恢复');
    ok(/--wdw-dur:220ms/.test(panelSrc4) && /--wdw-linear:linear/.test(panelSrc4),
      '动效分类钉子：要有主过渡 220ms + linear 曲线两个令牌（背景色走 linear、transform 走缓动）');
    ok(/--wdw-dur\) var\(--wdw-ease\)/.test(panelSrc4) && /--wdw-dur-fast\) var\(--wdw-linear\)/.test(panelSrc4),
      '动效分类钉子：transform/位移走 220ms 缓动、背景色/边框色走 120ms linear（分类用曲线，不混用）');
  }

  // ── 暂停 / 退出分离（2026-10-28「关闭壁纸 ≈ 卸载」的回归钉）──────────────────
  //  背景：旧版只有一个「关闭壁纸」= 写 .stopped + 服务退出 + companion 不再拉起，
  //  想「先关一会儿」的用户实际执行了「卸载」，且面板一起消失、无法自救。
  {
    const pauseSrc = readT('core/pause.js');
    ok(/FLAG_PAUSED = '\.paused'/.test(pauseSrc) && /FLAG_STOPPED = '\.stopped'/.test(pauseSrc),
      '暂停钉子：暂停与退出必须是两个标志文件（.paused ≠ .stopped）—— 混用就等于回到「关闭即卸载」');
    ok(!/\.paused/.test(readT('scripts/companion.js')),
      '暂停钉子：companion 不得读 .paused —— 暂停期间服务与看护照常（「暂时不看」不该触发停机）');
    const sui2 = readT('scripts/start-ui.js');
    ok(/const paused = core\.pause\.readPaused\(dir\)\.paused/.test(sui2) && /if \(id && !paused\)/.test(sui2),
      '暂停钉子：补注入（含 15s 自愈）在暂停态下不许把背景层拉回来，否则一次页面重载就让「暂停」失效');
    ok(/core\.pause\.setPaused\(dir, false, 'apply-theme'\)/.test(sui2),
      '暂停钉子：应用壁纸要自动解除暂停（否则「点了壁纸没反应」会被当成 bug）');
    const routesSrc2 = readT('server/routes.js');
    ok(/POST', '\/api\/pause'/.test(routesSrc2), '暂停钉子：POST /api/pause 路由已注册');
    ok(/p === '\/api\/pause'\) return true/.test(routesSrc2), '暂停钉子：/api/pause 必须进 isApiPath（否则 404）');
    ok(/paused: pauseState\.readPaused\(dataDir\)\.paused/.test(readT('core/store.js')),
      '暂停钉子：/api/wallpapers 必须回传 paused（否则重开面板时按钮显示「暂停壁纸」而实际已在暂停中）');
    const panelSrc2 = readT('ui/dsh-ui/panel.js');
    ok(/data-act="pause-toggle"/.test(panelSrc2) && /'\/api\/pause'/.test(panelSrc2),
      '暂停钉子：面板要有「暂停 / 恢复壁纸」入口');
    ok(/启动\.cmd/.test(panelSrc2),
      '暂停钉子：退出插件的确认框必须写清恢复方法（含「启动.cmd」），不能只说「再运行启动脚本」');

    // 行为：暂停只落状态，绝不写 .stopped
    const JH = Object.assign({ 'content-type': 'application/json' }, TK);
    const p1 = await J(BASE + '/api/pause', { method: 'POST', headers: JH, body: JSON.stringify({ paused: true }) });
    ok(p1 && p1.ok === true && p1.paused === true, '暂停钉子：POST /api/pause{paused:true} 生效', JSON.stringify(p1));
    ok(p1 && p1.applied === false && typeof p1.warn === 'string' && p1.warn.length > 0,
      '暂停钉子：没有注入通道时必须 applied:false + warn（不许假装成功）', String(p1 && p1.warn));
    ok(fs.existsSync(path.join(dataDir, '.paused')),
      '暂停钉子：.paused 必须落盘（服务重启后仍是暂停态，否则用户的「暂停」被重启吞掉）');
    ok(!fs.existsSync(path.join(dataDir, '.stopped')),
      '暂停钉子：暂停绝不能写 .stopped —— 写了就等于退出插件，注销重登都不回来');
    const wl = await J(BASE + '/api/wallpapers');
    ok(wl && wl.paused === true, '暂停钉子：/api/wallpapers 要如实回传 paused:true');
    const p2 = await J(BASE + '/api/pause', { method: 'POST', headers: JH, body: JSON.stringify({ paused: false }) });
    ok(p2 && p2.paused === false && !fs.existsSync(path.join(dataDir, '.paused')),
      '暂停钉子：恢复后 .paused 被清掉');
    const p3 = await J(BASE + '/api/pause', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paused: true }) });
    ok(p3 && !!p3.error, '暂停钉子：/api/pause 无令牌必须被拒（401）', JSON.stringify(p3));
  }

  // ── 渲染诊断（2026-10-28「壁纸发糊」排查结论的可见化）──────────────────────
  //  实测本机 gpu_compositing/rasterization/webgl 全是 disabled_software（SwiftShader）：
  //  场景画布只有 960×516 却要铺 1920×1032，且 GPU 进程吃 ~1267% CPU。
  //  这个事实既不在日志里也不在状态接口里，用户完全看不到 —— 所以钉住"面板必须暴露它"。
  {
    const panelSrc3 = readT('ui/dsh-ui/panel.js');
    ok(/WEBGL_debug_renderer_info/.test(panelSrc3),
      '渲染钉子：面板必须探测宿主真实的 WebGL 后端（否则"为什么糊"永远只有猜测）');
    ok(/swiftshader\|llvmpipe/i.test(panelSrc3) && /渲染模式/.test(panelSrc3),
      '渲染钉子：系统页必须显示渲染模式（软件/硬件），并识别 SwiftShader 这类软件后端');
    const gpuSrc = readT('scripts/gpu-check.js');
    ok(/SystemInfo\.getInfo/.test(gpuSrc) && /gpu-crash-info\.json/.test(gpuSrc),
      '渲染钉子：gpu-check.js 必须同时读宿主的 FeatureStatus 与 GPU 崩溃降级记录（重启无效的原因就在后者）');
    ok(/DEGRADE_THRESHOLD = 1/.test(gpuSrc) && /RECOVER_WINDOW_MS = 86400000/.test(gpuSrc),
      '渲染钉子：降级阈值(1 次)/恢复窗口(24h) 要与宿主实现一致，写错会给出错误的排查结论');
    ok(/docs\/ops[\s\S]{0,80}|gpu-crash-info/.test(gpuSrc),
      '渲染钉子：脚本里要指到运维手册 6.2（处理步骤写在文档里，不靠记忆）');
    // software=false（=硬件）曾被判成"不确定"：三元里只写了 truthy 分支。这类"状态正确但显示错误"最坑。
    ok(/out\.software === false \? '硬件（显卡）'/.test(gpuSrc),
      '渲染钉子：gpu-check 必须显式判 software===false 为硬件 —— 只写 truthy 分支会把硬件渲染报成"不确定"');
    // 宿主重启后 CDP 常比服务晚就绪：启动那一次探测落空后必须能自愈，否则壁纸永久不出现。
    ok(/if \(!cdpPort\) \{[\s\S]{0,200}findCdp\(\)/.test(readT('scripts/start-ui.js')),
      '注入钉子：cdpPort 为空时重连前必须重新探测 —— 否则宿主重启后（服务先起）壁纸再也不出现');
    // 更根本的一条：探测失败不能 return。return 之后重连函数与 15s 轮询都不会被建立，
    // 补探测代码再正确也是死代码（2026-10-28 因此踩了两次同样的坑）。
    const suiSrc3 = readT('scripts/start-ui.js');
    // 只限定启动探测那一处（带"候选端口"）：重连函数里"下一轮继续尝试"后的 return 是正常收尾。
    ok(!/log\('未发现 CDP 端点（候选端口[\s\S]{0,200}?\n\s*return;/.test(suiSrc3),
      '注入钉子：启动时"未发现 CDP 端点"分支里不许 return —— 一旦返回，重连与自愈轮询全都不建立');
    ok(/每 15s 自动重试/.test(suiSrc3) || /尚无 CDP 端点/.test(suiSrc3),
      '注入钉子：没有 CDP 时必须有"会自动重试"的路径与日志，不能静默停在服务模式');
  }

  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.stdout.write('\n通过 ' + pass + ' / 失败 ' + fail + '\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { process.stderr.write('自验证异常：' + ((e && e.stack) || e) + '\n'); process.exit(1); });
