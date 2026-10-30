// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
/**
 * panel.js · 壁纸面板（原创玻璃拟态视觉）
 * ------------------------------------------------------------------
 * 视觉规格（原创设计，玻璃拟态语言）：
 *   · 页签栏「分段式玻璃轨道 + 滑动指示胶囊」
 *       轨道 padding:3px、圆角 10px、1px 边框；胶囊 translate 220ms cubic-bezier(.16,1,.3,1)
 *       页签高 28px、字号 12px、激活加粗；窄抽屉里六枚等宽页签
 *   · 页签内容（gap:12px + 180ms fade/上移 4px 落定）
 *   · 面板 token（--ui-h:30px / --ui-radius:8px / 墨色三级 / ease / dur-fast）
 *   · 设置行（左右分栏，min-height 32px）
 *   · 页签集合 = 壁纸库 / 字体 / 系统 / 扩展 / 关于
 *
 * 功能布局：
 *   library   官方 + 自定义（含上传）+ WE 创意工坊
 *             + 壁纸仓库：标签分类（全部/收藏/场景/视频/图片）+ 关键词搜索
 *   appearance 背景蒙版 / 壁纸填充 / 玻璃强度
 *   playback  场景鼠标交互 / 视频加载模式 / 场景帧率 / 暂停
 *   system    吉祥物（拉绳 buddy）：配色 / 大小 / 显示隐藏 / 位置重置
 *   extensions 与 WorkDaddy 的联动项
 *   about     版本 / 仓库 / 许可
 *
 * 契约：payload = { apiBase, hostApi?, lsRepo? }
 *   · hostApi=true → 优先复用宿主注入闭包里的 api(path, opts)（自带 X-WorkDaddy-Token，
 *     宿主环境必需）；独立应用（无闭包）自动回退到 fetch(apiBase+path)。
 *   · 收藏/标签是纯 UI 状态，只进 localStorage['wdw.repo']，不进任何持久配置。
 * 对外：window.__wdwPanel = { open, close, show/close, toggle(v), setTab, refresh() }。
 * 命名空间：全部 wdw-*（不碰宿主与 WorkDaddy 的 wbs-*）。
 */

const IDS = { root: 'wdw-wallpaper-panel', style: 'wdw-panel-style' };
const LS_TAB = 'wdw.panel.tab';
const LS_PREFS = 'wdw.panel.prefs';
const LS_REPO = 'wdw.repo';
// 动态效果开关键（与 ui/background.js 的 LS_FX_DAYNIGHT / LS_FX_PARALLAX 保持一致）
const LS_FX_DAYNIGHT = 'wdw.fx.daynight';
const LS_FX_PARALLAX = 'wdw.fx.parallax';
// 面板玻璃浓度（0~100，写 --wdw-glass-amount；与背景层无关，纯面板 UI 偏好）
const LS_GLASS = 'wdw.glass';
// 手动强调色（写 --wdw-accent-bg，覆盖壁纸主色采样；空串=跟随壁纸）
const LS_ACCENT = 'wdw.accent';
// 最近使用（最多 8 条，库页顶部快捷段；纯前端 localStorage）
const LS_RECENT = 'wdw.recent';
// 自动轮播间隔（分钟；0=关闭，5/15/30/60 可选）
const LS_ROTATE = 'wdw.rotate';
// 视频倍速 + 静音（直接操作 wdw-bg-video 元素）
const LS_VRATE = 'wdw.vrate';
const LS_VMUTED = 'wdw.vmuted';
// 外观预设：accent + 玻璃浓度 + 蒙版 整套快照（借鉴 dsh 的 glass-presets）
const LOOK_PRESETS = [
  { id: 'follow', name: '跟随壁纸', accent: '', glass: 62, mask: 0 },
  { id: 'deepblue', name: '深空蓝', accent: '#4f8cff', glass: 70, mask: 0 },
  { id: 'cyan', name: '青蓝', accent: '#67DCE7', glass: 55, mask: 0 },
  { id: 'purple', name: '紫色心情', accent: '#b388ff', glass: 60, mask: 10 },
  { id: 'minimal', name: '极简白', accent: '#ffffff', glass: 45, mask: 20 },
];
/** 仓库过滤 chips（id → 标签）。fav 与其余并存：fav 只看收藏，其余按类型筛。 */
const REPO_FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'fav', label: '★ 收藏' },
  { id: 'scene', label: '场景' },
  { id: 'video', label: '视频' },
  { id: 'image', label: '图片' },
];
const TABS = [
  { id: 'library', label: '壁纸库' },
  { id: 'font', label: '字体' },
  { id: 'system', label: '系统' },
  { id: 'extensions', label: '扩展' },
  { id: 'about', label: '关于' },
];

/** 字体页常量。颜色 '' = 不覆盖（跟随主题）；其余是 #rrggbb。字体列表由服务端 /api/fonts 提供。 */
const LS_FONT = 'wdw.font';
const FONT_COLORS = [['#ffffff', '纯白'], ['#000000', '纯黑'], ['', '默认']];
/** 常用色块：点一下即变（原生取色器在 Windows 是弹对话框，点选不方便）。 */
const FONT_SWATCHES = [
  '#ffffff', '#d9d9d9', '#8c8c8c', '#000000',
  '#ff4d4f', '#ff7a45', '#ffa940', '#ffd666',
  '#bae637', '#52c41a', '#13c2c2', '#40a9ff',
  '#2f54eb', '#722ed1', '#eb2f96', '#f759ab',
];

