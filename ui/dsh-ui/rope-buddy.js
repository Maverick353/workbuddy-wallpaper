// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
/**
 * rope-buddy.js · 拉绳吉祥物（buddy 版）
 * ------------------------------------------------------------------
 * 原创的「拉绳吊挂」交互语言：
 *   · 盒子挂在窗口顶边、绳子从上垂下并**没入它举起的右手** —— 「它拉着绳子」（2026-10-13 优化）
 *   · 形象（2026-10-13 起）：用户提供的挂绳机器猫立绘（assets/buddy.png 透明 PNG，
 *     竖版 160×248）—— 立绘**自带绳子**（从图顶贯到举起的手），故浏览器端只画
 *     「图上方那一小段」绳（同 x / 同粗细 / 同色）与之无缝衔接。
 *   · 无立绘时回退到 CSS 绘制的 buddy（外壳 / 双眼 / 天线 / 四配色，源于 .wbs-fab 形象语言）。
 *
 * 不变量：
 *   · 盒子尺寸即命中区；`<img>`/装饰一律 pointer-events:none，拖拽捕获留在盒子
 *   · 拖拽跟手 = 直写 transform/left/top，不走任何框架渲染路径
 *   · 松手吸附顶部边缘（top = 0）并 clamp 在视口内 —— 拉绳「挂」在顶边
 *   · 位置只进 localStorage（UI 状态），不进任何持久配置
 *   · 点击（非拖拽）/ 下拉 → 打开面板；上推 / ESC → 收起
 */

const IDS = {
  root: 'wdw-rope-buddy',
  style: 'wdw-rope-buddy-style',
};
const LS_POS = 'wdw.rope.pos';
const LS_PREFS = 'wdw.rope.prefs';

/** 默认偏好（大小按步进缩放，形态可切配色）。 */
const DEFAULT_PREFS = { scale: 1, style: 'theme', hidden: false };

/** 视觉常量。立绘为竖版「挂绳机器猫」（160×248，比值≈0.645）：
 *  形象区按宽 64 等比 ⇒ 高 99；加顶部绳长 30 ⇒ 盒子 64×129。
 *  立绘自带绳（图顶 → 举起的手），故 CSS 只画图上那一段，贴绳点 x 取实测值（36.6%）。 */
const BOX_W = 64;
const BOX_H = 129;
const STRING_H = 30;      // 形象上方可见的绳长（接续立绘自带的绳）
const ROPE_X = 36.6;      // 贴绳点 x%（立绘图顶绳中心实测）
const KNOT = 7;           // 绳结直径（立绘模式隐藏）
const DRAG_SLOP = 4;      // 小于该位移视为「点击」而非拖拽

