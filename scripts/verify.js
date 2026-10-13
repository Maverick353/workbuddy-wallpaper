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

  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.stdout.write('\n通过 ' + pass + ' / 失败 ' + fail + '\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { process.stderr.write('自验证异常：' + ((e && e.stack) || e) + '\n'); process.exit(1); });
