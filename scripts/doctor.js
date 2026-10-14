#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
/**
 * doctor.js · 宿主升级体检
 * ==================================================================
 * 为什么需要它：
 *   本技能的透明化/去黑线/字体上色等规则，全靠**宿主 WorkBuddy 的 DOM 类名**命中。
 *   这些类名散在两个文件里（`ui/dsh-ui/index.js` 的 CHROME_CSS、`core/theme-css.js` 的 bgTail），
 *   合计 **70 处上下**，还含 CSS-module 哈希名（如 `.conversation-section-label` 旁边那种 `_page_<hash>`）。
 *   宿主一升级，其中一部分会静默失效 —— 表现是"某块又变黑了"或"壁纸被挡住"，
 *   但不会报错。靠记性维护不住，所以要有一键体检。
 *
 * 做法：**不读源码文本**（选择器是拼接出来的，抠不准），而是
 *   ① 直接调用生产代码拿到**真实生成的 CSS**；
 *   ② 抽出选择器；
 *   ③ 连 CDP，在活着的宿主页面上逐个 `querySelectorAll` 数命中数。
 *
 * 用法：
 *   node scripts/doctor.js              # 体检（需要 WorkBuddy 带 9222 在跑）
 *   node scripts/doctor.js --list       # 只列锚点、不连宿主
 *   node scripts/doctor.js --all        # 连没命中的也全部打印
 *   node scripts/doctor.js --json       # 输出 JSON（给脚本用）
 *
 * 解读注意：**命中 0 不一定就是坏了**。比如"资料库页"的选择器在你停在会话页时本来就命中 0。
 * 判断方法：切到对应界面再跑一次；或看它是否**曾经**有命中（对照上一次的输出）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');

// ── ① 拿到真实生成的 CSS ────────────────────────────────────────────────
/** 抠选择器：花括号感知（能穿过 @media 嵌套），先去掉注释。 */
function extractSelectors(css) {
  const clean = String(css || '').replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  let buf = '';
  let depth = 0;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (ch === '{') {
      if (depth === 0) {
        const sel = buf.trim();
        if (sel && !sel.startsWith('@')) {
          for (const one of sel.split(',')) {
            const t = one.trim();
            if (t) out.push(t);
          }
        }
      }
      depth++;
      buf = '';
    } else if (ch === '}') {
      depth = Math.max(0, depth - 1);
      buf = '';
    } else if (depth === 0) {
      buf += ch;
    }
  }
  return out;
}

/** 我们注入 UI 自身的样式（不依赖宿主），体检时排除。 */
const isOurs = (sel) => /wdw/i.test(sel);

function collectCss() {
  const parts = [];
  // (a) 注入 UI 的 chrome 样式
  try {
    const ui = require(path.join(ROOT, 'ui', 'dsh-ui', 'index.js'));
    if (typeof ui.CHROME_CSS === 'string') parts.push(ui.CHROME_CSS);
    else if (Array.isArray(ui.CHROME_CSS)) parts.push(ui.CHROME_CSS.join(''));
  } catch (e) {
    process.stderr.write('[doctor] 读 CHROME_CSS 失败：' + e.message + '\n');
  }
  // (b) 背景/透明化样式（用临时主题喂给生产函数，拿到真实 bgCssStr）
  let tmp = null;
  try {
    const tc = require(path.join(ROOT, 'core', 'theme-css.js'));
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wbwp-doctor-'));
    const themesDir = path.join(tmp, 'themes');
    const themeDir = path.join(themesDir, 'probe');
    fs.mkdirSync(themeDir, { recursive: true });
    fs.writeFileSync(path.join(themeDir, 'background.webp'), Buffer.from('x'));
    const a = tc.resolveBackgroundAssets({
      theme: { image: 'background.webp' },
      id: 'probe',
      themesDir,
      port: 47851,
      dataDir: tmp,
    });
    if (a && a.bgCssStr) parts.push(a.bgCssStr);
  } catch (e) {
    process.stderr.write('[doctor] 读背景 CSS 失败：' + e.message + '\n');
  } finally {
    if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} }
  }
  return parts.join('\n');
}