function wallpaperRopeBuddy(payload) {
  var ID = payload.ids;
  var LS_POS_KEY = payload.lsPos;
  var LS_PREFS_KEY = payload.lsPrefs;
  var DEFAULTS = payload.defaults;
  var W = payload.box.w, H = payload.box.h;
  var STRING_H = payload.box.string, KNOT = payload.box.knot, SLOP = payload.slop;
  var ROPE_X = payload.ropeX;
  // 立绘（透明 PNG 的 data URI）。有则用 <img>（单文件自包含），
  // 无则回退到 CSS 绘制的 buddy —— 两条腿都能走，缺素材不会白屏。
  var ART = payload.art || null;

  function prefs(patch) {
    try {
      var p = JSON.parse(localStorage.getItem(LS_PREFS_KEY) || '{}');
      if (patch) { Object.assign(p, patch); localStorage.setItem(LS_PREFS_KEY, JSON.stringify(p)); }
      return Object.assign({}, DEFAULTS, p || {});
    } catch (_) { return Object.assign({}, DEFAULTS); }
  }
  function pos(patch) {
    try {
      var p = JSON.parse(localStorage.getItem(LS_POS_KEY) || '{}');
      if (patch) { Object.assign(p, patch); localStorage.setItem(LS_POS_KEY, JSON.stringify(p)); }
      return p || {};
    } catch (_) { return {}; }
  }

  // ── 样式（幂等；全部变量前缀 --wdw- ，不碰宿主与 WorkDaddy 的 wbs-*）──────
  function style() {
    var s = document.getElementById(ID.style);
    if (!s) { s = document.createElement('style'); s.id = ID.style; (document.head || document.documentElement).appendChild(s); }
    var css = [
      // 盒子：拉绳命中区（整块可拖）；z-index 996（低于面板，高于背景层）
      '#' + ID.root + '{position:fixed;z-index:996;width:' + W + 'px;height:' + H + 'px;box-sizing:border-box;cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none;outline-offset:2px;will-change:transform,left,top}',
      '#' + ID.root + ':focus-visible{outline:2px solid var(--wdw-accent,#4f8cff);border-radius:12px}',
      '#' + ID.root + '.wdw-dragging{cursor:grabbing}',
      // 松手回弹：280ms（cubic-bezier(0.16,1,0.3,1)）
      '#' + ID.root + '.wdw-settle{transition:top 280ms cubic-bezier(0.16,1,0.3,1),left 280ms cubic-bezier(0.16,1,0.3,1)}',
      '#' + ID.root + '.wdw-hidden{display:none}',
      // 拉绳：只画「立绘图顶之上」那一段（立绘自带绳，从图顶贯到举起的手）。
      // 同 x（ROPE_X≈36.6%）、同粗细（2.2px）、同色（tan）⇒ 与立绘的绳无缝衔接；
      // 顶部渐隐 + --wdw-rope-extend ⇒ 视觉上仍「挂」在屏幕顶边。
      '#' + ID.root + ' .wdw-rope__string{position:absolute;left:' + ROPE_X + '%;top:calc(-1 * var(--wdw-rope-extend,0px));width:2.2px;height:calc(' + (STRING_H + 2) + 'px + var(--wdw-rope-extend,0px));margin-left:-1.1px;border-radius:2px;background:linear-gradient(180deg,transparent 0,rgba(206,166,122,.6) 14%,rgba(196,155,112,.95) 60%,rgb(186,146,106) 100%);pointer-events:none;z-index:0}',
      // 绳结：CSS 形象（非立绘）模式下的吊挂衔接点；立绘自带绳 ⇒ 立绘模式隐藏
      '#' + ID.root + ' .wdw-rope__knot{position:absolute;left:' + ROPE_X + '%;top:' + (STRING_H - 10) + 'px;width:' + KNOT + 'px;height:' + KNOT + 'px;margin-left:' + (-KNOT / 2) + 'px;border-radius:50%;background:radial-gradient(circle at 32% 30%,#f0dcb8,#b98f52 70%);box-shadow:0 1px 2px rgba(0,0,0,.35);pointer-events:none;z-index:0}',
      '#' + ID.root + '.wdw-has-art .wdw-rope__knot{display:none}',
      // 形象盒：hover 放大 1.06；z-index 高于绳子 ⇒ 覆盖处遮挡（绳端没入手心）
      '#' + ID.root + ' .wdw-rope__art{position:absolute;left:0;top:' + STRING_H + 'px;width:100%;height:' + (H - STRING_H) + 'px;transition:transform 120ms ease;transform-origin:top center;z-index:1}',
      '#' + ID.root + ':hover .wdw-rope__art{transform:scale(1.06)}',
      // ── buddy 本体（沿用 .wbs-fab 的形象语言）──
      '#' + ID.root + ' .wdw-buddy{position:relative;display:block;width:100%;height:100%;padding:0;margin:0;border:0;background:transparent;cursor:inherit;pointer-events:none}',
      // 天线（含顶端灯珠）
      '#' + ID.root + ' .wdw-buddy__antenna{position:absolute;left:50%;top:0;width:3px;height:13px;margin-left:-1.5px;border-radius:2px;background:var(--wdw-buddy-rim,rgba(255,255,255,.55));opacity:.85}',
      '#' + ID.root + ' .wdw-buddy__antenna::after{content:"";position:absolute;left:50%;top:-4px;width:7px;height:7px;margin-left:-3.5px;border-radius:50%;background:var(--wdw-accent,#4f8cff);box-shadow:0 0 6px var(--wdw-accent,#4f8cff)}',
      // 外壳
      '#' + ID.root + ' .wdw-buddy__shell{position:absolute;left:50%;top:11px;width:52px;height:41px;margin-left:-26px;border-radius:15px;background:var(--wdw-buddy-shell,#111);box-shadow:inset 0 2px 0 var(--wdw-buddy-rim,rgba(255,255,255,.55)),0 8px 14px rgba(0,0,0,.18);backdrop-filter:var(--wdw-buddy-blur,none);-webkit-backdrop-filter:var(--wdw-buddy-blur,none);display:flex;align-items:center;justify-content:center;gap:9px}',
      // 双眼（含眨眼）
      '#' + ID.root + ' .wdw-buddy__eye{width:9px;height:14px;border-radius:5px;background:var(--wdw-buddy-eye,#fff);animation:wdw-buddy-blink 4.6s infinite}',
      '#' + ID.root + ' .wdw-buddy__eye:nth-child(2){animation-delay:.08s}',
      '@keyframes wdw-buddy-blink{0%,92%,100%{transform:scaleY(1)}94%,97%{transform:scaleY(.12)}}',
      // 配色（theme 跟随界面主题色，其余为固定色 —— 与 .wbs-fab 的 data-wbs-robot-style 同构）
      '#' + ID.root + '[data-buddy-style="black"]{--wdw-buddy-shell:#111;--wdw-buddy-eye:#fff;--wdw-buddy-rim:rgba(255,255,255,.14)}',
      '#' + ID.root + '[data-buddy-style="white"]{--wdw-buddy-shell:#fff;--wdw-buddy-eye:#111;--wdw-buddy-rim:rgba(0,0,0,.14)}',
      '#' + ID.root + '[data-buddy-style="glass"]{--wdw-buddy-shell:color-mix(in srgb,var(--wb-bg-popover,#fff) 42%,transparent);--wdw-buddy-eye:transparent;--wdw-buddy-blur:blur(10px) saturate(1.3);--wdw-buddy-rim:color-mix(in srgb,var(--wb-color-text-primary,#222) 18%,transparent)}',
      '#' + ID.root + '[data-buddy-style="theme"]{--wdw-buddy-shell:var(--wb-button-primary-bg,var(--vscode-button-background,#111));--wdw-buddy-eye:var(--wb-button-primary-fg,var(--vscode-button-foreground,#fff));--wdw-buddy-rim:var(--wb-border-subtle,rgba(255,255,255,.55))}',
      // ── 立绘模式（透明 PNG）──
      // <img> 填满形象盒、object-fit:contain 保比例不拉伸；不拦截指针（拖拽捕获留在盒子）
      '#' + ID.root + ' .wdw-rope__art-img{display:block;width:100%;height:100%;object-fit:contain;pointer-events:none;user-select:none;-webkit-user-drag:none}',
      '#' + ID.root + '.wdw-has-art .wdw-buddy{display:none}',
      // 拖拽把手提示（hover 时绳结轻微发光）
      '#' + ID.root + ':hover .wdw-rope__knot{box-shadow:0 1px 2px rgba(0,0,0,.35),0 0 8px var(--wdw-accent,#4f8cff)}',
    ].join('\n');
    if (s.textContent !== css) s.textContent = css;
  }

  // ── 构建（幂等；带版本指纹，进程升级后自动重建）─────────────────────────
  var WIRE_VER = '2';   // 换立绘（竖版挂绳猫）+ 盒子尺寸变更 ⇒ 强制重建
  function build() {
    var el = document.getElementById(ID.root);
    if (el && el.getAttribute('data-wdw-ver') !== WIRE_VER) { try { el.remove(); } catch (_) {} el = null; }
    // 立绘/回退形象的切换也要能重建（否则换了素材仍显示旧形态）
    if (el && (!!ART) !== el.classList.contains('wdw-has-art')) { try { el.remove(); } catch (_) {} el = null; }
    if (!el) {
      el = document.createElement('div');
      el.id = ID.root;
      el.setAttribute('data-wdw-ver', WIRE_VER);
      el.setAttribute('role', 'button');
      el.setAttribute('tabindex', '0');
      el.setAttribute('title', '壁纸 · 拖拽移动，点击打开面板，上推收起');
      var artInner = ART
        ? '<img class="wdw-rope__art-img" src="' + ART + '" alt="" draggable="false">'
        : '<button class="wdw-buddy" type="button" tabindex="-1" aria-hidden="true">'
          + '<span class="wdw-buddy__shell"><span class="wdw-buddy__eye"></span><span class="wdw-buddy__eye"></span></span>'
          + '<span class="wdw-buddy__antenna"></span>'
          + '</button>';
      el.innerHTML = [
        '<div class="wdw-rope__string"></div>',
        '<div class="wdw-rope__knot"></div>',
        '<div class="wdw-rope__art">', artInner, '</div>',
      ].join('');
      if (ART) el.classList.add('wdw-has-art');
      (document.body || document.documentElement).appendChild(el);
    }
    return el;
  }

  function place(el, p) {
    el.style.left = p.left + 'px';
    el.style.top = p.top + 'px';
    // 绳子上端始终延伸到画面顶端：buddy 被宿主顶部 chrome 下压时，绳子视觉上仍「挂」在顶边
    try { el.style.setProperty('--wdw-rope-extend', Math.max(0, p.top) + 'px'); } catch (_) {}
  }
  /** 宿主顶部 chrome（窗口菜单栏等）的底边高度。
   *  为什么需要：真身是 `#workbuddy-menubar-container` —— z-index 10000、position:fixed、
   *  全宽 30px、`-webkit-app-region: drag` 的窗口拖拽区；它会吃掉覆盖区内的鼠标事件，
   *  于是 buddy 的盒子上半部分（绳子 + 形象顶部）完全点不到，只有下半部分可用。
   *  抬高 z-index 不是解法（会盖住「文件/窗口/帮助」菜单按钮，还与"按住顶部拖窗口"抢），
   *  正解是**避开**这段区域：把最小 top 抬到它下方，并让绳子向上延伸保持"挂顶边"的观感。 */
  function topLimit() {
    try {
      var ids = ['workbuddy-menubar-container', 'workbuddy-titlebar', 'workbuddy-title-bar'];
      var limit = 0;
      for (var i = 0; i < ids.length; i++) {
        var e = document.getElementById(ids[i]);
        if (!e) continue;
        var r = e.getBoundingClientRect();
        // 只认「贴顶 + 横跨大半个窗口」的条带，避免误判面板类元素
        if (r.height > 0 && r.top <= 2 && r.width >= (innerWidth || 0) * 0.5) limit = Math.max(limit, Math.round(r.bottom));
      }
      return limit;
    } catch (_) { return 0; }
  }
  /** 吸附顶部边缘 + clamp（松手回顶边，且永不拖出视野）。
   *  视口尚未布局（宽/高 ≤ 盒子，例如隐藏中的预览或嵌入容器）时**不 clamp** ——
   *  否则 Math.max(0, vw - W) = 0 会把元素硬压到左上角（实测踩过）。
   *  下界是 topLimit() 而非 0：避开宿主窗口菜单栏，保证盒子整体可交互。 */
  function clampPos(left, top) {
    var vw = innerWidth || (document.documentElement && document.documentElement.clientWidth) || 0;
    var vh = innerHeight || (document.documentElement && document.documentElement.clientHeight) || 0;
    var minT = topLimit();
    if (vw <= W || vh <= H) return { left: Math.max(0, left), top: Math.max(minT, top) };
    var maxL = Math.max(0, vw - W);
    var maxT = Math.max(minT, vh - H);
    return { left: Math.min(maxL, Math.max(0, left)), top: Math.min(maxT, Math.max(minT, top)) };
  }
  function defaultPos() {
    // 默认落点 = 右上角、贴着右侧面板左侧（面板宽 344 + 20px 间距）。
    // 2026-10-13 实测教训：旧默认位在屏幕中心，用户点开面板后要横跨屏幕找页签，
    // 窗口最大化后凭肌肉记忆点击全点飞到顶部菜单栏/窗口按钮（监控实证）。
    return clampPos(Math.round((innerWidth || 0) - W - 380), 0);
  }

  // ── 交互：拖拽跟手 / 吸附 / 点击开面板 / 上推收起 ─────────────────────────
  function wire(el, api) {
    if (el.__wdwWired) return;
    el.__wdwWired = true;
    var dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0;

    el.addEventListener('pointerdown', function (e) {
      if (e.button !== undefined && e.button !== 0) return;
      dragging = true; moved = false;
      sx = e.clientX; sy = e.clientY;
      ox = parseFloat(el.style.left) || 0;
      oy = parseFloat(el.style.top) || 0;
      el.classList.remove('wdw-settle');
      el.classList.add('wdw-dragging');
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });

    el.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (!moved && (Math.abs(dx) > SLOP || Math.abs(dy) > SLOP)) moved = true;
      // 跟手：直写 left/top（拖拽中不做 clamp，允许暂时拖到边缘外一点，松手再吸附）
      place(el, { left: ox + dx, top: oy + dy });
    });

    function end(e) {
      if (!dragging) return;
      dragging = false;
      el.classList.remove('wdw-dragging');
      try { el.releasePointerCapture(e.pointerId); } catch (_) {}
      if (!moved) { api.onActivate(); return; }          // 点击（非拖拽）
      var y = parseFloat(el.style.top) || 0;
      var x = parseFloat(el.style.left) || 0;
      // 上推（向上拖出较多）→ 收起面板；否则吸附顶边
      if (y < -14) { api.onPushUp(); }
      var next = clampPos(x, 0);                          // 松手一律回到顶部边缘
      el.classList.add('wdw-settle');
      place(el, next);
      var p = pos(); p.left = next.left; p.top = next.top; pos(p);
      setTimeout(function () { el.classList.remove('wdw-settle'); }, 320);
    }
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);

    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); api.onActivate(); }
      else if (e.key === 'Escape') { api.onPushUp(); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        var d = e.key === 'ArrowLeft' ? -16 : 16;
        var p2 = clampPos((parseFloat(el.style.left) || 0) + d, 0);
        place(el, p2); pos({ left: p2.left, top: p2.top });
      }
    });
  }

  // ── 对外 API（供面板/测试调用）───────────────────────────────────────────
  var api = {
    el: null,
    open: false,
    setStyle: function (name) { prefs({ style: name }); if (api.el) api.el.setAttribute('data-buddy-style', name); },
    setScale: function (v) { prefs({ scale: v }); api.apply(); },
    setHidden: function (v) { prefs({ hidden: !!v }); api.apply(); },
    /** 回到默认位置（屏幕上方居中偏右）。走 clampPos ⇒ 自动避开宿主顶部 chrome。 */
    resetPos: function () {
      if (!api.el) return;
      var p = defaultPos();
      api.el.classList.add('wdw-settle');
      place(api.el, p);
      pos({ left: p.left, top: p.top });
      setTimeout(function () { api.el.classList.remove('wdw-settle'); }, 320);
      return p;
    },
    toggle: function (v) { api.onActivate(); if (v !== undefined) api.open = !!v; },
    apply: function () {
      var p = prefs();
      if (!api.el) return;
      api.el.setAttribute('data-buddy-style', p.style || 'theme');
      api.el.style.transform = 'scale(' + (Number(p.scale) || 1) + ')';
      api.el.style.transformOrigin = 'top center';
      api.el.classList.toggle('wdw-hidden', !!p.hidden);
    },
    /** 点击 → 开合面板。**以面板状态为准** —— 面板可能已被 Esc / 关闭按钮收起，
     *  拉绳不能拿自己那份旧状态取反（否则会出现「点了没反应」的错觉）。 */
    onActivate: function () {
      var p = window.__wdwPanel;
      if (p && typeof p.toggle === 'function') { p.toggle(); api.open = !!p.open; }
      else { api.open = !api.open; }
      try { window.dispatchEvent(new CustomEvent('wdw:rope-toggle', { detail: { open: api.open } })); } catch (_) {}
    },
    /** 上推 / Esc → 收起。 */
    onPushUp: function () {
      var p = window.__wdwPanel;
      if (p && typeof p.close === 'function') p.close();
      api.open = false;
      try { window.dispatchEvent(new CustomEvent('wdw:rope-toggle', { detail: { open: false, reason: 'push-up' } })); } catch (_) {}
    },
  };

  style();
  api.el = build();
  var saved = pos();
  var start = (saved && typeof saved.left === 'number' && typeof saved.top === 'number') ? clampPos(saved.left, saved.top) : defaultPos();
  api.el.style.transformOrigin = 'top center';
  place(api.el, start);
  wire(api.el, api);
  api.apply();
  window.__wdwRopeBuddy = api;

  // 视口变化时保持可见（clamp 回界内）
  window.addEventListener('resize', function () {
    var p = clampPos(parseFloat(api.el.style.left) || 0, parseFloat(api.el.style.top) || 0);
    place(api.el, p);
  });

  return { ok: true, id: ID.root, left: start.left, top: start.top };
}

/** 生成注入表达式（自执行；与 operator-bar / drawer 同范式）。 */
function ropeBuddyExpression(payload) {
  var p = Object.assign({
    ids: IDS,
    lsPos: LS_POS,
    lsPrefs: LS_PREFS,
    defaults: DEFAULT_PREFS,
    box: { w: BOX_W, h: BOX_H, string: STRING_H, knot: KNOT },
    ropeX: ROPE_X,
    slop: DRAG_SLOP,
  }, payload || {});
  return '(' + wallpaperRopeBuddy.toString() + ')(' + JSON.stringify(p) + ')';
}

module.exports = { IDS, DEFAULT_PREFS, BOX_W, BOX_H, ropeBuddyExpression, wallpaperRopeBuddy };
