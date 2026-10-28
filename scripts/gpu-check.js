#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
/**
 * gpu-check.js · 「壁纸发糊/发烫」一句话定性：宿主到底用显卡还是用 CPU 渲染
 * --------------------------------------------------------------------------
 * 为什么需要它：场景壁纸走 WebGL。宿主要是软件渲染（SwiftShader），
 * 渲染器会把画布降到一半分辨率（糊），同时吃掉十几个核（烫）。
 * 这件事既不在插件日志里、也不在任何状态接口里 —— 只能主动探测。
 *
 * 用法：
 *   node scripts/gpu-check.js                 # 人读
 *   node scripts/gpu-check.js --json          # 机器读
 *   node scripts/gpu-check.js --user-data "C:/Users/x/.workbuddy/app"
 *   node scripts/gpu-check.js --soft          # CDP 不在时也退出 0（CI 用）
 *
 * 判定优先级：宿主 FeatureStatus（权威）> 页面 WebGL renderer 字符串。
 * 另报宿主的 GPU 崩溃降级记录：count>=1 且距上次崩溃 <24h 时，宿主会**自己**禁用硬件加速，
 * 这种状态下重启无效，必须让记录过期或移走（见 docs/ops/…运维手册.md 6.2）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const DEGRADE_THRESHOLD = 1;
const RECOVER_WINDOW_MS = 86400000;

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

function getJson(u, ms) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout')), ms || 5000);
    http.get(u, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => { clearTimeout(t); try { res(JSON.parse(d)); } catch (e) { rej(e); } }); })
      .on('error', (e) => { clearTimeout(t); rej(e); });
  });
}

function rpc(wsUrl, method, params, ms) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    const t = setTimeout(() => { try { ws.close(); } catch (_) {} reject(new Error('timeout')); }, ms || 8000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params: params || {} }));
    ws.onmessage = (m) => {
      const j = JSON.parse(m.data);
      if (!j.id) return;
      clearTimeout(t);
      try { ws.close(); } catch (_) {}
      j.error ? reject(new Error(JSON.stringify(j.error))) : resolve(j.result);
    };
    ws.onerror = () => { clearTimeout(t); reject(new Error('ws error')); };
  });
}

/** 宿主 GPU 崩溃降级记录：在窗口内 ⇒ 宿主将强制软件渲染（重启也无效）。 */
function crashInfo(userData) {
  const p = path.join(userData, 'gpu-crash-info.json');
  try {
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    const at = Number(d.lastGpuCrash) || 0;
    const age = at ? Date.now() - at : null;
    return {
      path: p,
      exists: true,
      count: Number(d.gpuCrashCount) || 0,
      reason: d.lastGpuCrashReason || null,
      lastAt: at ? new Date(at).toISOString() : null,
      ageHours: age == null ? null : Math.round((age / 3600000) * 10) / 10,
      degrading: Number(d.gpuCrashCount) >= DEGRADE_THRESHOLD && age != null && age < RECOVER_WINDOW_MS,
    };
  } catch (_) {
    return { path: p, exists: false, degrading: false };
  }
}

const WEBGL_EXPR = `(() => {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return { ok: false, renderer: 'WebGL 不可用' };
    const d = gl.getExtension('WEBGL_debug_renderer_info');
    return { ok: true, renderer: String(d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) };
  } catch (e) { return { ok: false, renderer: String(e && e.message) }; }
})()`;

(async () => {
  const port = arg('port', '9222');
  const userData = arg('user-data', path.join(os.homedir(), '.workbuddy', 'app'));
  const soft = process.argv.includes('--soft');
  const out = { ok: false, software: null, features: {}, webgl: null, crash: crashInfo(userData), error: null };

  try {
    const ver = await getJson('http://127.0.0.1:' + port + '/json/version');
    const info = await rpc(ver.webSocketDebuggerUrl, 'SystemInfo.getInfo');
    const fsMap = (info && info.gpu && info.gpu.featureStatus) || {};
    for (const k of ['gpu_compositing', 'rasterization', 'webgl', 'webgl2', '2d_canvas', 'video_decode']) {
      if (fsMap[k]) out.features[k] = fsMap[k];
    }
    const list = await getJson('http://127.0.0.1:' + port + '/json/list');
    const page = list.find((t) => t.type === 'page');
    if (page) {
      const r = await rpc(page.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: WEBGL_EXPR, returnByValue: true });
      out.webgl = r && r.result ? r.result.value : null;
    }
    const f = out.features;
    const softByFeature = typeof f.webgl === 'string' && /software/.test(f.webgl);
    const softByName = !!(out.webgl && /swiftshader|llvmpipe|software|basic render/i.test(String(out.webgl.renderer || '')));
    out.software = softByFeature || softByName;
    out.ok = true;
  } catch (e) {
    out.error = (e && e.message) || String(e);
  }

  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(out, null, 1) + '\n');
  } else {
    const L = [];
    L.push('');
    // ⚠️ 不能写成 `out.software ? '软件' : '不确定'`：software=false（=硬件）会被当成"不确定"，
    //    2026-10-28 首次在真机恢复硬件加速时就踩了这一下（状态全绿却报"不确定"）。
    const verdict = out.software === true ? '软件（CPU）'
      : (out.software === false ? '硬件（显卡）' : '不确定');
    L.push('渲染后端   : ' + (out.ok ? verdict : '无法检测（' + out.error + '）'));
    if (out.ok) {
      L.push('WebGL      : ' + (out.webgl && out.webgl.renderer ? out.webgl.renderer : '—'));
      Object.keys(out.features).forEach((k) => L.push('  ' + k.padEnd(16) + out.features[k]));
    }
    const c = out.crash;
    L.push('崩溃降级   : ' + (c.degrading
      ? '生效中（count=' + c.count + '，' + c.ageHours + ' 小时前，reason=' + c.reason + '）→ 宿主会强制软件渲染，重启无效'
      : (c.exists ? '未生效（count=' + c.count + (c.ageHours != null ? '，' + c.ageHours + ' 小时前' : '') + '）' : '无记录（文件不存在）')));
    if (out.software) {
      L.push('');
      L.push('结论：场景壁纸必然发糊（画布只有一半分辨率）且极耗 CPU。');
      L.push('处理：1) 若"崩溃降级"生效中 → 移走 gpu-crash-info.json 后**完全退出**再启动；');
      L.push('      2) 否则更新显卡驱动 / 检查 Windows 图形设置里 WorkBuddy 未被指到节能 GPU；');
      L.push('      3) 急着用 → 换图片或视频壁纸（不走 WebGL）。');
    } else if (out.ok) {
      L.push('');
      L.push('结论：显卡渲染正常，场景壁纸可以出原生分辨率。');
    }
    process.stdout.write(L.join('\n') + '\n');
  }

  const bad = out.software === true || (!out.ok && !soft);
  process.exit(soft ? 0 : (bad ? 1 : 0));
})().catch((e) => { process.stdout.write('异常：' + ((e && e.message) || e) + '\n'); process.exit(1); });