// ── ② 连宿主 CDP 数命中 ─────────────────────────────────────────────────
const get = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
});

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
    });
    ws.addEventListener('open', () => resolve({
      ev: (expr) => new Promise((res) => {
        const i = ++id;
        pending.set(i, res);
        ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
      }),
      close: () => ws.close(),
    }));
    ws.addEventListener('error', () => reject(new Error('ws error')));
  });
}

/** 在活着的宿主页面里数每个选择器的命中数。连不上返回 null。 */
async function probeLive(selectors) {
  let targets;
  try { targets = await get('http://127.0.0.1:9222/json/list'); } catch (_) { return null; }
  const pages = (Array.isArray(targets) ? targets : []).filter((t) => t.type === 'page');
  let session = null;
  for (const pg of pages) {
    const c = await connect(pg.webSocketDebuggerUrl).catch(() => null);
    if (!c) continue;
    const has = await c.ev('!!document.getElementById("root")');
    if (has && has.result && has.result.value) { session = c; break; }
    c.close();
  }
  if (!session) return null;
  const counts = {};
  for (const sel of selectors) {
    // querySelectorAll 不接受伪元素；`:hover` 等伪类合法但通常命中 0，属正常
    const q = sel.replace(/::[a-z-]+/g, '');
    const r = await session.ev('(function(){try{return document.querySelectorAll(' + JSON.stringify(q) + ').length;}catch(e){return -1;}})()');
    counts[sel] = r && r.result ? r.result.value : -1;
  }
  session.close();
  return counts;
}

// ── ③ 主流程 ────────────────────────────────────────────────────────────
(async () => {
  const args = process.argv.slice(2);
  const listOnly = args.includes('--list');
  const showAll = args.includes('--all');
  const asJson = args.includes('--json');

  const css = collectCss();
  const all = Array.from(new Set(extractSelectors(css)));
  const host = all.filter((s) => !isOurs(s));
  const ours = all.length - host.length;

  let counts = null;
  if (!listOnly) counts = await probeLive(host);

  const broken = [];
  const ok = [];
  for (const sel of host) {
    const n = counts ? counts[sel] : null;
    if (n === null) { ok.push({ sel, n: null }); continue; }
    if (n === 0) broken.push({ sel, n: 0 });
    else ok.push({ sel, n });
  }

  if (asJson) {
    console.log(JSON.stringify({ total: all.length, ours, host: host.length, live: !!counts, broken, ok }, null, 2));
    process.exit(0);
  }

  console.log('宿主锚点体检 —— workbuddy-wallpaper');
  console.log('  生成 CSS 总选择器 : ' + all.length);
  console.log('  其中我们自己的    : ' + ours + '（注入 UI 自身样式，与宿主无关，已排除）');
  console.log('  需要依赖宿主的    : ' + host.length);
  if (!counts) {
    console.log('  ⚠️ 没能连上宿主（WorkBuddy 需带 --remote-debugging-port=9222 在跑）→ 只列出锚点');
    console.log('     连上后本工具会逐个报命中数，命中 0 的就是"宿主可能改过、需要跟着改"的候选。');
    for (const s of host) console.log('    · ' + s);
    process.exit(0);
  }
  console.log('  命中数已采集      : ' + ok.length + ' 个有命中 / ' + broken.length + ' 个命中 0');
  if (broken.length) {
    console.log('\n命中 0 的锚点（**不一定是坏了**：也可能只是当前不在对应界面，切换视图再跑一次确认）：');
    for (const b of broken) console.log('    ✗ ' + b.sel);
  }
  if (showAll) {
    console.log('\n全部命中数：');
    for (const o of ok.concat(broken)) console.log('    ' + String(o.n).padStart(4) + '  ' + o.sel);
  }
  console.log('\n提示：改宿主适配时，两个来源分别是');
  console.log('  · ui/dsh-ui/index.js  的 CHROME_CSS（界面外壳）');
  console.log('  · core/theme-css.js   的 bgTail（背景透明化）');
  process.exit(0);
})().catch((e) => { process.stderr.write('[doctor] 异常：' + ((e && e.stack) || e) + '\n'); process.exit(1); });
