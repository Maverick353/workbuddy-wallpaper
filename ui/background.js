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
        sf.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;border:0;z-index:-1;pointer-events:none;background:#000;';
        var shost = document.body || document.documentElement;
        shost.insertBefore(sf, shost.firstChild);
      }
      if (sf.getAttribute('data-src-key') !== surl) { sf.setAttribute('data-src-key', surl); sf.src = surl; }
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
