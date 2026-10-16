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
  // 面板「关于」页的版本显示：允许带或不带前导 v（页面里用的是变量兜底 + 'v' 前缀拼接），
  // 但**必须**出现这个版本号的字面量 —— 否则就是漏改了。
  const panelSrcForVer = readT('ui/dsh-ui/panel.js');
  ok(panelSrcForVer.includes('v' + pkgVer) || panelSrcForVer.includes("'" + pkgVer + "'") || panelSrcForVer.includes('"' + pkgVer + '"'),
    '面板「关于」页显示的版本一致');
  ok(readT('README.md').includes('workbuddy-wallpaper-setup-' + pkgVer + '.exe'), 'README 里的安装包文件名一致');
  ok(readT('SKILL.md').includes('version: ' + pkgVer), 'SKILL.md 的 version 一致');
  ok(readT('STORE.md').includes('`' + pkgVer + '`'), 'STORE.md 的版本一致');

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
  const normFeed = upd.normalizeFeed({ latest: 'v1.2.0', assets: { zip: { url: 'u', sha256: 'AB' } } }, 't');
  ok(normFeed.latest === '1.2.0' && normFeed.zip.sha256 === 'ab', 'normalizeFeed 规范化版本号与 sha256 大小写');

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
  const panelSrc = readT('ui/dsh-ui/panel.js');
  ok(panelSrc.includes("data-act=\"check-update\"") && panelSrc.includes("data-act=\"apply-update\"") &&
    panelSrc.includes("data-act=\"rollback\""), '面板「关于」页有 检查 / 立即更新 / 回滚 三个动作');
  ok(panelSrc.includes("req('/api/update')") && panelSrc.includes("'/api/update/check'") &&
    panelSrc.includes("'/api/update/apply'") && panelSrc.includes("'/api/update/rollback'"),
    '面板四个更新接口都接上了');
  const updCfg = JSON.parse(readT('update.json'));
  ok(Array.isArray(updCfg.feeds) && updCfg.feeds.length >= 1 && /^https:\/\//.test(updCfg.feeds[0]),
    'update.json 配了更新源且主源是 https', updCfg.feeds[0]);
  ok(fs.existsSync(path.join(ROOT, 'scripts', 'release-feed.js')), '发版脚本 scripts/release-feed.js 存在');

  // ⭐ 这条是回归钉：真实服务经 HTTP 报的 currentVersion 必须是 package.json 的版本。
  //    踩过：routes.js 原本直接取 ctx.version，而 standalone 传进来的是插件命名空间
  //    （值就是 "standalone"）→ 版本比对永远判「有更新」，每个用户都会看到升不完的新版本。
  const apiUpd = await J(BASE + '/api/update');
  ok(apiUpd && apiUpd.ok === true, 'GET /api/update 返回 ok');
  ok(apiUpd && apiUpd.currentVersion === pkgVer,
    'HTTP 报的 currentVersion === package.json 的版本（不是插件命名空间）',
    'api=' + (apiUpd && apiUpd.currentVersion) + ' pkg=' + pkgVer);
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

  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.stdout.write('\n通过 ' + pass + ' / 失败 ' + fail + '\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { process.stderr.write('自验证异常：' + ((e && e.stack) || e) + '\n'); process.exit(1); });