function wallpaperPanel(payload) {
  var ID = payload.ids;
  var API = payload.apiBase;
  var TABS = payload.tabs;
  var LS_TAB = payload.lsTab, LS_PREFS = payload.lsPrefs, LS_REPO = payload.lsRepo;
  var FILTERS = payload.filters;
  // 字体页常量（必须走 payload —— 本函数会被 toString() 注入，模块级常量取不到）
  var LS_FONT = payload.lsFont, FONT_COLORS = payload.fontColors, FONT_SWATCHES = payload.fontSwatches || [];
  // 动态效果开关键（必须走 payload —— 同字体页常量，模块级 const 会被 toString() 注入时丢掉）
  var LS_FX_DAYNIGHT = payload.lsFxDaynight, LS_FX_PARALLAX = payload.lsFxParallax;
  // 宿主环境：闭包里存在 api(path, opts)（自带 X-WorkDaddy-Token）。独立环境取不到 → 走 fetch。
  // typeof 对未声明变量安全；payload.hostApi 为假时短路，连 typeof 都不求值。
  var HOST_API = payload.hostApi && typeof api === 'function' ? api : null;
  // P1-3：受保护接口（/api/update* /api/shutdown）要带的本地令牌，由服务端经注入 payload 送来。
  // 拿不到它就等于"以匿名身份访问自己的服务" —— 服务会 401，面板更新卡片会显示错误。
  var TOKEN = payload.apiToken || '';
  function authHeaders(extra) {
    var h = extra || {};
    if (TOKEN) h['x-wbwp-token'] = TOKEN;
    return h;
  }

  var st = {
    open: false,
    tab: (function () { try { var v = localStorage.getItem(LS_TAB); return TABS.some(function (t) { return t.id === v; }) ? v : 'library'; } catch (_) { return 'library'; } })(),
    source: 'custom',            // library 页的来源分段（自定义 / WE 库）
    official: [], custom: [], we: null, weBusy: false,
    cur: '', interactive: true, videoMode: 'stream', sceneFps: 30, paused: false,
    uploadBusy: false, err: '',
    offline: false,               // 服务不可达（fetch 失败）：显示明确错误态，而非静默空白
    rfilter: (function () { try { var r = JSON.parse(localStorage.getItem(LS_REPO) || '{}'); return r.filter || 'all'; } catch (_) { return 'all'; } })(),
    rquery: '',                  // 壁纸仓库：标签过滤 + 关键词
    fonts: null, fontsLoading: false, fontQuery: '',   // 字体页：本机字体列表 + 搜索词
    // 更新机制：「关于」页的数据 + 忙碌态 + 错误。upd 为 null 表示还没拿到过状态。
    upd: null, updBusy: '', updErr: '', updMsg: '',
    // 注入状态（health.injection）+ 蒙版浓度 + 应用中的壁纸 key（「应用中…」反馈）
    inj: undefined, mask: null, maskBusy: false, reinjectBusy: false, applying: '', pauseBusy: false,
    render: null,                 // WebGL 后端探测结果（软件渲染会让场景壁纸发糊，见 renderInfo）
    glass: null,                  // 面板玻璃浓度（0~100，写 --wdw-glass-amount；null=读取中）
    accent: null,                 // 手动强调色（写 --wdw-accent-bg；null=跟随壁纸主色）
    recent: null,                 // 最近使用列表（库页快捷段；null=未读取）
    rotate: 0,                    // 自动轮播间隔（分钟；0=关闭）
    rotateTimer: null,            // 轮播定时器句柄
    vrate: 1,                     // 视频倍速（0.5~2）
    vmuted: true,                 // 视频静音
    toast: '', toastAct: '',      // 轻提示文案 + 可选操作（如撤销）
    undo: null,                   // 撤销目标（上一张壁纸 {kind,id,title}）
    fx: null,                     // 当前主题动态效果能力 { daynight, parallax }（来自 /api/wallpapers）
    fxDaynight: null, fxParallax: null, fxBusy: false,  // 昼夜循环/视差开关（null=读取中）
    // 场景属性（P0-2.3）：当前场景 general.properties 的可调属性表 + 已落盘值 + 忙碌态。
    // scProps 为 null = 当前壁纸非场景 / 无属性 / 未读取；编辑时先改 scProps 本地，提交后回写。
    scProps: null, scPropsBusy: false, scPropsMsg: '',
  };

  function prefs(patch) {
    try {
      var p = JSON.parse(localStorage.getItem(LS_PREFS) || '{}');
      if (patch) { Object.assign(p, patch); localStorage.setItem(LS_PREFS, JSON.stringify(p)); }
      return p || {};
    } catch (_) { return {}; }
  }
  /** 壁纸仓库状态：{ fav: {key:true}, filter:'all'|'fav'|…, q:'关键词' }（纯 UI，只进 localStorage）。 */
  function repo(patch) {
    try {
      var r = JSON.parse(localStorage.getItem(LS_REPO) || '{}');
      if (patch) { Object.assign(r, patch); localStorage.setItem(LS_REPO, JSON.stringify(r)); }
      return r || {};
    } catch (_) { return {}; }
  }
  function favKey(kind, id) { return (kind === 'we' ? 'w:' : 'f:') + String(id); }
  function isFav(kind, id) { var r = repo(); return !!(r.fav && r.fav[favKey(kind, id)]); }
  function toggleFav(kind, id) {
    var r = repo();
    var f = {};
    Object.keys(r.fav || {}).forEach(function (k) { f[k] = true; });
    var k = favKey(kind, id);
    if (f[k]) delete f[k]; else f[k] = true;
    repo({ fav: f });
    return !!f[k];
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  /** 统一请求：宿主优先（自带鉴权），否则 fetch(apiBase+path) 且带本地令牌。返回 json|null（失败不抛）。 */
  function req(path, body, method) {
    if (HOST_API) {
      var o = {};
      if (body) { o.method = method || 'POST'; o.headers = authHeaders({ 'content-type': 'application/json' }); o.body = JSON.stringify(body); }
      else { o.method = method || 'GET'; o.headers = authHeaders(); }
      return HOST_API(path, o).catch(function () { return null; });
    }
    // 注意：GET 也要带令牌（/api/update 就是 GET）—— 代价是多一次预检，服务端已经处理。
    var opt = body
      ? { method: method || 'POST', headers: authHeaders({ 'content-type': 'application/json' }), body: JSON.stringify(body) }
      : { method: method || 'GET', headers: authHeaders() };
    return fetch(API + path, opt).then(function (r) { return r.json(); }).catch(function () { return null; });
  }

  // ── 样式（幂等）──────────────────────────────────────────────────────────
  function style() {
    var s = document.getElementById(ID.style);
    if (!s) { s = document.createElement('style'); s.id = ID.style; (document.head || document.documentElement).appendChild(s); }
    var css = [
      // 面板容器：悬浮岛式右滑抽屉（与侧栏悬浮岛同一视觉语言，2026-10-13 二次迭代）：
      // 四周留白 12px 脱离边缘 + 全圆角 22px + 玻璃底 + 顶部光泽 + 细边框 + 多层悬浮阴影
      // z=1500：必须压过宿主右缘「会话历史导航」(conversation-history-navigation, z=1100)，
      // 否则面板打开时导航栏按钮从面板上穿透，看着像面板错位（2026-10-29 实测）。
      // 不要去追 wbs-fab/wbs-root 的 2147483647（WorkDaddy 悬浮球），追不上也不必追。
      '#' + ID.root + '{position:fixed;top:34px;right:12px;height:calc(100vh - 46px);width:344px;z-index:1500;display:flex;flex-direction:column;box-sizing:border-box;',
      '--wdw-ui-h:30px;--wdw-ui-radius:10px;--wdw-ease:cubic-bezier(0.16,1,0.3,1);--wdw-dur-fast:120ms;--wdw-dur:220ms;--wdw-linear:linear;',
      '--wdw-ink:var(--wb-color-text-primary,#e8ecf4);--wdw-ink-2:var(--wb-color-text-secondary,rgba(232,236,244,.72));--wdw-ink-3:rgba(232,236,244,.5);',
      '--wdw-accent:var(--wdw-accent-bg,var(--wb-accent,#4f8cff));',
      '--wdw-glass-line:rgba(255,255,255,.12);--wdw-glass-fill:rgba(255,255,255,.07);--wdw-glass-fill-hi:rgba(255,255,255,.13);',
      // 可读性下限（借鉴 dsh-wallpaper-engine 的 Readability Floor）：玻璃釉层之下垫一层
      // 固定不透明度的主题底，玻璃浓度滑条只在「下限之上」叠加 —— 用户怎么调都不会把
      // 文字调得看不清（浅色 floor=0.45 / 深色 floor=0.59，保证最坏对比度 ≥4.63:1）。
      // 结构：background-color = floor 底（固定）→ background-image 第一层 = 玻璃釉
      // （--wdw-glass-amount 可调，默认 62 对齐旧观感）→ 第二层 = 顶部光泽渐变。
      // 有效覆盖 = floor + glass×(1-floor) ≥ floor，滑条 alive above the floor。
      '--wdw-floor:0.59;--wdw-glass-amount:62%;',
      'background-color:color-mix(in srgb,var(--wb-bg-primary,#101418) calc(var(--wdw-floor,0.59)*100%),transparent);',
      'background-image:linear-gradient(180deg,color-mix(in srgb,var(--wb-bg-primary,#101418) var(--wdw-glass-amount,62%),transparent),color-mix(in srgb,var(--wb-bg-primary,#101418) var(--wdw-glass-amount,62%),transparent)),linear-gradient(180deg,rgba(255,255,255,.07),rgba(255,255,255,.015));',
      'backdrop-filter:blur(24px) saturate(1.35);-webkit-backdrop-filter:blur(24px) saturate(1.35);',
      'border:1px solid rgba(255,255,255,.16);border-radius:22px;',
      // ⚠️ overflow 必须 visible：实测 2026-10-13 窗口全屏(1920)时 overflow:hidden
      // 会让整个面板不被 GPU 合成器绘制（DOM/hit-test 正常但屏幕上没有，
      // 用户完全看不到面板 →「点不中」）。hidden/clip 均触发，visible 已实证两尺寸正常。
      // 圆角由容器自身背景按 border-radius 绘制；.p-head/.p-foot 无自身背景，不会溢出圆角。
      'overflow:visible;',
      'box-shadow:0 20px 50px rgba(0,0,0,.5),0 4px 14px rgba(0,0,0,.32),inset 0 1px 0 rgba(255,255,255,.16);',
      // 关闭态：右移 (100% + 16px)，保证完全移出 12px 留白区、不在屏内留缝
      'transform:translateX(calc(100% + 16px));transition:transform 260ms var(--wdw-ease);',
      'font-size:13px;color:var(--wdw-ink);}',
      '#' + ID.root + '.wdw-open{transform:none}',
      '#' + ID.root + ' *{box-sizing:border-box}',
      // 头部
      '#' + ID.root + ' .p-head{display:flex;align-items:center;gap:8px;justify-content:space-between;padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.10);flex:0 0 auto}',
      // 面板关闭按钮（此前只能再点吉祥物或按 Esc；右上角又正好压着宿主窗口的关闭按钮，极易误关整个应用）
      '#' + ID.root + ' .p-x{margin-left:auto;width:24px;height:24px;display:flex;align-items:center;justify-content:center;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--wdw-ink-3);cursor:pointer;font-size:12px;line-height:1;padding:0;transition:background var(--wdw-dur-fast),color var(--wdw-dur-fast)}',
      '#' + ID.root + ' .p-x:hover{background:var(--wdw-glass-fill-hi);color:var(--wdw-ink)}',
      '#' + ID.root + ' .p-title{font-size:13px;font-weight:600;flex:1}',
      // ── 页签栏（分段式玻璃轨道 + 滑动指示胶囊）──
      '#' + ID.root + ' .p-tabs{position:relative;display:flex;flex:0 0 auto;padding:3px;border-radius:12px;margin:26px 12px 6px;',
      'background:color-mix(in srgb,var(--wb-bg-popover,#1a1e26) 45%,transparent);border:1px solid rgba(255,255,255,.10);overflow:hidden}',
      '#' + ID.root + ' .p-tabs__pill{position:absolute;top:3px;left:3px;bottom:3px;border-radius:9px;',
      'background:color-mix(in srgb,var(--wb-bg-popover,#2a3040) 65%,transparent);box-shadow:0 2px 8px rgba(0,0,0,.30),inset 0 1px 0 rgba(255,255,255,.16);',
      'transition:transform 220ms var(--wdw-ease);will-change:transform}',
      '#' + ID.root + ' .p-tab{position:relative;z-index:1;flex:1 1 0;min-width:0;height:28px;padding:0 4px;border:0;background:transparent;border-radius:8px;cursor:pointer;white-space:nowrap;font-size:12px;line-height:1;color:var(--wdw-ink-2);transition:color var(--wdw-dur-fast) var(--wdw-linear)}',
      '#' + ID.root + ' .p-tab:hover{color:var(--wdw-ink)}',
      '#' + ID.root + ' .p-tab.wdw-on{color:var(--wdw-ink);font-weight:600}',
      // ── 页签小红点（「关于」页有新版本时）──
      // 复用项目里唯一保留下来的深色元素——红色未读徽标——的视觉语言，不新造一套配色。
      '#' + ID.root + ' .p-dot{position:absolute;top:2px;right:2px;width:6px;height:6px;border-radius:50%;',
      'background:#ff4d4f;box-shadow:0 0 0 2px color-mix(in srgb,var(--wb-bg-popover,#1a1e26) 70%,transparent)}',
      // ── 更新区（「关于」页）──
      '#' + ID.root + ' .p-upd{border:1px solid rgba(255,255,255,.14);border-radius:10px;padding:9px 10px;display:flex;flex-direction:column;gap:7px}',
      '#' + ID.root + ' .p-upd.wdw-new{border-color:rgba(255,196,0,.45);background:rgba(255,196,0,.07)}',
      '#' + ID.root + ' .p-upd.wdw-must{border-color:rgba(255,77,79,.5);background:rgba(255,77,79,.08)}',
      '#' + ID.root + ' .p-upd-h{font-size:12px;font-weight:600;display:flex;align-items:center;gap:6px}',
      '#' + ID.root + ' .p-upd-note{font-size:11px;line-height:1.55;color:var(--wdw-ink-2);white-space:pre-wrap;max-height:132px;overflow-y:auto}',
      '#' + ID.root + ' .p-upd-meta{font-size:10px;line-height:1.5;color:var(--wdw-ink-3);word-break:break-all}',
      '#' + ID.root + ' .p-upd-acts{display:flex;gap:6px;flex-wrap:wrap}',
      '#' + ID.root + ' .p-busy{opacity:.65;pointer-events:none}',
      // 内容区：fade + 上移落定
      '#' + ID.root + ' .p-body{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:6px 12px 14px}',
      '#' + ID.root + ' .p-pane{display:flex;flex-direction:column;gap:12px;animation:wdw-tab-in 180ms var(--wdw-ease)}',
      '@keyframes wdw-tab-in{from{opacity:0;transform:translateY(4px)}}',
      '@media (prefers-reduced-motion:reduce){#' + ID.root + ',#' + ID.root + ' .p-tabs__pill,#' + ID.root + ' .p-pane{transition:none;animation:none}}',
      // 窄窗口：面板仍留 8px 留白（岛式），只收缩间距与圆角
      // 窄窗口（≤720 CSS px，等价于 1920 屏 @267% DPI 或小窗）：改贴边全宽，但顶部仍要让开宿主窗口控制按钮
      '@media (max-width:720px){#' + ID.root + '{top:34px;right:8px;height:calc(100vh - 42px);width:calc(100vw - 16px);border-radius:18px}}',
      // 分组与设置行
      '#' + ID.root + ' .p-sec{display:flex;flex-direction:column;gap:8px}',
      '#' + ID.root + ' .p-sec-t{font-size:11px;color:var(--wdw-ink-3);letter-spacing:.3px}',
      '#' + ID.root + ' .p-row{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:32px}',
      '#' + ID.root + ' .p-row-l{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '#' + ID.root + ' .p-row-l b{font-weight:500;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}',
      '#' + ID.root + ' .p-row-l i{font-style:normal;font-size:11px;color:var(--wdw-ink-3)}',
      // 分段控件（来源切换）
      '#' + ID.root + ' .p-seg{display:flex;gap:4px}',
      '#' + ID.root + ' .p-seg button{flex:1;height:28px;border-radius:10px;border:1px solid var(--wdw-glass-line);background:var(--wdw-glass-fill);color:var(--wdw-ink-2);cursor:pointer;font-size:12px;transition:background var(--wdw-dur-fast) var(--wdw-linear),border-color var(--wdw-dur-fast) var(--wdw-linear)}',
      '#' + ID.root + ' .p-seg button:hover{background:var(--wdw-glass-fill-hi)}',
      '#' + ID.root + ' .p-seg button.wdw-on{background:color-mix(in srgb,var(--wdw-accent) 30%,transparent);border-color:color-mix(in srgb,var(--wdw-accent) 55%,transparent);color:var(--wdw-ink);font-weight:600}',
      // 按钮
      // ⚠️ white-space:nowrap + flex:0 0 auto 不能删：在 .p-row(flex) 里中文没有词边界，
      //    min-content 会退化成单字宽 ⇒「上传/扫描/关闭壁纸」被压成竖排两行（曾全尺寸复现）。
      '#' + ID.root + ' .p-btn{height:var(--wdw-ui-h);padding:0 12px;border-radius:var(--wdw-ui-radius);border:1px solid var(--wdw-glass-line);background:var(--wdw-glass-fill);color:inherit;cursor:pointer;font-size:12px;white-space:nowrap;flex:0 0 auto;transition:background var(--wdw-dur-fast),box-shadow var(--wdw-dur-fast)}',
      '#' + ID.root + ' .p-btn:hover{background:var(--wdw-glass-fill-hi);box-shadow:0 2px 8px rgba(0,0,0,.25)}',
      '#' + ID.root + ' .p-btn.wdw-primary{background:color-mix(in srgb,var(--wdw-accent) 34%,transparent);border-color:color-mix(in srgb,var(--wdw-accent) 60%,transparent)}',
      // 危险操作（退出插件）：只做颜色区分，不缩放不抖动 —— 抖动会让误点变多。
      '#' + ID.root + ' .p-btn.wdw-danger{border-color:rgba(239,108,108,.55);background:rgba(239,108,108,.14);color:#ff9d9d}',
      '#' + ID.root + ' .p-btn.wdw-danger:hover{background:rgba(239,108,108,.24);box-shadow:0 2px 8px rgba(239,108,108,.22)}',
      // 区块脚注（如"当前为暂停中"）：整段可换行，别用 .p-tag 那条 nowrap
      '#' + ID.root + ' .p-hint.p-note{display:block;margin:2px 0 2px;line-height:1.5;white-space:normal}',
      '#' + ID.root + ' .p-btn[disabled]{opacity:.5;cursor:default}',
      // 网格卡片（壁纸缩略图）
      '#' + ID.root + ' .p-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}',
      '#' + ID.root + ' .p-card{position:relative;aspect-ratio:16/10;border-radius:12px;overflow:hidden;cursor:pointer;border:1px solid rgba(255,255,255,.14);background:#0b0d12 center/cover no-repeat;transition:border-color var(--wdw-dur-fast) var(--wdw-linear),transform var(--wdw-dur) var(--wdw-ease),box-shadow var(--wdw-dur-fast) var(--wdw-linear)}',
      '#' + ID.root + ' .p-card:hover{border-color:rgba(255,255,255,.45);transform:translateY(-1px);box-shadow:0 6px 18px rgba(0,0,0,.35)}',
      '#' + ID.root + ' .p-card.wdw-cur{box-shadow:inset 0 0 0 2px var(--wdw-accent)}',
      '#' + ID.root + ' .p-card .cap{position:absolute;left:0;right:0;bottom:0;padding:3px 6px;font-size:10px;background:linear-gradient(transparent,rgba(0,0,0,.72));overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '#' + ID.root + ' .p-card .badge{position:absolute;top:4px;left:4px;padding:1px 5px;border-radius:999px;font-size:9px;background:rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.18)}',
      '#' + ID.root + ' .p-card .del{position:absolute;top:5px;right:31px;width:22px;height:22px;border-radius:50%;border:0;background:rgba(0,0,0,.55);color:#fff;cursor:pointer;font-size:12px;line-height:1;display:none}',
      '#' + ID.root + ' .p-card:hover .del{display:block}',
      // ── 壁纸仓库（标签 chips + 搜索 + 收藏星标）──
      '#' + ID.root + ' .p-repo{display:flex;gap:8px;align-items:center}',
      '#' + ID.root + ' .p-chips{display:flex;gap:4px;flex-wrap:wrap;flex:1 1 auto;min-width:0}',
      '#' + ID.root + ' .p-chips button{height:24px;padding:0 8px;border-radius:999px;border:1px solid var(--wdw-glass-line);background:var(--wdw-glass-fill);color:var(--wdw-ink-2);cursor:pointer;font-size:11px;line-height:1;transition:color var(--wdw-dur-fast) var(--wdw-linear),background var(--wdw-dur-fast) var(--wdw-linear)}',
      '#' + ID.root + ' .p-chips button:hover{color:var(--wdw-ink);background:var(--wdw-glass-fill-hi)}',
      '#' + ID.root + ' .p-chips button.wdw-on{background:color-mix(in srgb,var(--wdw-accent) 30%,transparent);border-color:color-mix(in srgb,var(--wdw-accent) 55%,transparent);color:var(--wdw-ink);font-weight:600}',
      '#' + ID.root + ' .p-search{flex:0 0 104px;height:24px;border-radius:999px;border:1px solid var(--wdw-glass-line);background:var(--wdw-glass-fill);color:inherit;font-size:11px;padding:0 9px;outline:none}',
      '#' + ID.root + ' .p-search:focus{border-color:color-mix(in srgb,var(--wdw-accent) 60%,transparent)}',
      '#' + ID.root + ' .p-repo-count{font-size:11px;color:var(--wdw-ink-3);padding:0 2px}',
      // 最近使用快捷段（E2）：横向一排小缩略图
      '#' + ID.root + ' .p-recent{display:flex;gap:8px;flex-wrap:wrap}',
      '#' + ID.root + ' .p-rcard{width:56px;height:36px;border-radius:8px;border:1px solid rgba(255,255,255,.14);background:#0b0d12 center/cover no-repeat;cursor:pointer;padding:0;flex:0 0 auto;transition:border-color var(--wdw-dur-fast) var(--wdw-linear),transform var(--wdw-dur) var(--wdw-ease)}',
      '#' + ID.root + ' .p-rcard:hover{border-color:rgba(255,255,255,.45);transform:translateY(-1px)}',
      // 收藏星标：圆形容器 + flex 居中（字体居中不能靠 default 的按钮内边距，会偏）
      '#' + ID.root + ' .p-card .star{position:absolute;top:5px;right:5px;width:22px;height:22px;box-sizing:border-box;border-radius:50%;border:0;background:rgba(0,0,0,.5);color:#ffd166;cursor:pointer;font-size:13px;line-height:1;display:flex;align-items:center;justify-content:center;padding:0;text-align:center;opacity:0;transition:opacity var(--wdw-dur-fast)}',
      '#' + ID.root + ' .p-card:hover .star{opacity:1}',
      '#' + ID.root + ' .p-card .star.wdw-on{opacity:1}',
      // 滑块 / 开关
      '#' + ID.root + ' input[type=range]{width:120px;accent-color:var(--wdw-accent)}',
      '#' + ID.root + ' .p-sw{position:relative;width:40px;height:22px;border-radius:999px;border:1px solid rgba(255,255,255,.18);background:var(--wdw-glass-fill);cursor:pointer;transition:background var(--wdw-dur-fast) var(--wdw-linear),border-color var(--wdw-dur-fast) var(--wdw-linear);flex:0 0 auto}',
      '#' + ID.root + ' .p-sw::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.35);transition:transform 160ms var(--wdw-ease)}',
      '#' + ID.root + ' .p-sw.wdw-on{background:color-mix(in srgb,var(--wdw-accent) 60%,transparent)}',
      '#' + ID.root + ' .p-sw.wdw-on::after{transform:translateX(18px)}',
      '#' + ID.root + ' select{height:var(--wdw-ui-h);border-radius:var(--wdw-ui-radius);border:1px solid var(--wdw-glass-line);background:var(--wdw-glass-fill);color:inherit;font-size:12px;padding:0 6px}',
      // 空态 / 提示
      '#' + ID.root + ' .p-empty{padding:14px;border-radius:12px;border:1px dashed rgba(255,255,255,.20);background:var(--wdw-glass-fill);color:var(--wdw-ink-3);font-size:12px;text-align:center}',
      '#' + ID.root + ' .p-hint{font-size:11px;color:var(--wdw-ink-3)}',
      // 作为 .p-row 右侧「状态标签」的 .p-hint（如「立绘模式」）：短标签不许被压成两行，也不许被截断，
      // 让左侧说明去换行。注意只有短标签挂 .p-tag —— 长说明文本要能换行，不能一刀切 nowrap（会顶出横向滚动）。
      '#' + ID.root + ' .p-row>.p-hint.p-tag{flex:0 0 auto;white-space:nowrap}',
      // 长路径型提示（工坊目录）：可压缩 + 省略号，避免把旁边的按钮挤出去
      '#' + ID.root + ' .p-row>.p-hint.p-path{flex:0 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      // 「系统」页：注入状态点 + 蒙版滑块
      '#' + ID.root + ' .p-st{display:inline-block;width:7px;height:7px;border-radius:50%;background:rgba(255,255,255,.35);margin-right:6px;vertical-align:1px}',
      '#' + ID.root + ' .p-st.is-ok{background:#3ddc84;box-shadow:0 0 0 2px rgba(61,220,132,.18)}',
      '#' + ID.root + ' .p-st.is-bad{background:#ff6b6b;box-shadow:0 0 0 2px rgba(255,107,107,.18)}',
      '#' + ID.root + ' .p-url{display:block;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}',
      '#' + ID.root + ' .p-range{width:100%;height:20px;margin:2px 0 4px;-webkit-appearance:none;appearance:none;background:transparent;cursor:pointer}',
      '#' + ID.root + ' .p-range::-webkit-slider-runnable-track{height:4px;border-radius:999px;background:linear-gradient(90deg,color-mix(in srgb,var(--wdw-accent) 70%,transparent),rgba(255,255,255,.18))}',
      '#' + ID.root + ' .p-range::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;margin-top:-5px;border-radius:50%;background:#fff;border:0;box-shadow:0 1px 4px rgba(0,0,0,.45)}',
      // 轻提示：底部浮一条，不占布局
      '#' + ID.root + ' .p-toast{position:absolute;left:12px;right:12px;bottom:44px;padding:8px 10px;border-radius:10px;background:rgba(20,22,28,.94);border:1px solid rgba(255,255,255,.16);color:var(--wdw-ink);font-size:11.5px;line-height:1.45;box-shadow:0 6px 22px rgba(0,0,0,.45);animation:wdw-tab-in .18s ease-out;z-index:2;word-break:break-all}',
      '#' + ID.root + ' .p-toast-act{margin-left:8px;padding:1px 8px;border-radius:6px;border:1px solid color-mix(in srgb,var(--wdw-accent) 60%,transparent);background:color-mix(in srgb,var(--wdw-accent) 24%,transparent);color:var(--wdw-ink);cursor:pointer;font-size:11px;white-space:nowrap}',
      // ── 字体页：调色盘 + 可搜索字体列表 ──
      '#' + ID.root + ' .p-colorwrap{display:flex;align-items:center;gap:8px}',
      '#' + ID.root + ' input[type=color]{width:40px;height:24px;padding:0;border:1px solid var(--wdw-glass-line);border-radius:8px;background:transparent;cursor:pointer}',
      '#' + ID.root + ' input[type=color]::-webkit-color-swatch-wrapper{padding:2px}',
      '#' + ID.root + ' input[type=color]::-webkit-color-swatch{border:0;border-radius:5px}',
      // 场景属性控件（P0-2.3）：颜色标签 + 下拉
      '#' + ID.root + ' .p-color{display:flex;align-items:center;gap:8px;flex:0 0 auto}',
      '#' + ID.root + ' .p-color span{font-size:11px;color:var(--wdw-ink-3);font-family:ui-monospace,SFMono-Regular,Consolas,monospace}',
      '#' + ID.root + ' .p-sel{height:26px;padding:0 8px;border-radius:8px;border:1px solid var(--wdw-glass-line,rgba(255,255,255,.12));background:rgba(255,255,255,.05);color:inherit;font-size:12px;cursor:pointer;max-width:140px}',
      '#' + ID.root + ' .p-swatches{display:flex;flex-wrap:wrap;gap:6px;max-width:146px;justify-content:flex-end}',
      '#' + ID.root + ' .p-swatch{width:22px;height:22px;padding:0;border-radius:6px;border:1px solid rgba(255,255,255,.28);cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,.25)}',
      '#' + ID.root + ' .p-swatch:hover{transform:scale(1.12)}',
      '#' + ID.root + ' .p-swatch.p-swatch--on{box-shadow:0 0 0 2px var(--wdw-accent,#4f8cff),0 1px 3px rgba(0,0,0,.25)}',
      '#' + ID.root + ' .p-fontlist{display:flex;flex-wrap:wrap;gap:6px;max-height:220px;overflow-y:auto;padding:6px;margin:4px 0 8px;border-radius:12px;background:var(--wdw-glass-fill,rgba(255,255,255,.05));border:1px solid var(--wdw-glass-line,rgba(255,255,255,.12))}',
      '#' + ID.root + ' .p-font{max-width:100%;height:26px;padding:0 9px;border-radius:8px;border:1px solid var(--wdw-glass-line,rgba(255,255,255,.12));background:rgba(255,255,255,.05);color:inherit;cursor:pointer;font-size:12px;line-height:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;transition:background var(--wdw-dur-fast)}',
      '#' + ID.root + ' .p-font:hover{background:rgba(255,255,255,.14)}',
      '#' + ID.root + ' .p-font.p-font--cur{border-color:var(--wdw-accent,#4f8cff);box-shadow:inset 0 0 0 1px var(--wdw-accent,#4f8cff)}',
      '#' + ID.root + ' .p-err{font-size:11px;color:#ff8080}',
      // 服务不可达提示条（红调：明显但不刺眼；带重试按钮）
      '#' + ID.root + ' .p-offline{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;border:1px solid rgba(255,128,128,.42);background:rgba(255,128,128,.10);color:#ffb3b3;font-size:11px;line-height:1.5}',
      '#' + ID.root + ' .p-offline .p-btn{height:22px;padding:0 8px;font-size:11px;flex:0 0 auto}',
      // 底部
      '#' + ID.root + ' .p-foot{flex:0 0 auto;padding:9px 14px;border-top:1px solid rgba(255,255,255,.10);font-size:11px;color:var(--wdw-ink-3);display:flex;gap:8px;align-items:center}',
      // 键盘可达：注入层默认没有焦点环（宿主 CSS 会吃掉），键盘用户看不到当前焦点
      '#' + ID.root + ' button:focus-visible,#' + ID.root + ' input:focus-visible,#' + ID.root + ' [tabindex]:focus-visible{outline:2px solid color-mix(in srgb,var(--wdw-accent) 80%,transparent);outline-offset:2px}',
    ].join('\n');
    if (s.textContent !== css) s.textContent = css;
  }

  // ── 片段构建 ────────────────────────────────────────────────────────────
  function row(label, hint, ctrl) {
    return '<div class="p-row"><span class="p-row-l"><b>' + esc(label) + '</b>' + (hint ? '<i>' + esc(hint) + '</i>' : '') + '</span>' + ctrl + '</div>';
  }
  function switchHtml(key, on) {
    return '<button class="p-sw' + (on ? ' wdw-on' : '') + '" type="button" role="switch" aria-checked="' + (!!on) + '" data-sw="' + key + '"></button>';
  }
  function starHtml(kind, id, on) {
    return '<button class="star' + (on ? ' wdw-on' : '') + '" type="button" data-fav="' + esc(kind + ':' + id) + '" title="' + (on ? '取消收藏' : '收藏') + '" aria-pressed="' + (!!on) + '">' + (on ? '★' : '☆') + '</button>';
  }
  function cardHtml(w, isCur) {
    var bg = w.thumb ? ' style="background-image:url(\'' + w.thumb + '\')"' : '';
    return '<div class="p-card' + (isCur ? ' wdw-cur' : '') + '" data-name="' + esc(w.name) + '" data-kind="file"' + bg + ' title="' + esc(w.title || w.name) + '">'
      + '<span class="cap">' + esc(w.title || w.name) + '</span>'
      + (w.badge ? '<span class="badge">' + esc(w.badge) + '</span>' : '')
      + starHtml('file', w.name, isFav('file', w.name))
      + '<button class="del" type="button" data-del="' + esc(w.name) + '" title="删除">✕</button>'
      + '</div>';
  }
  /** 仓库过滤：标签（全部/收藏/场景/视频/图片）+ 关键词（标题与文件名，忽略大小写）。 */
  function passFilter(it) {
    var f = st.rfilter || 'all';
    if (f === 'fav') { if (!isFav(it.kind, it.key)) return false; }
    else if (f !== 'all') { if (it.kindOf !== f) return false; }
    var q = String(st.rquery || '').trim().toLowerCase();
    if (q) {
      var hay = (String(it.title || '') + ' ' + String(it.name || it.id || '')).toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  }
  function repoCountText() {
    // ⚠️ 必须按「当前筛选后」计数：曾直接返回 items.length ⇒ 场景 14 / 视频 1 / 图片 0 都显示「15 项」，
    //    用户会以为筛选没生效（全尺寸复现）。
    if (st.source === 'we') {
      var all = (st.we && st.we.items) ? st.we.items.map(function (it) {
        return { id: String(it.id), key: String(it.id), kind: 'we', kindOf: (it.type === 'scene' ? 'scene' : 'video'), title: it.title, type: it.type };
      }) : [];
      return all.filter(passFilter).length + ' 项';
    }
    return st.custom.filter(passFilter).length + ' 张';
  }
  /** 接口地址短文本（宿主环境 apiBase 可能缺省 → 回退常见默认值）。 */
  function apiHostText() {
    var s = String(API || '').replace(/^https?:\/\//, '');
    return s || '127.0.0.1:47851';
  }
  /** 服务不可达提示条（fetch 失败时显示；带「重试」按钮重新拉取）。 */
  function offlineBarHtml() {
    if (!st.offline) return '';
    return '<div class="p-offline"><span>服务未连接（' + esc(apiHostText()) + '）：数据加载失败，请确认壁纸服务正在运行</span>'
      + '<button class="p-btn" type="button" data-act="retry">重试</button></div>';
  }

  // ── 各页渲染 ────────────────────────────────────────────────────────────
  /** 网格内容（带仓库过滤）。独立成函数 ⇒ 搜索/切标签时只重绘网格，输入框不丢焦点。 */
  function gridHtml() {
    if (st.source === 'custom') {
      var list = st.custom.filter(passFilter);
      if (!list.length) {
        var none = (st.rfilter !== 'all' || st.rquery)
          ? '没有匹配的壁纸（换个标签或清空搜索）'
          : (st.offline ? '服务未连接，无法加载壁纸' : '暂无自定义壁纸 —— 点下方「上传」添加');
        return '<div class="p-empty">' + esc(none) + '</div>';
      }
      return '<div class="p-grid">' + list.map(function (w) { return cardHtml(w, w.name === st.cur); }).join('') + '</div>';
    }
    var all = (st.we && st.we.items ? st.we.items : []).map(function (it) {
      return { id: String(it.id), key: String(it.id), kind: 'we', kindOf: (it.type === 'scene' ? 'scene' : 'video'), title: it.title, type: it.type, preview: it.preview || '' };
    });
    var items = all.filter(passFilter);
    if (!items.length) {
      var t = all.length ? '没有匹配的壁纸（换个标签或清空搜索）' : (st.weBusy ? '扫描中…' : '未发现创意工坊内容（点「扫描」重试）');
      return '<div class="p-empty">' + esc(t) + '</div>';
    }
    return '<div class="p-grid">' + items.map(function (it) {
      // 预览图（工坊目录里的 preview.gif/jpg/png，经通用静态路由直读）→ 卡片背景，不再黑块
      var pvStyle = it.preview
        ? ' style="background:url(' + API + '/wallpaper-engine/scene-files/' + esc(it.id) + '/' + encodeURIComponent(it.preview) + ') center/cover no-repeat #0b0d12"'
        : '';
      return '<div class="p-card' + (it.id === String(st.curWe) ? ' wdw-cur' : '') + '" data-we="' + esc(it.id) + '" data-kind="we" title="' + esc(it.title) + '"' + pvStyle + '>'
        + '<span class="badge">' + (it.type === 'scene' ? '场景' : '视频') + '</span>'
        + starHtml('we', it.id, isFav('we', it.id))
        + '<span class="cap">' + esc(it.title) + '</span></div>';
    }).join('') + '</div>';
  }

  function paneLibrary() {
    var seg = '<div class="p-seg">'
      + ['custom', 'we'].map(function (k) {
        var label = { custom: '自定义', we: 'WE 库' }[k];
        return '<button data-src="' + k + '" class="' + (st.source === k ? 'wdw-on' : '') + '">' + label + '</button>';
      }).join('') + '</div>';
    // 最近使用（E2）：库页顶部一排小缩略图，点击即重新应用，省去翻库
    var recent = st.recent || [];
    var recentBar = '';
    if (recent.length) {
      recentBar = '<div class="p-sec"><span class="p-sec-t">最近使用</span>'
        + '<div class="p-recent">'
        + recent.map(function (r) {
          var thumb = r.thumb || '';
          var style = thumb ? ' style="background-image:url(' + esc(thumb) + ')"' : '';
          return '<button type="button" class="p-rcard" data-recent="' + r.kind + ':' + esc(r.id) + '" title="' + esc(r.title || r.id) + '"' + style + '></button>';
        }).join('')
        + '</div></div>';
    }
    // 自动轮播（E1）：间隔档位，0=关闭；从当前源筛选后列表随机切换
    var rotOpts = [{ v: 0, t: '关' }, { v: 5, t: '5分' }, { v: 15, t: '15分' }, { v: 30, t: '30分' }, { v: 60, t: '60分' }];
    var rotateBar = '<div class="p-sec"><span class="p-sec-t">自动轮播</span>'
      + '<div class="p-row"><span class="p-row-l"><b>定时换壁纸</b><i>按间隔从当前列表随机切换</i></span></div>'
      + '<div class="p-seg">' + rotOpts.map(function (o) {
        return '<button type="button" data-act="rotate" data-v="' + o.v + '"' + (st.rotate === o.v ? ' class="wdw-on"' : '') + '>' + o.t + '</button>';
      }).join('') + '</div></div>';
    // 壁纸仓库条：标签 chips（全部/收藏/场景/视频/图片）+ 关键词搜索
    var repoBar = '<div class="p-repo">'
      + '<div class="p-chips">' + FILTERS.map(function (f) {
        return '<button type="button" data-rf="' + f.id + '" class="' + (st.rfilter === f.id ? 'wdw-on' : '') + '">' + f.label + '</button>';
      }).join('') + '</div>'
      + '<input id="wdw-repo-q" class="p-search" type="search" placeholder="搜索壁纸…" value="' + esc(st.rquery) + '"></div>';

    var foot = '';
    if (st.source === 'custom') {
      foot = '<div class="p-row"><input type="file" id="wdw-up-file" accept="image/*,video/*" style="display:none">'
        + '<span class="p-hint">支持图片（png/jpg/webp/gif）与视频（mp4/webm/ogg/mov）</span>'
        + '<button class="p-btn wdw-primary" data-act="upload"' + (st.uploadBusy ? ' disabled' : '') + '>' + (st.uploadBusy ? '上传中…' : '上传') + '</button></div>';
    } else if (st.source === 'we') {
      foot = '<div class="p-row"><span class="p-hint p-path">' + esc(st.we && st.we.roots ? st.we.roots[0] || '' : '') + '</span>'
        + '<button class="p-btn" data-act="scan-we"' + (st.weBusy ? ' disabled' : '') + '>' + (st.weBusy ? '扫描中…' : '扫描') + '</button></div>';
    }

    return '<div class="p-pane">' + seg + recentBar + rotateBar + repoBar + offlineBarHtml()
      + '<div class="p-repo-count"><span id="wdw-repo-count">' + esc(repoCountText()) + '</span></div>'
      + '<div id="wdw-repo-grid">' + gridHtml() + '</div>'
      + foot
      + (st.err ? '<div class="p-err">' + esc(st.err) + '</div>' : '')
      + '</div>';
  }

  // ── 字体页：调色盘（任意颜色）+ 可搜索的本机字体列表（即时生效，只存本机 UI）──
  function fontState() {
    try { return JSON.parse(localStorage.getItem(LS_FONT) || '{}') || {}; } catch (_) { return {}; }
  }
  function setFont(patch) {
    // 优先走注入层的统一入口（它负责即时重绘 <style>）；缺失则退化为直接写 localStorage。
    if (window.__wdwFont && typeof window.__wdwFont.set === 'function') {
      Object.keys(patch).forEach(function (k) { window.__wdwFont.set(k, patch[k]); });
      return;
    }
    var p = fontState(); Object.assign(p, patch);
    try { localStorage.setItem(LS_FONT, JSON.stringify(p)); } catch (_) {}
  }
  /** 字体名 → CSS 栈（去引号防注入，尾部挂通用兜底）。 */
  function fontStack(name) {
    var n = String(name || '').replace(/["\\;]/g, '').trim();
    return n ? ('"' + n + '",system-ui,sans-serif') : '';
  }
  /** 拉本机字体列表（只拉一次；失败标 offline）。 */
  function loadFonts() {
    if ((st.fonts && st.fonts.length) || st.fontsLoading) return Promise.resolve();
    st.fontsLoading = true;
    return req('/api/fonts').then(function (d) {
      st.fontsLoading = false;
      if (d && d.ok && Array.isArray(d.fonts)) { st.fonts = d.fonts; st.offline = false; }
      else if (d === null) { st.offline = true; }
    }).catch(function () { st.fontsLoading = false; });
  }
  /** 字体列表（按关键词过滤；每项用自身字体渲染做预览）。 */
  function fontListHtml(query) {
    var list = st.fonts || [];
    if (!list.length) return '<div class="p-empty">' + (st.offline ? '服务未连接，读不到字体列表' : '正在读取本机字体…') + '</div>';
    var cur = String(fontState().familyName || '');
    var q = String(query || '').trim().toLowerCase();
    var hit = q ? list.filter(function (n) { return n.toLowerCase().indexOf(q) >= 0; }) : list;
    if (!hit.length) return '<div class="p-empty">没有匹配的字体</div>';
    var shown = hit.slice(0, 150);
    return shown.map(function (n) {
      return '<button type="button" class="p-font' + (cur === n ? ' p-font--cur' : '') + '" data-font="' + esc(n) + '"'
        + ' style="font-family:' + esc(fontStack(n)) + '" title="' + esc(n) + '">' + esc(n) + '</button>';
    }).join('') + (hit.length > shown.length ? '<div class="p-hint">共 ' + hit.length + ' 个匹配，继续输入缩小范围</div>' : '');
  }
  function paneFont() {
    var fs = fontState();
    var color = String(fs.color || '');
    var famName = String(fs.familyName || '');
    var isHex = /^#[0-9a-fA-F]{6}$/.test(color);
    var total = (st.fonts && st.fonts.length) ? st.fonts.length : '…';
    return '<div class="p-pane">'
      + '<div class="p-sec"><span class="p-sec-t">文字颜色</span>'
      + row('调色盘', '任选颜色，即时生效',
        '<div class="p-colorwrap"><input type="color" id="wdw-fontcolor" value="' + (isHex ? color : '#ffffff') + '">'
        + '<span class="p-hint" id="wdw-fontcolor-v">' + esc(isHex ? color.toUpperCase() : '跟随主题') + '</span></div>')
      + row('常用色', '点一下就换成这个颜色',
        '<div class="p-swatches">' + FONT_SWATCHES.map(function (c) {
          var on = isHex && c.toLowerCase() === color.toLowerCase();
          return '<button type="button" class="p-swatch' + (on ? ' p-swatch--on' : '') + '" data-fontcolor="' + c + '" title="' + c + '" style="background:' + c + '"></button>';
        }).join('') + '</div>')
      + row('快捷', '纯白 / 纯黑 / 恢复默认',
        '<div class="p-seg" style="width:196px">' + FONT_COLORS.map(function (c) {
          var on = (c[0] === '') ? !isHex : (isHex && c[0].toLowerCase() === color.toLowerCase());
          return '<button data-fontcolor="' + c[0] + '" class="' + (on ? 'wdw-on' : '') + '">' + c[1] + '</button>';
        }).join('') + '</div>')
      + '</div>'
      + '<div class="p-sec"><span class="p-sec-t">字体</span>'
      + row('搜索字体', '本机已装 ' + total + ' 款，输入关键词过滤',
        '<input id="wdw-fontsearch" class="p-search" style="flex:0 0 132px" placeholder="雅黑 / Kai / Mono" value="' + esc(st.fontQuery || '') + '">')
      + '<div class="p-fontlist" id="wdw-fontlist">' + fontListHtml(st.fontQuery) + '</div>'
      + row('当前字体', esc(famName || '跟随主题'), '<button class="p-btn" type="button" data-act="font-reset">恢复默认</button>')
      + '</div>'
      + '<div class="p-hint">颜色与字体即时生效，只存本机 UI（localStorage ' + LS_FONT + '）。</div>'
      + '</div>';
  }
  /** 只重绘字体列表（不整页重绘 ⇒ 搜索框焦点/光标不丢）。 */
  function refreshFontList() {
    var box = document.getElementById('wdw-fontlist');
    if (box) box.innerHTML = fontListHtml(st.fontQuery);
  }

  function paneSystem() {
    var buddy = window.__wdwRopeBuddy;
    var inj = st.inj;
    var known = inj && inj.ok !== null && inj.ok !== undefined;
    var okNow = !!(inj && inj.ok);
    // 注入状态：服务活着 ≠ 页面里有 UI。这条以前完全没人报（2026-10-28 事故的根因之一）
    var stateTxt, stateCls;
    if (inj === undefined) { stateTxt = '读取中…'; stateCls = 'p-st'; }
    else if (!known) { stateTxt = '未知（注入器未上报）'; stateCls = 'p-st'; }
    else if (okNow) { stateTxt = '已注入 · ' + relTime(inj.at); stateCls = 'p-st is-ok'; }
    else { stateTxt = '未注入' + (inj.failures ? '（连续失败 ' + inj.failures + ' 次）' : ''); stateCls = 'p-st is-bad'; }
    var errLine = (inj && !okNow && inj.lastError)
      ? '<div class="p-err">' + esc(String(inj.lastError)) + '</div>' : '';

    var pct = st.mask == null ? null : Math.round(st.mask * 100);
    var presets = [['关', 0], ['轻', 25], ['中', 40], ['强', 60]];

    return '<div class="p-pane">' + offlineBarHtml()
      // ① 页面注入
      + '<div class="p-sec"><span class="p-sec-t">页面注入</span>'
      + '<div class="p-row"><span class="p-row-l"><b><i class="' + stateCls + '"></i>' + stateTxt + '</b>'
      + '<i>服务在跑不代表页面里有界面；注入丢失时点右侧重试</i></span>'
      + '<button class="p-btn" type="button" data-act="reinject"' + (st.reinjectBusy ? ' disabled' : '') + '>' +
      (st.reinjectBusy ? '注入中…' : '重新注入') + '</button></div>'
      + errLine
      + (inj && inj.pageUrl ? '<div class="p-hint p-url">' + esc(inj.pageUrl) + '</div>' : '')
      + '</div>'
      // ② 文字蒙版（壁纸亮时靠它保可读性；接口早就有，以前没有入口）
      + '<div class="p-sec"><span class="p-sec-t">文字蒙版</span>'
      + '<div class="p-row"><span class="p-row-l"><b>压暗浓度</b>'
      + '<i>壁纸太亮导致字看不清时调高；' + (pct == null ? '读取中…' : '当前 ' + pct + '%') + '</i></span>'
      + '<span class="p-hint p-tag">' + (pct == null ? '—' : pct + '%') + '</span></div>'
      + '<input class="p-range" id="wdw-mask" type="range" min="0" max="70" step="5" value="' + (pct == null ? 0 : pct) + '">'
      + '<div class="p-seg">' + presets.map(function (p) {
        var on = pct != null && Math.abs(pct - p[1]) < 3;
        return '<button type="button" data-act="mask-preset" data-v="' + (p[1] / 100) + '"' + (on ? ' class="wdw-on"' : '') + '>' + p[0] + '</button>';
      }).join('') + '</div>'
      + '</div>'
      // ②a 玻璃浓度（可读性下限，借鉴 dsh-wallpaper-engine 的 Readability Floor）：
      //     面板玻璃底之下垫一层固定不透明度的主题底（floor=0.59），玻璃浓度只在「下限之上」
      //     叠加 —— 用户怎么调都不会把文字调得看不清。纯前端（localStorage + CSS 变量）。
      + (function () {
        var g = st.glass == null ? 62 : st.glass;
        return '<div class="p-sec"><span class="p-sec-t">玻璃浓度</span>'
          + '<div class="p-row"><span class="p-row-l"><b>面板玻璃</b>'
          + '<i>调低更通透、调高更实；可读性下限已兜底，不会调到看不清字</i></span>'
          + '<span class="p-hint p-tag" data-glass-pct>' + g + '%</span></div>'
          + '<input class="p-range" id="wdw-glass" type="range" min="0" max="100" step="5" value="' + g + '">'
          + '</div>';
      })()
      // ②a′ 外观预设（借鉴 dsh 的 glass-presets）：accent + 玻璃浓度 + 蒙版 整套快照一键切换。
      + (function () {
        var cur = '';
        try { cur = localStorage.getItem('wdw.accent') || ''; } catch (_) {}
        return '<div class="p-sec"><span class="p-sec-t">外观预设</span>'
          + '<div class="p-hint">一键切换整套外观（强调色 + 玻璃 + 蒙版）</div>'
          + '<div class="p-chips">'
          + LOOK_PRESETS.map(function (p) {
            var on = p.accent === cur || (p.id === 'follow' && !cur);
            return '<button type="button" data-act="look-preset" data-v="' + p.id + '"' + (on ? ' class="wdw-on"' : '') + '>' + p.name + '</button>';
          }).join('')
          + '</div>'
          + '<div class="p-row"><span class="p-row-l"><b>强调色</b><i>手动覆盖壁纸主色；「跟随壁纸」清除覆盖</i></span>'
          + '<label class="p-color"><input type="color" id="wdw-accent-color" data-act="accent-color" value="' + (cur || '#4f8cff') + '"><span>' + (cur || '跟随') + '</span></label></div>'
          + '</div>';
      })()
      // ②b 动态效果（P0-2.3）：昼夜循环 + 鼠标视差。开关写 localStorage，重注入即时生效。
      + (function () {
        var cap = st.fx || { daynight: false, parallax: false };
        var pre = fxPrefs();
        function sw(key, id, label, tip, supported, on) {
          return '<div class="p-row"><span class="p-row-l"><b>' + label + '</b><i>' + tip + '</i></span>'
            + '<button type="button" class="p-sw' + (on ? ' wdw-on' : '') + '" data-fx="' + key + '"' + (supported ? '' : ' disabled title="当前壁纸不支持"') + ' role="switch" aria-checked="' + (on ? 'true' : 'false') + '"></button></div>';
        }
        var dnOn = cap.daynight && pre.daynight;
        var pxOn = cap.parallax && pre.parallax;
        return '<div class="p-sec"><span class="p-sec-t">动态效果</span>'
          + sw(LS_FX_DAYNIGHT, 'fx-daynight', '昼夜循环', cap.daynight ? '按本地时间在日/夜帧间平滑过渡（需壁纸自带多帧）' : '当前壁纸无多帧素材，暂不支持', cap.daynight, dnOn)
          + sw(LS_FX_PARALLAX, 'fx-parallax', '鼠标视差', cap.parallax ? '背景随鼠标轻微位移，鼠标离开后自动回中' : '当前壁纸未开启视差', cap.parallax, pxOn)
          + (st.fxBusy ? '<div class="p-hint">正在应用动态效果…</div>' : '')
          + '</div>';
      })()
      // ②c 场景属性（P0-2.3）：当前壁纸是 WE 场景且带 general.properties 时，显示可调控件。
      //     类型：bool（开关）/ slider（min-max 滑块）/ color（RGB 色块）/ combo（下拉）。
      //     改动即时写回（POST /api/we-properties），服务端落盘 + 重注入。
      + (function () {
        var p = st.scProps;
        if (!p || !p.length) return '';
        function row(item) {
          var key = item.key, label = item.text, t = item.type;
          if (t === 'bool') {
            return '<div class="p-row"><span class="p-row-l"><b>' + esc(label) + '</b><i>' + esc(key) + '</i></span>'
              + '<button type="button" class="p-sw' + (item.value ? ' wdw-on' : '') + '" data-scprop="' + esc(key) + '" data-type="bool" data-v="' + (item.value ? '1' : '0') + '" role="switch" aria-checked="' + (item.value ? 'true' : 'false') + '"></button></div>';
          }
          if (t === 'slider') {
            return '<div class="p-row"><span class="p-row-l"><b>' + esc(label) + '</b><i>' + esc(key) + ' · ' + Number(item.value).toFixed(3) + '</i></span></div>'
              + '<input class="p-range" data-scprop="' + esc(key) + '" data-type="slider" type="range" min="' + item.min + '" max="' + item.max + '" step="' + Math.max(Math.abs(item.max - item.min) / 100, 0.001) + '" value="' + item.value + '">';
          }
          if (t === 'color') {
            var rgb = String(item.value).trim().split(/\s+/).map(function (x) { return Math.round(Math.min(1, Math.max(0, Number(x) || 0)) * 255); });
            var hex = '#' + rgb.map(function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
            return '<div class="p-row"><span class="p-row-l"><b>' + esc(label) + '</b><i>' + esc(key) + '</i></span>'
              + '<label class="p-color"><input type="color" data-scprop="' + esc(key) + '" data-type="color" value="' + hex + '"><span>' + hex + '</span></label></div>';
          }
          if (t === 'combo') {
            var opts = item.options || [];
            return '<div class="p-row"><span class="p-row-l"><b>' + esc(label) + '</b><i>' + esc(key) + '</i></span>'
              + '<select class="p-sel" data-scprop="' + esc(key) + '" data-type="combo">'
              + opts.map(function (o, i) { return '<option value="' + i + '"' + (Number(item.value) === i ? ' selected' : '') + '>' + esc(o) + '</option>'; }).join('')
              + '</select></div>';
          }
          // 未知/文本类型：只读展示当前值
          return '<div class="p-row"><span class="p-row-l"><b>' + esc(label) + '</b><i>' + esc(key) + '</i></span>'
            + '<span class="p-hint p-tag">' + esc(String(item.value)) + '</span></div>';
        }
        return '<div class="p-sec"><span class="p-sec-t">场景属性</span>'
          + p.map(row).join('')
          + '<div class="p-row"><span class="p-hint">'
          + (st.scPropsBusy ? '正在应用…' : (st.scPropsMsg ? esc(st.scPropsMsg) : '改动即时生效并保存到该壁纸'))
          + '</span></div>'
          + '</div>';
      })()
      // ③ 吉祥物
      + '<div class="p-sec"><span class="p-sec-t">吉祥物（拉绳 Buddy）</span>'
      + '<div class="p-row"><span class="p-row-l"><b>拉绳 Buddy</b><i>常驻窗口顶部，抓着绳子悬挂；按住可拖到任意位置，松开吸附顶边</i></span>'
      + '<span class="p-hint p-tag">' + (buddy && buddy.el && buddy.el.classList.contains('wdw-has-art') ? '立绘模式' : '矢量形象') + '</span></div>'
      + '</div>'
      // ④ 渲染模式：场景壁纸"糊 + 烫"的真因，不在壁纸文件也不在缩放，而在宿主是否用显卡跑 WebGL。
      //    2026-10-28 实测本机：gpu_compositing/rasterization/webgl 全是 disabled_software，
      //    场景画布只剩 960×516（铺 1920×1032）且 GPU 进程吃 1267% CPU。用户无从得知，所以放到面板上。
      + (function () {
        var r = renderInfo();
        var bad = r.software === true;
        var short = bad ? '软件渲染（CPU）' : (r.ok ? '硬件渲染（显卡）' : '未知');
        var tip = bad
          ? '场景壁纸会发糊且极耗 CPU（实测 13 核）；图片/视频壁纸不受影响'
          : (r.ok ? '场景壁纸由显卡渲染，可正常出图' : '没拿到 WebGL 后端信息');
        return '<div class="p-sec"><span class="p-sec-t">渲染模式</span>'
          + '<div class="p-row"><span class="p-row-l"><b>' + short + '</b><i>' + tip + '</i></span>'
          + '<span class="p-hint p-tag">' + (r.ok ? (bad ? 'CPU' : 'GPU') : '—') + '</span></div>'
          + (r.name ? '<div class="p-hint p-url" title="' + esc(r.name) + '">' + esc(r.name) + '</div>' : '')
          + '</div>';
      })()
      // ④b 场景帧率档位（P0-2.3 + 3.1 合一）：给场景壁纸设帧率上限，软件渲染时自动压到最低档。
      //     为什么放这里：帧率上限直接决定 GPU 占用；软件渲染（CPU）跑场景最吃核，默认就该最低。
      + (function () {
        var r = renderInfo();
        var bad = r.software === true;
        var opts = [{ v: 30, t: '30 fps' }, { v: 24, t: '24 fps' }, { v: 15, t: '15 fps' }];
        var cur = bad ? 15 : st.sceneFps;   // 软件渲染强制最低档（3.1 智能降级）
        var tip = bad
          ? '检测到软件渲染，已自动降到 15 fps（省核）；换显卡后可手动调高'
          : '场景壁纸帧率上限，越低越省 GPU；视频/图片壁纸不受影响';
        return '<div class="p-sec"><span class="p-sec-t">场景帧率</span>'
          + '<div class="p-hint">' + esc(tip) + '</div>'
          + '<div class="p-seg">'
          + opts.map(function (o) {
            var on = o.v === cur;
            return '<button type="button" data-act="scene-fps" data-v="' + o.v + '"' + (on ? ' class="wdw-on"' : '') + (bad ? ' disabled title="软件渲染下固定 15 fps"' : '') + '>' + o.t + '</button>';
          }).join('')
          + '</div></div>';
      })()
      // ④c 视频播放（#1）：倍速 + 静音，直接操作 wdw-bg-video 元素
      + (function () {
        var rates = [{ v: 0.5, t: '0.5x' }, { v: 0.75, t: '0.75x' }, { v: 1, t: '1x' }, { v: 1.25, t: '1.25x' }, { v: 1.5, t: '1.5x' }, { v: 2, t: '2x' }];
        return '<div class="p-sec"><span class="p-sec-t">视频播放</span>'
          + '<div class="p-row"><span class="p-row-l"><b>倍速</b><i>视频壁纸播放速度；图片/场景壁纸不受影响</i></span></div>'
          + '<div class="p-seg">' + rates.map(function (o) {
            var on = Math.abs(st.vrate - o.v) < 0.01;
            return '<button type="button" data-act="vrate" data-v="' + o.v + '"' + (on ? ' class="wdw-on"' : '') + '>' + o.t + '</button>';
          }).join('') + '</div>'
          + '<div class="p-row"><span class="p-row-l"><b>静音</b><i>视频壁纸是否出声</i></span>'
          + '<button type="button" class="p-sw' + (st.vmuted ? ' wdw-on' : '') + '" data-act="vmuted" role="switch" aria-checked="' + (st.vmuted ? 'true' : 'false') + '"></button></div>'
          + '</div>';
      })()
      + '</div>';
  }

  /**
   * 宿主实际使用的 WebGL 后端（只探测一次并缓存）。
   * 为什么放在面板里：软件渲染是"壁纸为什么糊"的唯一硬解释，
   * 而它既不在日志里、也不在任何状态接口里，用户完全看不到。
   */
  function renderInfo() {
    if (st.render) return st.render;
    var out = { ok: false, software: null, name: '' };
    try {
      var c = document.createElement('canvas');
      var gl = c.getContext('webgl2') || c.getContext('webgl');
      if (!gl) {
        out.software = true;
        out.name = 'WebGL 不可用（回退软件）';
      } else {
        var dbg = gl.getExtension('WEBGL_debug_renderer_info');
        out.name = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) || '');
        // SwiftShader / llvmpipe / Basic Render 都是软件后端；ANGLE(D3D11)/NVIDIA/AMD/Intel 才是显卡
        out.software = /swiftshader|llvmpipe|softpipe|software|basic render/i.test(out.name);
        out.ok = true;
      }
    } catch (e) { out.name = '检测失败：' + (e && e.message ? e.message : e); }
    st.render = out;
    return out;
  }

  function paneExtensions() {
    return '<div class="p-pane">'
      + '<div class="p-sec"><span class="p-sec-t">运行方式</span>'
      + row('本地服务', '零依赖 Node 服务，只监听本机回环地址', '<span class="p-hint">127.0.0.1:47851</span>')
      + row('页面注入', '通过调试通道注入界面，不改动宿主任何文件', '<span class="p-hint">CDP</span>')
      + '</div>'
      + '<div class="p-sec"><span class="p-sec-t">数据位置</span>'
      + row('仓库收藏', '收藏与过滤状态只存本机 UI（localStorage）', '<span class="p-hint">wdw.repo</span>')
      + '</div>'
      + '<div class="p-hint">扩展页预留：后续接第三方壁纸源与自动化触发。</div>'
      + '</div>';
  }

  // ── 更新机制（数据来自服务端 /api/update*）───────────────────────────────
  // 三条不变量：
  //   ① 打开面板**只读缓存**（`/api/update` 不发网络）→ 面板永远不会因为网络卡住；
  //   ② 缓存过期（>1h）才后台补一次真检查，失败只落到 st.updErr，不影响其它页；
  //   ③ 真正动手（apply/rollback）必须先 window.confirm —— 会替换已安装文件。
  var UPDATE_STALE_MS = 3600000;

  function loadUpdate(forceCheck) {
    return req('/api/update').then(function (d) {
      if (d == null) { st.updErr = '服务不可达'; return null; }
      st.upd = d;
      var stale = !d.lastCheckAt || (Date.now() - Number(d.lastCheckAt) > UPDATE_STALE_MS);
      if (forceCheck || stale) return doCheck(false);
      return d;
    }).catch(function () { return null; });
  }

  function doCheck(force) {
    st.updBusy = 'check'; st.updErr = ''; st.updMsg = ''; paint();
    return req('/api/update/check', { force: !!force }).then(function (d) {
      st.updBusy = '';
      if (d == null) { st.updErr = '服务不可达，检查失败'; paint(); return null; }
      st.upd = d;
      if (d.ok === false && d.error) st.updErr = '检查失败：' + d.error;
      else if (d.checkedAt) st.updMsg = '检查完成（' + (d.hasUpdate ? '有新版本 v' + d.latest : '已是最新') + '）';
      paint();
      return d;
    }).catch(function (e) { st.updBusy = ''; st.updErr = '检查异常：' + ((e && e.message) || e); paint(); return null; });
  }

  function doApply() {
    var u = st.upd || {};
    var v = u.latest;
    if (!v) { st.updErr = '还没有可用的新版本信息，先点「检查更新」'; paint(); return; }
    if (window.confirm && !window.confirm('更新到 v' + v + '？\n\n将自动：下载 → 校验 sha256 → 备份当前版本 → 覆盖 → 重启壁纸服务。\n更新期间壁纸会消失几秒（服务重启）。\n\n旧版本会留在数据目录 versions/ 下，可随时回滚。')) return;
    st.updBusy = 'apply'; st.updErr = ''; st.updMsg = ''; paint();
    req('/api/update/apply', { expectVersion: v }).then(function (d) {
      st.updBusy = '';
      if (d == null) { st.updErr = '服务不可达（可能已在重启），稍等 5 秒再打开面板看版本'; paint(); return; }
      if (d.ok === false) { st.updErr = '更新失败：' + (d.error || ''); paint(); return; }
      st.updMsg = '已更新到 v' + d.version + '，服务正在重启（约 5 秒）。' +
        (d.watchdogChanged ? ' 看门狗的代码也变了 —— 它会在下次开机/登录时换新。' : '');
      st.upd = Object.assign({}, st.upd, { hasUpdate: false, currentVersion: d.version, mustUpdate: false, notes: '' });
      paint();
    }).catch(function (e) {
      st.updBusy = '';
      st.updErr = '更新异常：' + ((e && e.message) || e) + '（服务可能已重启，稍后重开面板核对版本）';
      paint();
    });
  }

  function doRollback(ver) {
    if (window.confirm && !window.confirm('回滚到 v' + ver + '？\n\n会用备份覆盖当前已安装的文件，然后重启服务。')) return;
    st.updBusy = 'rollback'; st.updErr = ''; st.updMsg = ''; paint();
    req('/api/update/rollback', { version: ver }).then(function (d) {
      st.updBusy = '';
      if (d == null || d.ok === false) { st.updErr = '回滚失败：' + ((d && d.error) || '服务不可达'); paint(); return; }
      st.updMsg = '已回滚到 v' + d.version + '，服务正在重启（约 5 秒）。';
      paint();
    }).catch(function (e) { st.updBusy = ''; st.updErr = '回滚异常：' + ((e && e.message) || e); paint(); });
  }

  function paneAbout() {
    // u 来自 `/api/update`（纯读缓存，不发网络）—— 所以打开面板不会卡。
    var u = st.upd || {};
    // 兜底版本号保持字面量：verify.js [9] 段会断言它与 package.json 一致（防版本号漂移）
    var cur = u.currentVersion || '1.2.5';
    var hasNew = !!u.hasUpdate;
    var must = !!u.mustUpdate;
    var busy = st.updBusy || '';
    var cls = 'p-upd' + (must ? ' wdw-must' : (hasNew ? ' wdw-new' : ''));

    var head = must ? '必须更新（低于最低支持版本）'
      : hasNew ? ('发现新版本 v' + esc(u.latest || ''))
      : (u.checked ? '已是最新版本' : '还没检查过');

    var lines = [];
    lines.push('<div class="' + cls + '">');
    lines.push('<div class="p-upd-h">' + (busy ? '⋯ ' : '') + esc(head) + '</div>');
    if (hasNew || must) {
      lines.push('<div class="p-upd-meta">当前 v' + esc(cur) + ' → 最新 v' + esc(u.latest || '') +
        (u.minSupported ? ('　最低支持 v' + esc(u.minSupported)) : '') + '</div>');
    }
    if (u.notes) lines.push('<div class="p-upd-note">' + esc(String(u.notes).slice(0, 1200)) + '</div>');

    // 动作按钮
    var acts = [];
    acts.push('<button class="p-btn" type="button" data-act="check-update"' + (busy ? ' disabled' : '') + '>' +
      (busy === 'check' ? '检查中…' : '检查更新') + '</button>');
    if (hasNew && u.canUpdate) {
      acts.push('<button class="p-btn wdw-primary" type="button" data-act="apply-update"' + (busy ? ' disabled' : '') + '>' +
        (busy === 'apply' ? '更新中…' : '立即更新') + '</button>');
    }
    if (u.homepage) {
      acts.push('<button class="p-btn" type="button" data-act="open-home">打开发布页</button>');
    }
    lines.push('<div class="p-upd-acts">' + acts.join('') + '</div>');

    // 上次检查 / 失败原因 / 更新源
    var meta = [];
    if (u.lastCheckAt) {
      var d = new Date(u.lastCheckAt);
      meta.push('上次检查 ' + d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
        ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()));
    } else meta.push('从未检查过');
    if (u.error) meta.push('失败：' + esc(String(u.error).slice(0, 240)));
    else if (u.source) meta.push('源 ' + esc(String(u.source).replace(/^https?:\/\//, '').slice(0, 90)));
    if (u.disabled) meta.push('更新检查已在配置里关闭');
    lines.push('<div class="p-upd-meta">' + meta.join('<br>') + '</div>');

    // 回滚（有备份才显示）
    var bks = u.backups || [];
    if (bks.length) {
      var b0 = bks[0];
      lines.push('<div class="p-upd-acts"><button class="p-btn" type="button" data-act="rollback" data-ver="' +
        esc(b0.version) + '"' + (busy ? ' disabled' : '') + '>' +
        (busy === 'rollback' ? '回滚中…' : '回滚到 v' + esc(b0.version)) + '</button>' +
        '<span class="p-upd-meta" style="align-self:center">共 ' + bks.length + ' 份备份</span></div>');
    }
    if (st.updErr) lines.push('<div class="p-upd-meta">' + esc(st.updErr) + '</div>');
    if (st.updMsg) lines.push('<div class="p-upd-meta">' + esc(st.updMsg) + '</div>');
    lines.push('</div>');

    return '<div class="p-pane">'
      + '<div class="p-sec"><span class="p-sec-t">壁纸引擎</span>'
      + row('版本', '插件内核 workdaddy.wallpaper', '<span class="p-hint">v' + esc(cur) + '</span>')
      + row('UI 规格', '原创玻璃拟态视觉语言', '<span class="p-hint">rope dock + 5 页签</span>')
      + row('许可', 'AGPL-3.0-or-later', '<span class="p-hint">含 MIT 第三方声明</span>')
      + '</div>'
      + '<div class="p-sec"><span class="p-sec-t">更新</span>' + lines.join('') + '</div>'
      + '<div class="p-sec"><span class="p-sec-t">数据</span>'
      + row('接口地址', '内核 HTTP API', '<span class="p-hint">' + esc(API.replace(/^https?:\/\//, '')) + '</span>')
      + row('当前壁纸', '', '<span class="p-hint">' + esc(st.curTitle || st.cur || '—') + '</span>')
      + '</div>'
      + '<div class="p-sec"><span class="p-sec-t">壁纸开关</span>'
      // 拆分理由：旧版只有一个「关闭壁纸」= 写 .stopped + 服务退出 + 看门狗不再拉起，
      // 想要「先关一会儿」的用户实际执行了「卸载」，而且面板一起消失、无法自救。
      // 现在：暂停是纯背景层操作（服务/看门狗/面板都不动），退出才是原来的 .stopped。
      + row(st.paused ? '恢复壁纸' : '暂停壁纸',
        st.paused ? '重新把背景铺回页面（不影响其它状态）' : '暂时隐藏壁纸，面板与吉祥物保留，随时可恢复',
        '<button class="p-btn' + (st.paused ? ' wdw-primary' : '') + '" type="button" data-act="pause-toggle"'
          + (st.pauseBusy ? ' disabled' : '') + '>'
          + (st.pauseBusy ? '处理中…' : (st.paused ? '恢复壁纸' : '暂停壁纸')) + '</button>')
      + row('退出插件', '停止服务并移除页面上的壁纸与面板（需手动运行启动脚本才能恢复）',
        '<button class="p-btn wdw-danger" type="button" data-act="shutdown">退出插件</button>')
      + (st.paused ? '<div class="p-hint p-note">当前为「暂停中」：服务仍在运行，吉祥物与面板可用。</div>' : '')
      + '</div>'
      + '</div>';
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  /** 相对时间：注入状态要显示"多久之前注入的"，比时间戳好读 */
  function relTime(ts) {
    if (!ts) return '—';
    var d = Date.now() - Number(ts);
    if (!isFinite(d) || d < 0) return '刚刚';
    if (d < 60000) return '刚刚';
    if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
    if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
    return Math.floor(d / 86400000) + ' 天前';
  }

  function paneHtml() {
    // 轻提示（应用壁纸/上传完成）：挂在每个 pane 末尾，paint 重建 body 时自然跟着刷新
    var tip = st.toast
      ? '<div class="p-toast">' + esc(st.toast)
        + (st.toastAct ? ' <button type="button" class="p-toast-act" data-act="' + esc(st.toastAct) + '">撤销</button>' : '')
        + '</div>'
      : '';
    var body;
    switch (st.tab) {
      case 'font': body = paneFont(); break;
      case 'system': body = paneSystem(); break;
      case 'extensions': body = paneExtensions(); break;
      case 'about': body = paneAbout(); break;
      default: body = paneLibrary();
    }
    return tip ? body.replace(/<\/div>\s*$/, tip + '</div>') : body;
  }

  /** 轻提示：默认 1.6s 自动消失；长消息给久一点 */
  var toastTimer = null;
  function toast(msg, ms, act) {
    st.toast = msg || '';
    st.toastAct = act || '';
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    if (st.toast) {
      toastTimer = setTimeout(function () { st.toast = ''; st.toastAct = ''; paint(); }, ms || 1600);
      if (toastTimer.unref) toastTimer.unref();
    }
    paint();
  }

  // ── 骨架 ────────────────────────────────────────────────────────────────
  // WIRE_VER：面板结构/行为变更时 +1。重注入（CDP 重连补注入）会重建元素，
  // 避免旧闭包的事件监听与新 __wdwPanel 状态 divergence（双闭包串味）。
  var WIRE_VER = '6';   // 6：系统页新增渲染模式诊断；5：壁纸开关拆成暂停/退出（结构变更才 bump，纯样式不要）
  function build() {
    var el = document.getElementById(ID.root);
    if (el && el.getAttribute('data-wdw-ver') !== WIRE_VER) { try { el.remove(); } catch (_) {} el = null; }
    if (!el) {
      el = document.createElement('aside');
      el.id = ID.root;
      el.setAttribute('data-wdw-ver', WIRE_VER);
      el.innerHTML = [
        '<div class="p-head"><b class="p-title">壁纸</b><button class="p-x" type="button" data-act="close" title="关闭面板 · Esc" aria-label="关闭面板">✕</button></div>',
        '<div class="p-tabs" role="tablist"><span class="p-tabs__pill"></span>',
        TABS.map(function (t) {
          var dot = (t.id === 'about' && st.upd && st.upd.hasUpdate) ? '<i class="p-dot"></i>' : '';
          return '<button class="p-tab" type="button" role="tab" data-tab="' + t.id + '">' + t.label + dot + '</button>';
        }).join(''),
        '</div>',
        '<div class="p-body" id="wdw-panel-body"></div>',
        '<div class="p-foot"><span>workbuddy-wallpaper · 原创壁纸 UI</span></div>',
      ].join('');
      (document.body || document.documentElement).appendChild(el);
      wire(el);
    }
    return el;
  }

  function movePill(el) {
    var tabs = el.querySelectorAll('.p-tab');
    var idx = 0;
    for (var i = 0; i < tabs.length; i++) if (tabs[i].getAttribute('data-tab') === st.tab) idx = i;
    var pill = el.querySelector('.p-tabs__pill');
    if (!pill || !tabs.length) return;
    var w = tabs[0].getBoundingClientRect().width || (tabs[0].offsetWidth);
    if (!w) { pill.style.width = 'calc(' + (100 / tabs.length) + '% - 6px)'; pill.style.transform = 'translateX(' + (idx * 100) + '%)'; return; }
    pill.style.width = w + 'px';
    pill.style.transform = 'translateX(' + (idx * (w + 0)) + 'px)';
  }

  /** 只重绘仓库网格（切标签 / 搜索时用：整页重绘会让输入框失焦）。 */
  function refreshRepoGrid() {
    var el = document.getElementById(ID.root);
    if (!el) return;
    var g = el.querySelector('#wdw-repo-grid');
    if (g) g.innerHTML = gridHtml();
    var chips = el.querySelectorAll('[data-rf]');
    for (var i = 0; i < chips.length; i++) chips[i].classList.toggle('wdw-on', chips[i].getAttribute('data-rf') === (st.rfilter || 'all'));
    var c = el.querySelector('#wdw-repo-count');
    if (c) c.textContent = repoCountText();
  }

  function paint() {
    var el = document.getElementById(ID.root);
    if (!el) return;
    var tabs = el.querySelectorAll('.p-tab');
    for (var i = 0; i < tabs.length; i++) {
      var on = tabs[i].getAttribute('data-tab') === st.tab;
      tabs[i].classList.toggle('wdw-on', on);
      tabs[i].setAttribute('aria-selected', String(on));
    }
    // 「关于」页签的小红点：必须在这里同步。
    // ⚠️ 页签按钮是骨架里**一次性**建好的（build()），paint() 只重绘 body ——
    //    所以只在 build() 里画红点的话，更新状态变化永远不会反映到页签上（实测踩过）。
    var aboutTab = null;
    for (var k = 0; k < tabs.length; k++) if (tabs[k].getAttribute('data-tab') === 'about') aboutTab = tabs[k];
    if (aboutTab) {
      var want = !!(st.upd && st.upd.hasUpdate);
      var existDot = aboutTab.querySelector('.p-dot');
      if (want && !existDot) {
        var dot = document.createElement('i'); dot.className = 'p-dot';
        aboutTab.appendChild(dot);
      } else if (!want && existDot) {
        try { existDot.remove(); } catch (_) {}
      }
    }
    el.querySelector('#wdw-panel-body').innerHTML = paneHtml();
    movePill(el);
  }

  // ── 数据 ────────────────────────────────────────────────────────────────
  function loadWallpapers() {
    return req('/api/wallpapers').then(function (d) {
      if (d == null) { st.offline = true; return; }   // 服务不可达：转错误态而非静默
      st.offline = false;
      if (!d.ok) return;
      var all = d.wallpapers || [];
      st.cur = d.currentWallpaper || st.cur;
      st.curWe = d.weId || st.curWe;
      st.curTitle = d.currentTitle || st.curTitle;
      // 暂停是服务端状态（.paused 标志），必须回填：否则重开面板按钮仍显示「暂停壁纸」，
      // 用户点了才发现"已经在暂停中"，看起来像按钮坏了。
      if (typeof d.paused === 'boolean') st.paused = d.paused;
      // 动态效果能力（P0-2.3）：当前主题是否支持昼夜循环 / 视差
      if (d.fx) st.fx = { daynight: !!d.fx.daynight, parallax: !!d.fx.parallax };
      else st.fx = { daynight: false, parallax: false };
      // 场景属性（P0-2.3）：当前壁纸是 WE 场景且有 weId 时，拉取可调属性表
      if (d.weId) return loadSceneProps(String(d.weId));
    });
  }
  /** 拉取场景可调属性（GET /api/we-properties?weId=）。失败不阻塞主流程。 */
  function loadSceneProps(weId) {
    return req('/api/we-properties?weId=' + encodeURIComponent(weId)).then(function (d) {
      if (d && d.ok && Array.isArray(d.properties) && d.properties.length) {
        st.scProps = d.properties;
      } else {
        st.scProps = null;
      }
    }).catch(function () { st.scProps = null; });
  }
  /** 场景属性值本地改动（未提交）。 */
  function setSceneProp(key, value) {
    if (!st.scProps) return;
    for (var i = 0; i < st.scProps.length; i++) {
      if (st.scProps[i].key === key) { st.scProps[i].value = value; break; }
    }
    paint();
  }
  /** 提交场景属性（POST /api/we-properties）→ 服务端落盘 + 重注入。 */
  function commitSceneProps() {
    if (!st.scProps) return Promise.resolve();
    var props = {};
    st.scProps.forEach(function (p) { props[p.key] = p.value; });
    st.scPropsBusy = true; st.scPropsMsg = ''; paint();
    return req('/api/we-properties', { id: 'standalone', properties: props }).then(function (d) {
      st.scPropsBusy = false;
      if (d && d.ok) {
        st.scPropsMsg = d.applied === false ? '已保存（宿主未连接，恢复后生效）' : '已应用';
      } else {
        st.scPropsMsg = (d && d.error) || '应用失败';
      }
      paint();
    }).catch(function () { st.scPropsBusy = false; st.scPropsMsg = '应用失败（服务未响应）'; paint(); });
  }
  /** 动态效果本地开关（缺省按主题能力；写 localStorage，与 background.js 读同一键）。 */
  function fxPrefs() {
    if (st.fxDaynight === null || st.fxParallax === null) {
      try {
        st.fxDaynight = localStorage.getItem(LS_FX_DAYNIGHT) !== 'off';
        st.fxParallax = localStorage.getItem(LS_FX_PARALLAX) !== 'off';
      } catch (_) { st.fxDaynight = true; st.fxParallax = true; }
    }
    return { daynight: st.fxDaynight, parallax: st.fxParallax };
  }
  /** 切换动态效果开关并即时生效（写 localStorage → 重注入背景让 background.js 重读）。 */
  function setFx(key, on) {
    try { localStorage.setItem(key, on ? 'on' : 'off'); } catch (_) {}
    if (key === LS_FX_DAYNIGHT) st.fxDaynight = !!on;
    else if (key === LS_FX_PARALLAX) st.fxParallax = !!on;
    st.fxBusy = true; paint();
    // 重注入当前主题背景（/api/inject 会重新 readCurrentThemeId + buildBackgroundExpr）
    return req('/api/inject', {}).then(function (d) {
      st.fxBusy = false;
      if (d && d.injection) st.inj = d.injection;
      if (!d || !d.ok) st.err = (d && d.error) || '动态效果应用失败（宿主未连接）';
      paint();
    }).catch(function () { st.fxBusy = false; st.err = '动态效果应用失败（服务未响应）'; paint(); });
  }
  function loadCustom() {
    return req('/api/custom-wallpapers').then(function (d) {
      if (d == null) { st.offline = true; return; }
      st.offline = false;
      if (!d.ok) return;
      st.custom = (d.wallpapers || []).map(function (w) {
        var isVid = w.type === 'video';
        return { name: w.name, key: w.name, kind: 'file', kindOf: isVid ? 'video' : 'image', title: w.title || w.name, thumb: w.thumb || (API + '/wallpapers/' + encodeURIComponent(w.name)), badge: isVid ? '视频' : '图片' };
      });
    });
  }
  function loadWe(force) {
    st.weBusy = true; paint();
    return req('/api/we-wallpapers' + (force ? '?refresh=1' : '')).then(function (d) {
      st.weBusy = false;
      if (d == null) st.offline = true;
      else { st.offline = false; if (d.ok) st.we = d; }
      paint();
    });
  }

  /** 注入状态：服务活着 ≠ 页面里有 UI，两者分开报（health.injection 由注入器上报） */
  function loadHealth() {
    return req('/api/wallpaper/health').then(function (d) {
      if (d == null) { st.offline = true; return; }
      st.offline = false;
      st.inj = (d && d.ok && d.injection) ? d.injection : (d && d.ok ? { ok: null } : null);
    }).catch(function () {});
  }
  function loadMask() {
    return req('/api/mask').then(function (d) {
      if (d == null) { st.offline = true; return; }
      if (d.ok) st.mask = Number(d.opacity) || 0;
    }).catch(function () {});
  }
  function setMask(v) {
    var n = Math.min(1, Math.max(0, Number(v) || 0));
    st.maskBusy = true; st.mask = n; paint();
    return req('/api/mask', { opacity: n }).then(function (d) {
      st.maskBusy = false;
      if (d && d.ok) { st.mask = Number(d.opacity) || 0; st.err = ''; }
      else st.err = (d && d.error) || '蒙版设置失败';
      paint();
    }).catch(function () { st.maskBusy = false; st.err = '蒙版设置失败（服务未响应）'; paint(); });
  }
  /** 面板玻璃浓度（0~100，纯前端 localStorage + CSS 变量，写 --wdw-glass-amount）。 */
  function loadGlass() {
    try {
      var v = parseInt(localStorage.getItem(LS_GLASS), 10);
      st.glass = Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 62;
    } catch (_) { st.glass = 62; }
    applyGlassVar(st.glass);
  }
  function applyGlassVar(n) {
    var el = document.getElementById(ID.root);
    if (el) el.style.setProperty('--wdw-glass-amount', n + '%');
  }
  function setGlass(v) {
    var n = Math.min(100, Math.max(0, Math.round(Number(v))));
    if (!Number.isFinite(n)) n = 62;
    st.glass = n;
    try { localStorage.setItem(LS_GLASS, String(n)); } catch (_) {}
    applyGlassVar(n);
    paint();
  }
  /** 手动强调色（写 --wdw-accent-bg；空串 = 清除覆盖，跟随壁纸主色）。 */
  function loadAccent() {
    try { st.accent = localStorage.getItem(LS_ACCENT) || ''; } catch (_) { st.accent = ''; }
    applyAccentVar(st.accent);
  }
  function applyAccentVar(hex) {
    var el = document.getElementById(ID.root);
    if (!el) return;
    if (hex) el.style.setProperty('--wdw-accent-bg', hex);
    else el.style.removeProperty('--wdw-accent-bg');
  }
  function setAccent(hex) {
    st.accent = hex || '';
    try { localStorage.setItem(LS_ACCENT, st.accent); } catch (_) {}
    applyAccentVar(st.accent);
    paint();
  }
  /** 应用外观预设：accent + 玻璃浓度 + 蒙版 整套一次性生效。 */
  function applyLookPreset(id) {
    var p = null;
    for (var i = 0; i < LOOK_PRESETS.length; i++) if (LOOK_PRESETS[i].id === id) { p = LOOK_PRESETS[i]; break; }
    if (!p) return;
    setAccent(p.accent);
    setGlass(p.glass);
    if (p.mask > 0) setMask(p.mask / 100);
    else setMask(0);
    toast('已应用外观：' + p.name, 2000);
  }
  /** 最近使用：读 localStorage（最多 8 条，去重，新在前）。 */
  function loadRecent() {
    try { st.recent = JSON.parse(localStorage.getItem(LS_RECENT) || '[]'); } catch (_) { st.recent = []; }
    if (!Array.isArray(st.recent)) st.recent = [];
  }
  /** 记录一次应用（去重 + 限长 8）。entry: { kind:'file'|'we', id, title, thumb } */
  function pushRecent(entry) {
    loadRecent();
    var out = [entry].concat(st.recent.filter(function (r) { return !(r && r.kind === entry.kind && r.id === entry.id); }));
    st.recent = out.slice(0, 8);
    try { localStorage.setItem(LS_RECENT, JSON.stringify(st.recent)); } catch (_) {}
  }
  /** 自动轮播（E1）：读间隔（分钟，0=关闭）；当前源筛选后列表随机切一张。 */
  function loadRotate() {
    try { st.rotate = Math.max(0, parseInt(localStorage.getItem(LS_ROTATE), 10) || 0); } catch (_) { st.rotate = 0; }
    scheduleRotate();
  }
  function setRotate(min) {
    st.rotate = Math.max(0, Math.round(Number(min)) || 0);
    try { localStorage.setItem(LS_ROTATE, String(st.rotate)); } catch (_) {}
    scheduleRotate();
    paint();
  }
  function scheduleRotate() {
    if (st.rotateTimer) { clearInterval(st.rotateTimer); st.rotateTimer = null; }
    if (!st.rotate) return;
    st.rotateTimer = setInterval(function () { rotateOnce(); }, st.rotate * 60000);
  }
  function rotateOnce() {
    if (st.paused) return;   // 暂停壁纸时不轮播
    var pool = [];
    if (st.source === 'we') {
      pool = (st.we && st.we.items ? st.we.items : []).map(function (it) { return { kind: 'we', id: String(it.id), title: it.title }; });
    } else {
      pool = (st.custom || []).map(function (w) { return { kind: 'file', id: w.name, title: w.title }; });
    }
    if (pool.length < 2) return;
    // 排除当前壁纸，避免「切到自己」
    var curKey = st.source === 'we' ? String(st.curWe) : (st.cur || '');
    var cands = pool.filter(function (p) { return p.id !== curKey; });
    if (!cands.length) cands = pool;
    var pick = cands[Math.floor(Math.random() * cands.length)];
    if (pick.kind === 'we') applyWe(pick.id, pick.title);
    else apply(pick.id, pick.title);
  }
  /** 视频倍速 + 静音（#1）：直接操作 wdw-bg-video 元素，写 localStorage 持久化。 */
  function loadVideoCtrl() {
    try { st.vrate = Math.min(2, Math.max(0.5, parseFloat(localStorage.getItem(LS_VRATE)) || 1)); } catch (_) { st.vrate = 1; }
    try { st.vmuted = localStorage.getItem(LS_VMUTED) !== 'off'; } catch (_) { st.vmuted = true; }
    applyVideoCtrl();
  }
  function applyVideoCtrl() {
    var v = document.getElementById('wdw-bg-video');
    if (!v) return;
    try { v.playbackRate = st.vrate; } catch (_) {}
    try { v.muted = !!st.vmuted; } catch (_) {}
  }
  function setVrate(r) {
    st.vrate = Math.min(2, Math.max(0.5, Number(r) || 1));
    try { localStorage.setItem(LS_VRATE, String(st.vrate)); } catch (_) {}
    applyVideoCtrl();
    paint();
  }
  function setVmuted(on) {
    st.vmuted = !!on;
    try { localStorage.setItem(LS_VMUTED, st.vmuted ? 'on' : 'off'); } catch (_) {}
    applyVideoCtrl();
    paint();
  }

  function doReinject() {
    st.reinjectBusy = true; st.err = ''; paint();
    return req('/api/inject', {}).then(function (d) {
      st.reinjectBusy = false;
      if (d && d.injection) st.inj = d.injection;
      if (!d || !d.ok) st.err = (d && d.error) || '重新注入失败（宿主可能未开启调试端口）';
      paint();
      return loadHealth().then(function () { paint(); });
    }).catch(function () { st.reinjectBusy = false; st.err = '重新注入失败（服务未响应）'; paint(); });
  }

  function apply(name, title) {
    st.applying = name; st.err = '';
    // 记录撤销目标（上一张）：当前是 WE 场景则回 WE，否则回文件壁纸
    st.undo = st.curWe ? { kind: 'we', id: String(st.curWe), title: st.curTitle || '' } : (st.cur ? { kind: 'file', id: st.cur, title: st.curTitle || '' } : null);
    toast('正在应用' + (title ? '：' + title : '…'), 8000);
    return req('/api/theme-bg', { id: 'standalone', wallpaper: name }).then(function (d) {
      st.applying = '';
      if (d == null) { st.err = '应用失败：服务未响应'; paint(); return; }
      if (!d.ok) { st.err = '应用失败：' + (d.error || '未知原因'); paint(); return; }
      pushRecent({ kind: 'file', id: name, title: title || name, thumb: API + '/wallpapers/' + encodeURIComponent(name) });
      return loadWallpapers().then(function () {
        paint();
        toast('已应用' + (title ? '：' + title : ''), 2600, 'undo');
      });
    }).catch(function () { st.applying = ''; st.err = '应用失败：请求异常'; paint(); });
  }
  /**
   * 暂停/恢复壁纸（可逆）。
   * 与服务端 `.paused` 标志对齐：暂停只拆背景层，服务、看门狗、面板、吉祥物全都不受影响。
   * 页面侧重绘由 paint() 负责 —— 按钮文案要跟着 st.paused 变，不能让用户点一个"已经生效"的按钮。
   */
  function setPaused(on) {
    if (st.pauseBusy) return;
    var want = !!on;
    st.pauseBusy = true; st.err = '';
    toast(want ? '正在隐藏壁纸…' : '正在恢复壁纸…', 4000);
    return req('/api/pause', { paused: want }).then(function (d) {
      st.pauseBusy = false;
      // 注意：失败提示走 toast，不走 st.err —— st.err 只在「壁纸库」页渲染，
      // 而这个按钮在「关于」页，用 st.err 的结果是"报错了但用户看不见"。
      if (d == null) { toast('操作失败：服务未响应', 4000); paint(); return; }
      if (d.ok === false) { toast('操作失败：' + (d.error || '未知原因'), 5000); paint(); return; }
      st.paused = !!d.paused;
      // 服务端没有注入通道时 applied=false：如实说明"状态记下了但页面不会变"，
      // 不要假装成功（旧版最容易让人困惑的就是这个）。
      if (d.applied === false) {
        toast(d.warn || '暂停状态已保存，但当前没有注入通道，页面背景不会立即变化', 6000);
        paint();
        return;
      }
      paint();
      toast(st.paused ? '壁纸已隐藏（可在「关于」页恢复）' : '壁纸已恢复');
      return loadWallpapers().then(function () { paint(); });
    }).catch(function () { st.pauseBusy = false; toast('操作失败：请求异常', 4000); paint(); });
  }
  /** 场景帧率档位（P0-2.3/3.1）：改 st.sceneFps；当前是场景壁纸时重应用以即时生效。 */
  function setSceneFps(v) {
    st.sceneFps = Math.max(1, Math.min(120, Math.round(v) || 30));
    paint();
    // 当前是 WE 场景（有 weId）才重应用；否则只记档位，下次应用场景时生效
    if (st.curWe) {
      applyWe(String(st.curWe), st.curTitle || '');
    }
  }
  function applyWe(id, title) {
    st.applying = String(id); st.err = '';
    // 记录撤销目标（上一张）：当前是 WE 场景则回 WE，否则回文件壁纸
    st.undo = st.curWe ? { kind: 'we', id: String(st.curWe), title: st.curTitle || '' } : (st.cur ? { kind: 'file', id: st.cur, title: st.curTitle || '' } : null);
    toast('正在应用' + (title ? '：' + title : '…'), 15000);
    return req('/api/we-apply', { id: 'standalone', weId: String(id), sceneFps: st.sceneFps, muted: true }).then(function (d) {
      st.applying = '';
      if (d == null) { st.err = '应用失败：服务未响应'; paint(); return; }
      if (!d.ok) { st.err = '应用失败：' + (d.error || '未知原因'); paint(); return; }
      pushRecent({ kind: 'we', id: String(id), title: d.title || title || id, thumb: API + '/wallpaper-engine/scene-files/' + encodeURIComponent(String(id)) + '/preview.jpg' });
      return loadWallpapers().then(function () {
        paint();
        toast('已应用' + (d.title ? '：' + d.title : ''), 2600, 'undo');
      });
    }).catch(function () { st.applying = ''; st.err = '应用失败：请求异常'; paint(); });
  }
  /** 撤销（#2）：回到上一张壁纸。 */
  function doUndo() {
    var u = st.undo;
    st.undo = null;
    st.toast = ''; st.toastAct = '';
    if (!u) { paint(); return; }
    if (u.kind === 'we') applyWe(u.id, u.title);
    else apply(u.id, u.title);
  }

  // ── 事件 ────────────────────────────────────────────────────────────────
  /** 委托制关键路径 try/catch：任何单个 handler 抛错不得影响其它交互
   *  （服务未连接时 DOM/接口状态多变，单点故障必须被就地吞掉并记录）。 */
  function guard(fn) {
    return function (e) {
      try { fn(e); } catch (err) { try { console.error('[wdw-panel] handler 错误（不影响其它交互）:', err); } catch (_) {} }
    };
  }

  function wire(el) {
    if (el.__wdwWired) return;
    el.__wdwWired = true;

    el.addEventListener('click', guard(function (e) {
      try {
        var t = e.target;
        // ── 抖动兜底 ──
        // 人手点击必有 1~2px 抖动：mousedown 落在按钮内、mouseup 移出按钮边界时，
        // click 的 target 会被浏览器 retarget 到共同祖先（.p-tabs/面板根），
        // 下面的 closest 全部落空 → 用户体感「点了没反应」（实测复现：target=ASIDE）。
        // 兜底：所有已知交互选择器都未命中时，用事件坐标 elementFromPoint 找回
        // 视觉目标（= 用户意图目标）。注意必须在主匹配之后判断，不干扰正常路径。
        var KNOWN = '.p-tab,[data-src],[data-rf],[data-fav],[data-del],.p-card,[data-act],[data-fontcolor],[data-font],[data-scprop],.p-seg button,.p-chips button,.p-btn';
        if (typeof e.clientX === 'number' && !(t.closest && t.closest(KNOWN))) {
          var visual = document.elementFromPoint(e.clientX, e.clientY);
          if (visual && visual.closest && visual.closest(KNOWN)) t = visual;
        }
        // 页签
        var tabBtn = t.closest ? t.closest('.p-tab') : null;
        if (tabBtn) { setTab(tabBtn.getAttribute('data-tab')); return; }
        // 字体页：文字颜色（调色盘快捷预设；空串 = 恢复默认）
        var fcBtn = t.closest ? t.closest('[data-fontcolor]') : null;
        if (fcBtn) { setFont({ color: fcBtn.getAttribute('data-fontcolor') || '' }); paint(); return; }
        // 字体页：选中某个字体（列表项）
        var fontBtn = t.closest ? t.closest('[data-font]') : null;
        if (fontBtn) {
          var fname = fontBtn.getAttribute('data-font');
          setFont({ family: fontStack(fname), familyName: fname });
          paint(); return;
        }
        // 最近使用（E2）：点击小缩略图重新应用
        var rcBtn = t.closest ? t.closest('[data-recent]') : null;
        if (rcBtn) {
          var rv = String(rcBtn.getAttribute('data-recent') || '');
          var ci = rv.indexOf(':');
          var rk = rv.slice(0, ci), rid = rv.slice(ci + 1);
          if (rk === 'we') applyWe(rid, rcBtn.getAttribute('title') || '');
          else apply(rid, rcBtn.getAttribute('title') || '');
          return;
        }
        // 来源分段
        var srcBtn = t.closest ? t.closest('[data-src]') : null;
        if (srcBtn) {
          st.source = srcBtn.getAttribute('data-src');
          if (st.source === 'we' && !st.we) { loadWe(false); } else { paint(); }
          return;
        }
        // 仓库标签 chips（全部/收藏/场景/视频/图片）
        var rf = t.closest ? t.closest('[data-rf]') : null;
        if (rf) { st.rfilter = rf.getAttribute('data-rf'); refreshRepoGrid(); return; }
        // 收藏星标（必须在 .p-card 判定之前，否则会被当成「应用壁纸」）
        var favBtn = t.closest ? t.closest('[data-fav]') : null;
        if (favBtn) {
          var parts = String(favBtn.getAttribute('data-fav') || '').split(':');
          var on = toggleFav(parts[0], parts.slice(1).join(':'));
          favBtn.classList.toggle('wdw-on', on);
          favBtn.textContent = on ? '★' : '☆';
          favBtn.title = on ? '取消收藏' : '收藏';
          favBtn.setAttribute('aria-pressed', String(!!on));
          if (st.rfilter === 'fav') refreshRepoGrid();
          e.stopPropagation(); return;
        }
        // 卡片应用 / 删除 / WE 应用
        var del = t.closest ? t.closest('[data-del]') : null;
        if (del) {
          var dn = del.getAttribute('data-del');
          req('/api/custom-wallpapers?name=' + encodeURIComponent(dn), null, 'DELETE').then(function () { return loadCustom(); }).then(function () { paint(); }).catch(function () {});
          e.stopPropagation(); return;
        }
        var card = t.closest ? t.closest('.p-card') : null;
        if (card) {
          if (card.getAttribute('data-we')) applyWe(card.getAttribute('data-we'), card.getAttribute('title') || '');
          else if (card.getAttribute('data-name')) apply(card.getAttribute('data-name'), card.getAttribute('title') || '');
          return;
        }
        // 场景属性：bool 开关（P0-2.3）—— 点击切换并提交
        var scSw = t.closest ? t.closest('[data-scprop][data-type="bool"]') : null;
        if (scSw) {
          var sck = scSw.getAttribute('data-scprop');
          var scon = !scSw.classList.contains('wdw-on');
          setSceneProp(sck, scon);
          commitSceneProps();
          return;
        }
        // 动态效果开关（P0-2.3）：data-fx 直接切换，不等 data-act 分支
        var fxSw = t.closest ? t.closest('[data-fx]') : null;
        if (fxSw && !fxSw.disabled) {
          var fk = fxSw.getAttribute('data-fx');
          var fOn = !fxSw.classList.contains('wdw-on');
          setFx(fk, fOn);
          return;
        }
        // 动作按钮
        var act = t.closest ? t.closest('[data-act]') : null;
        if (act) {
          var a = act.getAttribute('data-act');
          if (a === 'retry') {
            // 服务未连接提示条上的重试：重新拉取全部数据
            Promise.all([loadWallpapers(), loadCustom(), loadHealth(), loadMask()]).then(function () { paint(); }).catch(function () {});
          } else if (a === 'close') { api_close(); }
          else if (a === 'reinject') { doReinject(); }
          else if (a === 'mask-preset') { setMask(Number(act.getAttribute('data-v')) || 0); }
          else if (a === 'look-preset') { applyLookPreset(act.getAttribute('data-v')); }
          else if (a === 'rotate') { setRotate(Number(act.getAttribute('data-v')) || 0); }
          else if (a === 'vrate') { setVrate(Number(act.getAttribute('data-v')) || 1); }
          else if (a === 'vmuted') { setVmuted(!st.vmuted); }
          else if (a === 'undo') { doUndo(); }
          else if (a === 'scene-fps') { setSceneFps(Number(act.getAttribute('data-v')) || 30); }
          else if (a === 'upload') {
            var f = el.querySelector('#wdw-up-file');
            if (f) f.click();
          } else if (a === 'scan-we') { loadWe(true); }
          else if (a === 'font-reset') { setFont({ family: '', familyName: '' }); paint(); }
          else if (a === 'check-update') { doCheck(true); }
          else if (a === 'apply-update') { doApply(); }
          else if (a === 'rollback') { doRollback(act.getAttribute('data-ver')); }
          else if (a === 'open-home') {
            var hp = (st.upd && st.upd.homepage) || 'https://github.com/Maverick353/workbuddy-wallpaper';
            try { window.open(hp, '_blank'); } catch (_) {}
          }
          else if (a === 'pause-toggle') { setPaused(!st.paused); }
          else if (a === 'shutdown') {
            // 退出插件（原有 .stopped 语义，未改）：服务退出 + companion 不再拉起。
            // 确认框里必须写清「怎么回来」，并且在最后一句明确指向「暂停」这个可逆选项 ——
            // 旧版只说"再运行启动脚本"，用户点完才发现面板也没了、找不到脚本。
            var msg = '退出插件？\n\n'
              + '· 壁纸服务会停止，页面上的壁纸与面板都会被移除\n'
              + '· 不会自动恢复（注销重登也不会）\n\n'
              + '恢复方法：打开插件安装目录，双击「启动.cmd」（或运行 node scripts/start-ui.js）。\n\n'
              + '只想暂时隐藏壁纸？点「取消」，改用上一行的「暂停壁纸」，随时可恢复。';
            if (window.confirm && !window.confirm(msg)) return;
            try { fetch(API + '/api/shutdown', { method: 'POST', headers: authHeaders() }).catch(function () {}); } catch (_) {}
            setTimeout(function () { try { teardownAll(); } catch (_) {} }, 200);
          }
          return;
        }
      } catch (err) {
        // 单点交互抛错不得影响其它委托处理（关键路径防护）
        try { console.error('[wdw-panel] click 处理异常（不影响其它交互）:', err); } catch (_) {}
      }
    }));

    // 搜索框：input 事件只重绘网格（不整页重绘 ⇒ 输入焦点与光标不丢）
    el.addEventListener('input', guard(function (e) {
      var t = e.target;
      if (!t) return;
      if (t.id === 'wdw-repo-q') { st.rquery = t.value || ''; refreshRepoGrid(); }
      else if (t.id === 'wdw-fontsearch') { st.fontQuery = t.value || ''; refreshFontList(); }
      else if (t.id === 'wdw-glass') {
        // 玻璃浓度拖动中：即时应用 CSS 变量（不整页重绘，避免拖动卡顿）
        var gv = Number(t.value);
        if (Number.isFinite(gv)) { st.glass = Math.round(gv); applyGlassVar(st.glass); }
        var tag = document.querySelector('#' + ID.root + ' [data-glass-pct]');
        if (tag) tag.textContent = st.glass + '%';
      }
      else if (t.id === 'wdw-fontcolor') {
        // 调色盘拖动中：即时预览（不整页重绘，避免打断取色器）
        setFont({ color: t.value });
        var v = document.getElementById('wdw-fontcolor-v');
        if (v) v.textContent = String(t.value).toUpperCase();
      }
    }));

    el.addEventListener('change', guard(function (e) {
      var t = e.target;
      if (t.id === 'wdw-fontcolor') { setFont({ color: t.value }); paint(); return; }
      if (t.id === 'wdw-mask') { setMask(Number(t.value) / 100); return; }
      if (t.id === 'wdw-glass') { setGlass(Number(t.value)); return; }
      if (t.id === 'wdw-accent-color') { setAccent(t.value); return; }
      // 场景属性：slider / color / combo（P0-2.3）—— change 时提交
      var sc = t && t.getAttribute && t.getAttribute('data-scprop') ? t : (t && t.closest ? t.closest('[data-scprop]') : null);
      if (sc && sc.getAttribute('data-type') !== 'bool') {
        var k = sc.getAttribute('data-scprop');
        var ty = sc.getAttribute('data-type');
        if (ty === 'slider') { setSceneProp(k, Number(sc.value)); commitSceneProps(); return; }
        if (ty === 'color') {
          // #rrggbb → "r g b"（0-1 浮点，WE 官方格式）
          var c = String(sc.value || '#808080').replace('#', '');
          if (/^[0-9a-fA-F]{6}$/.test(c)) {
            var rr = parseInt(c.slice(0, 2), 16) / 255, gg = parseInt(c.slice(2, 4), 16) / 255, bb = parseInt(c.slice(4, 6), 16) / 255;
            setSceneProp(k, rr.toFixed(4) + ' ' + gg.toFixed(4) + ' ' + bb.toFixed(4));
            commitSceneProps();
          }
          return;
        }
        if (ty === 'combo') { setSceneProp(k, Number(sc.value)); commitSceneProps(); return; }
        return;
      }
      if (t.id === 'wdw-up-file' && t.files && t.files[0]) {
        var file = t.files[0];
        // 发送前先卡大小：服务端虽有 10MB/80MB 上限，但那是**传完之后**才拒
        // （body 先把整个 base64 串读进内存），大文件白等一场还可能把服务拖垮。
        var isVid = /^video\//.test(file.type || '') || /\.(mp4|webm|ogg|mov)$/i.test(file.name || '');
        var lim = isVid ? 80 * 1024 * 1024 : 10 * 1024 * 1024;
        if (file.size > lim) {
          st.err = '「' + file.name + '」' + (file.size / 1048576).toFixed(1) + 'MB，超过' +
            (isVid ? '视频 80MB' : '图片 10MB') + '上限，未上传';
          t.value = '';
          paint();
          return;
        }
        var rd = new FileReader();
        st.uploadBusy = true; st.err = ''; paint();
        rd.onload = function () {
          req('/api/custom-wallpapers', { dataUrl: rd.result }).then(function (d) {
            st.uploadBusy = false;
            // ⚠️ req 在 400 时也会正常 resolve（只是 ok:false）—— 以前不看 d.ok，
            //    上传被拒（超限/格式不支持）时界面一片安静，用户以为"点了没反应"。
            if (d == null) { st.err = '上传失败：服务未响应'; paint(); return; }
            if (!d.ok) { st.err = '上传失败：' + (d.error || '未知原因'); paint(); return; }
            return loadCustom().then(function () {
              paint();
              if (d.name) apply(d.name);   // 上传完直接应用，少一步点击
            });
          }).catch(function () { st.uploadBusy = false; st.err = '上传失败：请求异常'; paint(); });
        };
        rd.onerror = function () { st.uploadBusy = false; st.err = '读不到这个文件（可能已被移动或权限不足）'; paint(); };
        rd.readAsDataURL(file);
        t.value = '';
        return;
      }
    }));

    document.addEventListener('keydown', guard(function (e) { if (e.key === 'Escape' && st.open) api_close(); }));
    window.addEventListener('resize', guard(function () { if (st.open) movePill(el); }));
  }

  function setTab(id) {
    if (!TABS.some(function (t) { return t.id === id; })) return;
    st.tab = id;
    try { localStorage.setItem(LS_TAB, id); } catch (_) {}
    paint();
    // 字体页首次进入时才去拉本机字体列表（不在启动时拖慢注入）
    if (id === 'font' && !(st.fonts && st.fonts.length)) {
      loadFonts().then(function () { if (st.tab === 'font') paint(); }).catch(function () {});
    }
    // 系统页：注入状态会变（自愈成功/失败），每次进入都重读一次
    if (id === 'system') {
      loadHealth().then(function () { if (st.tab === 'system') paint(); }).catch(function () {});
      loadMask().then(function () { if (st.tab === 'system') paint(); }).catch(function () {});
      // 动态效果能力（st.fx）也会随当前壁纸变化，进系统页重读一次
      loadWallpapers().then(function () { if (st.tab === 'system') paint(); }).catch(function () {});
    }
    // 关于页：每次进入都刷新一次更新状态（仍是先读缓存，只有过期才联网）
    if (id === 'about') {
      loadUpdate(true).then(function () { if (st.tab === 'about') paint(); }).catch(function () {});
    }
  }
  // 关闭壁纸：本地拆除注入的一切（UI 三件套 + 背景层 + 岛观察器 + 全局 API）。
  // 与服务端 /api/shutdown 配合：服务退出 + 页面清净，用户视角「壁纸关掉了」。
  function teardownAll() {
    var ids = ['wdw-rope-buddy', 'wdw-wallpaper-panel', 'wdw-dsh-ui-style',
      'wdw-rope-buddy-style', 'wdw-panel-style', 'wdw-font-style',
      'wdw-theme-style', 'wdw-bg-video', 'wdw-bg-scene', 'wdw-bg-fx'];
    for (var i = 0; i < ids.length; i++) {
      var e = document.getElementById(ids[i]);
      if (e) { try { e.remove(); } catch (_) {} }
    }
    try { document.body.classList.remove('wdw-dsh-ui'); } catch (_) {}
    try { if (window.__wdwIslandWatch && window.__wdwIslandWatch.disconnect) window.__wdwIslandWatch.disconnect(); } catch (_) {}
    try { delete window.__wdwPanel; } catch (_) {}
    try { delete window.__wdwRopeBuddy; } catch (_) {}
    try { delete window.__wdwIslandWatch; } catch (_) {}
  }

  function api_open() {
    var el = build();
    st.open = true;
    el.classList.add('wdw-open');
    loadGlass();   // 玻璃浓度是纯前端（localStorage + CSS 变量），同步应用
    loadAccent();  // 手动强调色，同步应用（覆盖壁纸主色采样）
    loadRecent();  // 最近使用列表（库页快捷段）
    loadRotate();  // 自动轮播（读间隔并调度定时器）
    loadVideoCtrl();  // 视频倍速+静音（直接操作视频元素）
    // 服务不可达时 loadXxx 置 offline → paint 出错误态提示条（而非空白/无反应）
    Promise.all([loadWallpapers(), loadCustom(), loadHealth(), loadMask()]).then(function () { paint(); }).catch(function () {});
    // 更新状态：读缓存立刻渲染；缓存过期才后台补检查（不阻塞打开）
    loadUpdate().then(function () { if (st.open) paint(); }).catch(function () {});
    paint();
  }
  function api_close() {
    st.open = false;
    var el = document.getElementById(ID.root);
    if (el) el.classList.remove('wdw-open');
  }

  style();
  // 重注入语义（服务重启 / CDP 重连补注入，页面未刷新）：先移除旧元素再重建。
  // 否则旧闭包的事件监听与新闭包的 __wdwPanel 会各持一份 st 状态而互相串味
  // （实测：重连后面板重载后重试按钮消失、页签数据空白）。api_open 内的 build()
  // 仍走复用路径（元素存在即不重建），不影响正常开合。
  var stale = document.getElementById(ID.root);
  if (stale) { try { stale.remove(); } catch (_) {} }
  var el = build();
  paint();
  window.__wdwPanel = {
    get open() { return st.open; },
    el: el,
    // ⚠️ 不能叫 open()：会与上面的布尔 getter 同名，对象字面量里后者覆盖前者
    //    ⇒ __wdwPanel.open 变成函数、状态读取失效（实测踩过）。打开统一走 show()。
    show: api_open,
    close: api_close,
    toggle: function (v) { if (v === undefined) { st.open ? api_close() : api_open(); } else { v ? api_open() : api_close(); } },
    setTab: setTab,
    refresh: function () { return Promise.all([loadWallpapers(), loadCustom(), loadHealth(), loadMask()]).then(function () { paint(); }).catch(function () {}); },
  };
  return { ok: true, id: ID.root };
}

function panelExpression(payload) {
  var p = Object.assign({ ids: IDS, tabs: TABS, lsTab: LS_TAB, lsPrefs: LS_PREFS, lsRepo: LS_REPO, filters: REPO_FILTERS, lsFont: LS_FONT, fontColors: FONT_COLORS, fontSwatches: FONT_SWATCHES, lsFxDaynight: LS_FX_DAYNIGHT, lsFxParallax: LS_FX_PARALLAX }, payload || {});
  return '(' + wallpaperPanel.toString() + ')(' + JSON.stringify(p) + ')';
}

module.exports = { IDS, TABS, REPO_FILTERS, panelExpression, wallpaperPanel };
