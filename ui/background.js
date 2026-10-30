// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
/**
 * background.js · 宿主页面背景层管理（独立版）
 * ------------------------------------------------------------------
 * 把「当前壁纸」真正落到宿主页面上：主题 CSS（内联壁纸 dataURL / 蒙版）+ 视频层 + 场景层。
 * 全部用 `wdw-*` 命名空间，不碰宿主与其它应用的元素。
 *
 * 不变量：
 *   · 幂等：以 data-src-key 判断是否需要换源；同源重复调用不重新加载
 *   · 视频优先**直链流式**（原生 Range 支持断点续播，首帧不必等整份下载），
 *     2.5s 未就绪或 media error 才回退 blob；localStorage 可强制 blob 模式
 *   · 场景 iframe 以服务地址为源（同域，加载 pkg 无 CORS 问题），pointer-events:none
 *   · 层全部 z-index:-1 / fixed 全屏，不参与宿主交互
 */

const IDS = { css: 'wdw-theme-style', video: 'wdw-bg-video', scene: 'wdw-bg-scene', fx: 'wdw-bg-fx' };
const LS_VIDEO_MODE = 'wdw.videoMode';
// 昼夜循环 / 视差：用户本地偏好键（关 = 禁用该动效；缺省按主题配置启用）
const LS_FX_DAYNIGHT = 'wdw.fx.daynight';
const LS_FX_PARALLAX = 'wdw.fx.parallax';

