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

const ROOT = path.resolve(__dirname, '..');
const { start } = require(path.join(ROOT, 'server', 'standalone.js'));
const dshUI = require(path.join(ROOT, 'ui', 'dsh-ui', 'index.js'));
const bg = require(path.join(ROOT, 'ui', 'background.js'));
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
  const { server, port } = await start({ port: 47899, dataDir, log: () => {}, applyTheme: async (id) => { applied.push(id); return { ok: true }; } });
  const BASE = 'http://127.0.0.1:' + port;
  const J = async (u, o) => (await fetch(u, o)).json();

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
  ok(readT('ui/dsh-ui/panel.js').includes('v' + pkgVer), '面板「关于」页显示的版本一致');
  ok(readT('README.md').includes('workbuddy-wallpaper-setup-' + pkgVer + '.exe'), 'README 里的安装包文件名一致');
  ok(readT('SKILL.md').includes('version: ' + pkgVer), 'SKILL.md 的 version 一致');
  ok(readT('STORE.md').includes('`' + pkgVer + '`'), 'STORE.md 的版本一致');

  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.stdout.write('\n通过 ' + pass + ' / 失败 ' + fail + '\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { process.stderr.write('自验证异常：' + ((e && e.stack) || e) + '\n'); process.exit(1); });
