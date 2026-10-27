#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
/**
 * probe-injection.js · 注入存活探针（只看只读状态，不改任何东西）
 * ------------------------------------------------------------------
 * 为什么需要：`verify.js` 能测到服务与接口，但**测不到"界面上真的挂上了没有"** ——
 * 那要连 WorkBuddy 的 CDP。这个脚本把 `companion.js --status` 看不到的那一半补上。
 *
 * 判据（三条全过才算注入正常）：
 *   ① 页面里 `#wdw-*` 元素 ≥ 10 个
 *   ② `#wdw-rope-buddy`（吉祥物）存在 —— `start-ui.js` 每 15s 轮询它，缺了会整段重注入
 *   ③ `#root` 的背景不是实色（必须被改成透明，否则壁纸被挡住）
 *
 * ⚠️ 不要用 `#wdw-bg-scene` 的 innerHTML 判断壁纸有没有 —— 它是 **iframe**，innerHTML 恒为空。
 *    场景是否真的在渲染，看 CDP 的 iframe target 里有没有 canvas（本脚本顺带报出来）。
 *
 * 用法：
 *   node scripts/probe-injection.js            # 人读摘要，退出码 0/1
 *   node scripts/probe-injection.js --json     # 机器读
 *   node scripts/probe-injection.js --port 9222
 */
const http = require('http');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function evaluate(wsUrl, expression, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    const timer = setTimeout(() => { try { ws.close(); } catch (_) {} reject(new Error('CDP 超时')); }, timeoutMs || 10000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    ws.onmessage = (m) => {
      const j = JSON.parse(m.data);
      if (j.id === 1) {
        clearTimeout(timer);
        try { ws.close(); } catch (_) {}
        if (j.error) return reject(new Error(j.error.message));
        resolve(j.result && j.result.result && j.result.result.value);
      }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('CDP 连接失败')); };
  });
}

const PAGE_EXPR = `(() => {
  const ids = [...document.querySelectorAll('[id^="wdw-"]')].map(e => e.id);
  const rb = document.getElementById('wdw-rope-buddy');
  const panel = document.getElementById('wdw-wallpaper-panel');
  const root = document.getElementById('root');
  const bg = root ? getComputedStyle(root).backgroundImage : '';
  const scene = document.getElementById('wdw-bg-scene');
  return {
    wdwCount: ids.length,
    wdwIds: ids,
    ropeBuddy: !!rb,
    panel: !!panel,
    rootBg: String(bg).slice(0, 80),
    rootTransparent: /rgba\\(0,\\s*0,\\s*0,\\s*0\\)|transparent/.test(String(bg)) || bg === 'none',
    sceneIframe: scene ? { tag: scene.tagName, src: (scene.getAttribute('src') || '').slice(0, 120) } : null,
    hidden: document.hidden,
  };
})()`;

const SCENE_EXPR = `(() => ({
  canvases: [...document.querySelectorAll('canvas')].map(c => c.width + 'x' + c.height),
  script: (document.scripts[0] && document.scripts[0].src || '').split('/').pop()
}))()`;

(async () => {
  const port = arg('port', '9222');
  const wantJson = process.argv.includes('--json');
  // --soft：CDP 不可用时不判失败（给 CI 用 —— CI 上没有 WorkBuddy，永远连不上）
  const soft = process.argv.includes('--soft');
  const out = { ok: false, checks: {}, page: null, scene: null, error: null };

  try {
    const list = await getJson('http://127.0.0.1:' + port + '/json/list');
    const page = list.find((t) => t.type === 'page' && /WorkBuddy/.test(t.url));
    if (!page) throw new Error('没有找到 WorkBuddy 页面（CDP 端口开着，但目标不在）');
    const pageInfo = await evaluate(page.webSocketDebuggerUrl, PAGE_EXPR);

    const frame = list.find((t) => t.type === 'iframe' && /scene-live/.test(t.url));
    let sceneInfo = null;
    if (frame) {
      try { sceneInfo = await evaluate(frame.webSocketDebuggerUrl, SCENE_EXPR, 8000); } catch (_) { sceneInfo = { error: '场景页读取失败' }; }
    }

    out.page = pageInfo;
    out.scene = sceneInfo;
    out.checks.cdp = true;
    out.checks.elements = pageInfo.wdwCount >= 10;
    out.checks.mascot = pageInfo.ropeBuddy === true;
    out.checks.rootTransparent = pageInfo.rootTransparent === true;
    out.checks.sceneRendering = !!(sceneInfo && Array.isArray(sceneInfo.canvases) && sceneInfo.canvases.length > 0);
    out.ok = out.checks.cdp && out.checks.elements && out.checks.mascot && out.checks.rootTransparent;
  } catch (e) {
    out.error = (e && e.message) || String(e);
  }

  if (wantJson) {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } else {
    const mark = (v) => (v ? '✓' : '✗');
    process.stdout.write('=== 注入探针 ===\n');
    if (out.error) {
      process.stdout.write('  ✗ ' + out.error + '\n');
      process.stdout.write('  → 先确认 WorkBuddy 是带 --remote-debugging-port=' + port + ' 启动的\n');
    } else {
      const p = out.page;
      process.stdout.write('  ' + mark(out.checks.elements) + ' wdw 元素 ' + p.wdwCount + ' 个（阈值 ≥10）\n');
      process.stdout.write('  ' + mark(out.checks.mascot) + ' 吉祥物 #wdw-rope-buddy ' + (p.ropeBuddy ? '在' : '缺失') + '\n');
      process.stdout.write('  ' + mark(out.checks.rootTransparent) + ' #root 背景已透明（' + p.rootBg + '）\n');
      process.stdout.write('  ' + mark(out.checks.sceneRendering) + ' 场景层渲染中 ' +
        (out.scene && out.scene.canvases && out.scene.canvases.length ? out.scene.canvases.join(',') : '未检测到 canvas') + '\n');
      if (p.sceneIframe) process.stdout.write('  · 场景 iframe 存在（innerHTML 恒为空是正常的）\n');
      process.stdout.write('\n结论：' + (out.ok ? '注入正常' : '注入不完整') + '\n');
    }
  }
  if (soft && !out.ok && /9222|ECONNREFUSED|CDP/.test(String(out.error || ''))) {
    process.stdout.write('（--soft：CDP 不可用，跳过判定）\n');
    process.exit(0);
  }
  process.exit(out.ok ? 0 : 1);
})();
