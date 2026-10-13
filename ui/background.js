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

const IDS = { css: 'wdw-theme-style', video: 'wdw-bg-video', scene: 'wdw-bg-scene' };
const LS_VIDEO_MODE = 'wdw.videoMode';

function wallpaperBackground(payload) {
  var ID = payload.ids;
  var LS_VM = payload.lsVideoMode;

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
    return { ok: true, css: !!payload.css, video: !!payload.videoUrl, scene: !!payload.sceneUrl };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 页面侧卸载：移走全部背景层与主题 CSS（UI 由 dsh-ui 自己卸载）。 */
function backgroundUninstallExpression() {
  return '(function(){'
    + 'var removed=[];'
    + '[' + JSON.stringify(IDS.css) + ',' + JSON.stringify(IDS.video) + ',' + JSON.stringify(IDS.scene) + ']'
    + '.forEach(function(id){var e=document.getElementById(id);if(e){e.remove();removed.push(id);}});'
    + 'try{if(window.__wdwBgVideoObjUrl){URL.revokeObjectURL(window.__wdwBgVideoObjUrl);window.__wdwBgVideoObjUrl=null;}}catch(_){}'
    + 'return removed.join(", ")||"(无)";})()';
}

/** 生成背景注入表达式（自执行）。 */
function backgroundExpression(payload) {
  var p = Object.assign({ ids: IDS, lsVideoMode: LS_VIDEO_MODE }, payload || {});
  return '(' + wallpaperBackground.toString() + ')(' + JSON.stringify(p) + ')';
}

module.exports = { IDS, LS_VIDEO_MODE, wallpaperBackground, backgroundExpression, backgroundUninstallExpression };