function wallpaperBackground(payload) {
  var ID = payload.ids;
  var LS_VM = payload.lsVideoMode;
  var LS_DAYNIGHT = payload.lsDaynight;
  var LS_PARALLAX = payload.lsParallax;

  // ── 鼠标视差（P0-2.2，纯前端零服务端改动）──────────────────────────────
  // 背景层整体随鼠标做微小 3D 位移，幅度很小（默认 ±8px，可配），营造"壁纸有纵深"的呼吸感。
  // 触发：宿主窗口内 mousemove；鼠标离开窗口后 30s 缓动回中（而不是瞬移，避免突兀）。
  // 代价：只改 transform，不触发重排/重绘（合成器层），对 GPU/CPU 影响可忽略。
  var parallax = null;
  function parallaxCfg() {
    if (parallax) return parallax;
    var p = payload.parallax || null;
    var on = p && p.enabled !== false;
    try { if (localStorage.getItem(LS_PARALLAX) === 'off') on = false; } catch (_) {}
    var amp = (p && Number.isFinite(Number(p.amp)) && Number(p.amp) > 0) ? Number(p.amp) : 8;
    parallax = { on: on, amp: Math.min(40, amp), idleMs: (p && Number(p.idleMs) >= 0) ? Number(p.idleMs) : 30000 };
    return parallax;
  }
  function installParallax(targets) {
    var cfg = parallaxCfg();
    if (!cfg.on || !targets || !targets.length) return;
    var off = function () { for (var i = 0; i < targets.length; i++) { targets[i].style.transform = 'translate3d(0,0,0)'; } };
    var idle = null;
    function tick() {
      if (idle) { clearTimeout(idle); idle = null; }
      idle = setTimeout(off, cfg.idleMs);
    }
    document.addEventListener('mousemove', function (e) {
      if (!cfg.on || document.hidden) return;
      var w = window.innerWidth || 1, h = window.innerHeight || 1;
      var nx = (e.clientX / w - 0.5) * 2;   // -1..1
      var ny = (e.clientY / h - 0.5) * 2;
      var dx = (-nx * cfg.amp).toFixed(2), dy = (-ny * cfg.amp).toFixed(2);
      for (var i = 0; i < targets.length; i++) {
        var t = targets[i];
        var z = t.__wdwPz || 1;
        t.style.transform = 'translate3d(' + (dx * z).toFixed(2) + 'px,' + (dy * z).toFixed(2) + 'px,0)';
      }
      tick();
    }, { passive: true });
    document.addEventListener('mouseleave', off);
    tick();
  }

  // ── 昼夜循环（P0-1.2）：同主题多关键帧 + 本地时钟跨淡化 ────────────────
  // 主题提供 frames（数组，元素含 time 小时数 + dataUrl），页面侧按「当前钟点」在
  // 相邻关键帧间做 opacity 线性插值，分钟级平滑过渡、不跳变。运行时零网络零 AI 调用。
  // 帧用绝对定位 div 叠加（z-index 递增 = 越晚越在上层），最上层通过 opacity 淡入淡出。
  // 无 frames / 被用户关闭 / 解析失败 → 保持现状（单图背景），绝不破坏既有三路。
  function normalizeFrames(raw) {
    if (!raw || !raw.length) return null;
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var f = raw[i];
      if (!f) continue;
      // 兼容两种来源：服务端 resolveFrames 产出 {time,url}；第三方直传可能用 {time,dataUrl}
      var u = f.url || f.dataUrl;
      if (!u) continue;
      var t = Number(f.time);
      if (!Number.isFinite(t)) continue;
      out.push({ time: Math.min(23.999, Math.max(0, t)), url: String(u) });
    }
    out.sort(function (a, b) { return a.time - b.time; });
    return out.length >= 2 ? out : null;
  }
  function daynightCfg() {
    var on = !!payload.frames;
    try { if (localStorage.getItem(LS_DAYNIGHT) === 'off') on = false; } catch (_) {}
    return on;
  }
  /** 计算 t（0-24 小时）处两帧间的插值 [idxA, idxB, k(0..1)]；无环绕时返回 null 用单帧。 */
  function daynightBlend(frames, t) {
    var n = frames.length;
    if (frames[0].time >= t || frames[n - 1].time <= t) {
      // 跨午夜：首尾帧环绕插值
      var a = frames[n - 1], b = frames[0];
      var span = (b.time + 24) - a.time;
      var k = span > 0 ? Math.min(1, Math.max(0, (t + 24 - a.time) / span)) : 0;
      return [a, b, k];
    }
    for (var i = 0; i < n - 1; i++) {
      var f0 = frames[i], f1 = frames[i + 1];
      if (f0.time <= t && t <= f1.time) {
        var sp = f1.time - f0.time;
        var kk = sp > 0 ? Math.min(1, Math.max(0, (t - f0.time) / sp)) : 0;
        return [f0, f1, kk];
      }
    }
    return [frames[n - 1], frames[0], 0];
  }
  function localHour() {
    var d = new Date();
    return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
  }
  function installDaynight() {
    var frames = normalizeFrames(payload.frames);
    var on = daynightCfg();
    var fx = document.getElementById(ID.fx);
    if (!on || !frames) {
      if (fx && fx.parentNode) fx.parentNode.removeChild(fx);
      return;
    }
    if (!fx) {
      fx = document.createElement('div');
      fx.id = ID.fx;
      fx.setAttribute('data-fx', 'daynight');
      fx.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:-1;pointer-events:none;overflow:hidden;';
      (document.body || document.documentElement).insertBefore(fx, (document.body || document.documentElement).firstChild);
    }
    var want = frames.map(function (f) { return f.time + ':' + f.url.length; }).join('|');
    if (fx.getAttribute('data-frames-key') !== want) {
      fx.setAttribute('data-frames-key', want);
      fx.innerHTML = '';
      for (var i = 0; i < frames.length; i++) {
        var d = document.createElement('div');
        d.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;opacity:0;background:url(' + frames[i].url + ') center/cover no-repeat;will-change:opacity;';
        d.setAttribute('data-fx-idx', String(i));
        fx.appendChild(d);
      }
    }
    function paint() {
      var t = localHour();
      var bl = daynightBlend(frames, t);
      var kids = fx.children;
      var aIdx = frames.indexOf(bl[0]), bIdx = frames.indexOf(bl[1]);
      for (var j = 0; j < kids.length; j++) {
        var el = kids[j];
        var idx = Number(el.getAttribute('data-fx-idx'));
        var o = 0;
        if (idx === aIdx) o = 1 - bl[2];
        else if (idx === bIdx) o = bl[2];
        el.style.opacity = String(o);
      }
    }
    paint();
    if (!fx.__wdwDaynightTimer) {
      fx.__wdwDaynightTimer = setInterval(paint, 60000);   // 每分钟重算一次，过渡足够平滑
    }
  }

  // ── 遮挡暂停（P0-2.3，零外部依赖）────────────────────────────────────
  // 窗口失焦 / 最小化 / document.hidden 时，暂停视频 + 暂停场景渲染，回来再恢复。
  // 对标 dsh-wallpaper-engine 的「occlusion pause」：既省 GPU 又省电。
  // 代价：只调 video.pause()/play() 与场景的 __weSetPaused，不销毁任何层（幂等、可逆）。
  var visInstalled = false;
  function installVisibilityPause(getVideo, getScene) {
    if (visInstalled) return;
    visInstalled = true;
    function paused() {
      try { return document.hidden || document.visibilityState === 'hidden'; } catch (_) { return false; }
    }
    function apply(hidden) {
      var v = getVideo();
      if (v) { try { if (hidden) v.pause(); else if (v.getAttribute('data-src-key')) { var p = v.play(); if (p && p.catch) p.catch(function () {}); } } catch (_) {} }
      var sc = getScene();
      if (sc) {
        try { if (sc.contentWindow && sc.contentWindow.__weSetPaused) { sc.contentWindow.__weSetPaused(!!hidden); } } catch (_) {}
        try { sc.contentWindow.postMessage({ __we: 1, op: 'setPaused', v: !!hidden }, '*'); } catch (_) {}
      }
    }
    document.addEventListener('visibilitychange', function () { apply(paused()); });
    window.addEventListener('blur', function () { apply(true); });
    window.addEventListener('focus', function () { apply(paused()); });
  }

  // ── 空闲降帧（P1，零外部依赖）────────────────────────────────────────
  // 窗口在前台但鼠标/键盘长时间无活动时（默认 60s），把场景帧率降到 15fps；
  // 检测到活动立即恢复原帧率。补齐「遮挡暂停」没覆盖的「前台但闲置」场景，
  // 场景壁纸是 GPU 大户，闲置时白烧算力（实测能到 425%）。只调 __weSetFps，
  // 幂等可逆、不销毁层。
  var idleInstalled = false;
  function installIdleThrottle(getScene, baseFps) {
    if (idleInstalled) return;
    idleInstalled = true;
    var IDLE_MS = 60000;
    var idleFps = 15;
    var base = (Number.isFinite(Number(baseFps)) && Number(baseFps) > 0) ? Math.round(Number(baseFps)) : 30;
    var last = Date.now();
    var idle = false;
    function setFps(n) {
      var sc = getScene();
      if (!sc) return;
      try { if (sc.contentWindow && sc.contentWindow.__weSetFps) { sc.contentWindow.__weSetFps(n); } } catch (_) {}
      try { sc.contentWindow.postMessage({ __we: 1, op: 'setFps', n: n }, '*'); } catch (_) {}
    }
    function check() {
      var now = Date.now();
      var isIdle = (now - last) >= IDLE_MS;
      if (isIdle !== idle) { idle = isIdle; setFps(idle ? idleFps : base); }
    }
    function poke() { last = Date.now(); if (idle) { idle = false; setFps(base); } }
    document.addEventListener('mousemove', poke, { passive: true });
    document.addEventListener('keydown', poke, { passive: true });
    document.addEventListener('wheel', poke, { passive: true });
    setInterval(check, 10000);   // 每 10s 检一次，低频无开销
  }

  // ── 主色驱动 accent（P0-2.2，零外部依赖）───────────────────────────────
  // 图片壁纸：读 dataURL 像素算平均主色，写到 --wdw-accent（面板玻璃拟态随壁纸换肤）。
  // 视频/场景取不到像素 → 跳过，保持宿主默认 accent（不破坏现有观感）。
  // 只处理图片分支：dataURL 直读，无网络、无二次请求。
  function applyAccentFromImage(css) {
    try {
      var m = /url\(data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)\)/.exec(css || '');
      if (!m) return;
      var bin = atob(m[1]);
      var arr = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      var img = new Image();
      img.onload = function () {
        try {
          var cv = document.createElement('canvas');
          var scale = Math.min(1, 32 / Math.max(1, img.width));
          cv.width = Math.max(1, Math.round(img.width * scale));
          cv.height = Math.max(1, Math.round(img.height * scale));
          var g = cv.getContext('2d', { willReadFrequently: true });
          g.drawImage(img, 0, 0, cv.width, cv.height);
          var d = g.getImageData(0, 0, cv.width, cv.height).data;
          var r = 0, gg = 0, b = 0, n = 0;
          for (var j = 0; j < d.length; j += 4) { r += d[j]; gg += d[j + 1]; b += d[j + 2]; n++; }
          if (!n) return;
          r = Math.round(r / n); gg = Math.round(gg / n); b = Math.round(b / n);
          // 太暗/太灰的主色不覆盖（避免黑壁纸把 accent 也拉黑）；饱和度不足时保持默认
          var max = Math.max(r, gg, b), min = Math.min(r, gg, b);
          if (max < 60) return;                       // 太暗 → 保持默认蓝
          if (max - min < 30) return;                 // 接近灰 → 保持默认蓝
          var hex = '#' + ('0' + r.toString(16)).slice(-2) + ('0' + gg.toString(16)).slice(-2) + ('0' + b.toString(16)).slice(-2);
          var root = document.documentElement;
          root.style.setProperty('--wdw-accent-bg', hex);
          root.setAttribute('data-wdw-accent', hex);
        } catch (_) {}
      };
      img.onerror = function () {};
      img.src = 'data:image/png;base64,' + m[1];
    } catch (_) {}
  }

  /** 视频加载：直链流式优先，失败回退 blob；用加载令牌丢弃过期回调（防旧 error 误判）。 */
  function loadVideo(ov, url) {
    var mode = 'stream';
    try { if (localStorage.getItem(LS_VM) === 'blob') mode = 'blob'; } catch (_) {}
    var token = (ov.__wdwLoadToken = (ov.__wdwLoadToken || 0) + 1);
    function stale() { return ov.__wdwLoadToken !== token; }
    function blobFallback() {
      if (stale()) return;
      fetch(url, { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.blob() : Promise.reject(new Error('HTTP ' + r.status)); })
        .then(function (bl) {
          if (stale()) return;
          try { if (window.__wdwBgVideoObjUrl) URL.revokeObjectURL(window.__wdwBgVideoObjUrl); } catch (_) {}
          var ou = URL.createObjectURL(bl);
          window.__wdwBgVideoObjUrl = ou;
          ov.style.display = '';
          ov.src = ou;
          var p1 = ov.play(); if (p1 && p1.catch) p1.catch(function () {});
        })
        .catch(function () { if (!stale()) ov.style.display = 'none'; });
    }
    if (mode === 'blob') { blobFallback(); return; }
    try { ov.pause(); ov.removeAttribute('src'); ov.load(); } catch (_) {}
    var settled = false;
    var timer = setTimeout(function () { if (!settled && !stale()) { settled = true; done(); blobFallback(); } }, 2500);
    function done() {
      ov.removeEventListener('loadedmetadata', onOk);
      ov.removeEventListener('error', onErr);
      clearTimeout(timer);
    }
    function onOk() { if (settled || stale()) return; settled = true; done(); ov.style.display = ''; }
    function onErr() { if (settled || stale()) return; settled = true; done(); blobFallback(); }
    ov.addEventListener('loadedmetadata', onOk);
    ov.addEventListener('error', onErr);
    ov.style.display = '';
    ov.src = url;
    var p2 = ov.play(); if (p2 && p2.catch) p2.catch(function () {});
  }

  try {
    // ① 主题 CSS（背景/蒙版等；空值 = 移除）
    var s = document.getElementById(ID.css);
    if (payload.css) {
      if (!s) { s = document.createElement('style'); s.id = ID.css; (document.head || document.documentElement).appendChild(s); }
      if (s.textContent !== payload.css) s.textContent = payload.css;
    } else if (s && s.parentNode) { s.parentNode.removeChild(s); }

    // ② 视频壁纸层
    var vurl = payload.videoUrl || null;
    var ov = document.getElementById(ID.video);
    if (!vurl) {
      if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
      try { if (window.__wdwBgVideoObjUrl) { URL.revokeObjectURL(window.__wdwBgVideoObjUrl); window.__wdwBgVideoObjUrl = null; } } catch (_) {}
    } else {
      if (!ov) {
        ov = document.createElement('video');
        ov.id = ID.video;
        ov.muted = true; ov.loop = true; ov.autoplay = true;
        ov.setAttribute('muted', ''); ov.setAttribute('playsinline', ''); ov.setAttribute('autoplay', '');
        ov.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;object-fit:cover;z-index:-1;pointer-events:none;background:#000;';
        var vhost = document.body || document.documentElement;
        vhost.insertBefore(ov, vhost.firstChild);
      }
      if (ov.getAttribute('data-src-key') !== vurl) { ov.setAttribute('data-src-key', vurl); loadVideo(ov, vurl); }
      else { var p3 = ov.play(); if (p3 && p3.catch) p3.catch(function () {}); }
    }

    // ③ 场景壁纸层（WebWallGL 实时渲染页）
    var surl = payload.sceneUrl || null;
    var sf = document.getElementById(ID.scene);
    if (!surl) {
      if (sf && sf.parentNode) sf.parentNode.removeChild(sf);
    } else {
      if (!sf) {
        sf = document.createElement('iframe');
        sf.id = ID.scene;
        sf.setAttribute('allow', 'autoplay');
        sf.setAttribute('frameborder', '0');
        sf.setAttribute('title', 'Wallpaper Scene');
        // 加载淡入（P3）：初始 opacity:0 + 柔和深色底（替代死黑），load 后淡入，
        // 消除「切场景壁纸黑屏一秒」的割裂感。深色底用渐变更柔，不做纯 #000。
        sf.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;border:0;z-index:-1;pointer-events:none;opacity:0;transition:opacity 400ms ease;background:linear-gradient(160deg,#0e1118,#151a24);';
        var shost = document.body || document.documentElement;
        shost.insertBefore(sf, shost.firstChild);
      }
      if (sf.getAttribute('data-src-key') !== surl) {
        sf.setAttribute('data-src-key', surl);
        sf.style.opacity = '0';   // 换源时回到淡入起点
        var sfOnLoad = function () { sf.removeEventListener('load', sfOnLoad); sf.style.opacity = '1'; };
        sf.addEventListener('load', sfOnLoad);
        sf.src = surl;
      }
      // 场景属性（P0-2.3）：把主题 weUserProperties 写进 WebWallGL 渲染器。
      // 两种通道：同源直访 contentWindow.__weSeedProps（种子，首次即应用）；
      // 跨源 sandbox 场景退化为 postMessage({__we:1,op:'applyProps'})。
      // iframe 刚设 src 时 contentWindow 尚未就绪 → 挂 load 后补投，且每次换源都重投。
      var sp = payload.sceneProps || null;
      if (sp) {
        var pushProps = function () {
          try {
            var cw = sf.contentWindow;
            if (cw && cw.__weSeedProps) { cw.__weSeedProps(sp); return; }
          } catch (_) { /* 跨源，走 postMessage */ }
          try { sf.contentWindow.postMessage({ __we: 1, op: 'applyProps', props: sp }, '*'); } catch (_) {}
        };
        if (sf.getAttribute('data-props-key') !== JSON.stringify(sp)) {
          sf.setAttribute('data-props-key', JSON.stringify(sp));
          sf.addEventListener('load', function onLd() { sf.removeEventListener('load', onLd); pushProps(); });
          if (sf.contentWindow) { try { pushProps(); } catch (_) {} }
        }
      }
    }

    // ④ 增强层：昼夜循环（多帧跨淡化）——覆盖在图片背景之上，视频/场景之上同样可用
    installDaynight();

    // ⑤ 视差：给背景层（图片 #root 不动，视频/场景/多帧容器做 transform 位移）
    var pxTargets = [];
    if (ov && ov.parentNode) pxTargets.push(ov);
    if (sf && sf.parentNode) pxTargets.push(sf);
    var fx = document.getElementById(ID.fx);
    if (fx && fx.parentNode) pxTargets.push(fx);
    installParallax(pxTargets);

    // ⑥ 遮挡暂停（P0-2.3）：失焦/隐藏时暂停视频与场景，回来恢复
    installVisibilityPause(
      function () { return document.getElementById(ID.video); },
      function () { return document.getElementById(ID.scene); }
    );

    // ⑥b 空闲降帧（P1）：前台但闲置 60s 时场景降 15fps，活动恢复原帧率
    var baseFps = 30;
    try { var m = /[?&]sceneFps=(\d+)/.exec(payload.sceneUrl || ''); if (m) baseFps = Number(m[1]); } catch (_) {}
    installIdleThrottle(
      function () { return document.getElementById(ID.scene); },
      baseFps
    );

    // ⑦ 主色驱动 accent（P0-2.2）：图片壁纸采样主色写 --wdw-accent
    if (payload.css) applyAccentFromImage(payload.css);

    return { ok: true, css: !!payload.css, video: !!payload.videoUrl, scene: !!payload.sceneUrl, daynight: !!(payload.frames && daynightCfg()), parallax: parallaxCfg().on };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 页面侧卸载：移走全部背景层与主题 CSS（UI 由 dsh-ui 自己卸载）。 */
function backgroundUninstallExpression() {
  return '(function(){'
    + 'var removed=[];'
    + '[' + JSON.stringify(IDS.css) + ',' + JSON.stringify(IDS.video) + ',' + JSON.stringify(IDS.scene) + ',' + JSON.stringify(IDS.fx) + ']'
    + '.forEach(function(id){var e=document.getElementById(id);if(e){e.remove();removed.push(id);}});'
    + 'try{if(window.__wdwBgVideoObjUrl){URL.revokeObjectURL(window.__wdwBgVideoObjUrl);window.__wdwBgVideoObjUrl=null;}}catch(_){}'
    + 'return removed.join(", ")||"(无)";})()';
}

/** 生成背景注入表达式（自执行）。 */
function backgroundExpression(payload) {
  var p = Object.assign({ ids: IDS, lsVideoMode: LS_VIDEO_MODE, lsDaynight: LS_FX_DAYNIGHT, lsParallax: LS_FX_PARALLAX }, payload || {});
  return '(' + wallpaperBackground.toString() + ')(' + JSON.stringify(p) + ')';
}

module.exports = { IDS, LS_VIDEO_MODE, wallpaperBackground, backgroundExpression, backgroundUninstallExpression };
