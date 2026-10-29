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

// ── 界面风格（五套独立皮肤，只换视觉层：DOM 结构/交互/尺寸一律不动）──────────
// 选择逻辑：面板根挂 data-wdw-skin，CSS 用 `#id[data-wdw-skin="x"]` 覆盖；
// 该选择器特异性 (1,1,0) 高于基线 `#id .p-xxx` 的同名规则里需要覆盖的部分。
// 落地约束（改这里前必读）：
//   · 每套必须自带 --wdw-* 变量覆盖，不能依赖宿主亮/暗主题；
//   · 浅色两套要显式改 .p-card .cap / .badge / .p-tag 的文字色，否则白底白字；
//   · 一律不加 backdrop-filter 到 .p-card 之类大面积元素（实测 GPU 425%→629%）。
const LS_SKIN = 'wdw.skin';
const SKINS = [
  {
    id: 'dark-tech', name: '暗色科技',
    vars: '--wdw-ink:#EDF2F7;--wdw-ink-2:rgba(214,225,235,.72);--wdw-ink-3:rgba(168,182,196,.52);'
      + '--wdw-accent:#39D7FF;--wdw-glass-line:rgba(255,255,255,.10);--wdw-glass-fill:rgba(255,255,255,.06);'
      + '--wdw-glass-fill-hi:rgba(255,255,255,.12);--wdw-ui-h:32px;--wdw-ui-radius:10px;',
    css: '@S@{background:linear-gradient(180deg,rgba(30,36,42,.92),rgba(20,25,30,.94)) !important;'
      + 'border-color:rgba(255,255,255,.09) !important;border-radius:20px !important;'
      + 'box-shadow:0 18px 46px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.04) !important}'
      + '@S@ .p-tabs{background:rgba(255,255,255,.04) !important;border-color:rgba(255,255,255,.07) !important}'
      + '@S@ .p-tabs__pill{background:linear-gradient(180deg,#3FE0FF,#1FA8D0) !important;box-shadow:0 0 16px rgba(57,215,255,.45) !important}'
      + '@S@ .p-tab.wdw-on{color:#04161D !important;font-weight:700 !important}'
      + '@S@ .p-card{background:#2A3036 !important;border-color:rgba(255,255,255,.08) !important}'
      + '@S@ .p-card.wdw-cur{box-shadow:inset 0 0 0 2px #39D7FF,0 0 16px rgba(57,215,255,.28) !important}'
      + '@S@ .p-btn.wdw-primary{background:linear-gradient(180deg,#3FE0FF,#1FA8D0) !important;border-color:transparent !important;color:#04161D !important;font-weight:700 !important}'
      + '@S@ .p-btn.wdw-danger{background:rgba(239,108,108,.12) !important;border-color:rgba(239,108,108,.45) !important;color:#FFA9A9 !important}'
      + '@S@ .p-chips button.wdw-on{background:rgba(57,215,255,.16) !important;border-color:rgba(57,215,255,.45) !important;color:#EDF2F7 !important}'
      + '@S@ .p-font--cur{box-shadow:inset 0 0 0 1px #39D7FF !important}'
      + '@S@ .p-foot{background:rgba(255,255,255,.03) !important}',
  },
  {
    id: 'shadow-glass', name: '暗色玻璃',
    vars: '--wdw-ink:#E8ECF4;--wdw-ink-2:rgba(232,236,244,.72);--wdw-ink-3:rgba(232,236,244,.50);'
      + '--wdw-accent:#4F8CFF;--wdw-glass-line:rgba(255,255,255,.12);--wdw-glass-fill:rgba(255,255,255,.07);'
      + '--wdw-glass-fill-hi:rgba(255,255,255,.13);--wdw-ui-h:30px;--wdw-ui-radius:10px;',
    css: '@S@{background:color-mix(in srgb,var(--wb-bg-popover,#151a22) 62%,transparent) !important;'
      + 'border-color:rgba(255,255,255,.12) !important;border-radius:22px !important}'
      + '@S@ .p-tabs__pill{background:color-mix(in srgb,var(--wb-bg-popover,#2a3040) 65%,transparent) !important}'
      + '@S@ .p-btn.wdw-primary{background:color-mix(in srgb,#4F8CFF 34%,transparent) !important;border-color:color-mix(in srgb,#4F8CFF 60%,transparent) !important}',
  },
  {
    id: 'holo', name: '全息未来',
    vars: '--wdw-ink:#E8F7FF;--wdw-ink-2:rgba(196,229,255,.74);--wdw-ink-3:rgba(150,196,228,.52);'
      + '--wdw-accent:#37C6FF;--wdw-glass-line:rgba(96,206,255,.22);--wdw-glass-fill:rgba(88,180,255,.10);'
      + '--wdw-glass-fill-hi:rgba(120,214,255,.20);--wdw-ui-h:32px;--wdw-ui-radius:10px;',
    css: '@S@{background:linear-gradient(180deg,rgba(12,32,64,.88),rgba(6,18,40,.90)) !important;'
      + 'border-color:rgba(96,206,255,.34) !important;border-radius:18px !important;'
      + 'box-shadow:0 0 0 1px rgba(96,206,255,.10),0 18px 48px rgba(0,10,30,.62),0 0 42px rgba(59,168,255,.22) !important}'
      + '@S@ .p-tabs{background:rgba(88,180,255,.10) !important;border-color:rgba(96,206,255,.22) !important}'
      + '@S@ .p-tabs__pill{background:linear-gradient(135deg,#37C6FF,#7A5CFF) !important;box-shadow:0 0 18px rgba(80,170,255,.55) !important}'
      + '@S@ .p-tab.wdw-on{color:#04121F !important;font-weight:700 !important}'
      + '@S@ .p-card{border-color:rgba(96,206,255,.28) !important;box-shadow:inset 0 0 0 1px rgba(96,206,255,.06) !important}'
      + '@S@ .p-card.wdw-cur{box-shadow:inset 0 0 0 2px #37C6FF,0 0 22px rgba(55,198,255,.35) !important}'
      + '@S@ .p-btn{border-color:rgba(96,206,255,.22) !important}'
      + '@S@ .p-btn.wdw-primary{background:linear-gradient(135deg,rgba(55,198,255,.92),rgba(122,92,255,.92)) !important;border-color:transparent !important;color:#04121F !important;font-weight:700 !important;box-shadow:0 0 14px rgba(55,198,255,.28) !important}'
      + '@S@ .p-btn.wdw-danger{background:rgba(255,107,138,.14) !important;border-color:rgba(255,107,138,.55) !important;color:#FFC2CE !important}'
      + '@S@ .p-chips button.wdw-on{background:linear-gradient(135deg,rgba(55,198,255,.32),rgba(122,92,255,.32)) !important;border-color:rgba(96,206,255,.55) !important;color:#E8F7FF !important}'
      + '@S@ .p-title{letter-spacing:.6px}'
      + '@S@ .p-foot{background:rgba(88,180,255,.06) !important}',
  },
  {
    id: 'neon', name: '赛博霓虹',
    vars: '--wdw-ink:#F6EBFF;--wdw-ink-2:rgba(220,190,255,.76);--wdw-ink-3:rgba(170,140,210,.55);'
      + '--wdw-accent:#00E5FF;--wdw-glass-line:rgba(180,110,255,.28);--wdw-glass-fill:rgba(150,80,255,.12);'
      + '--wdw-glass-fill-hi:rgba(190,110,255,.22);--wdw-ui-h:32px;--wdw-ui-radius:10px;',
    css: '@S@{background:linear-gradient(180deg,rgba(28,10,44,.86),rgba(14,6,26,.90)) !important;'
      + 'border-color:rgba(255,46,209,.45) !important;border-radius:20px !important;'
      + 'box-shadow:0 0 0 1px rgba(0,229,255,.20),0 0 36px rgba(255,46,209,.28),0 0 64px rgba(122,60,255,.22),0 20px 50px rgba(0,0,0,.6) !important}'
      + '@S@ .p-tabs{background:rgba(60,20,90,.45) !important;border-color:rgba(180,110,255,.35) !important}'
      + '@S@ .p-tabs__pill{background:linear-gradient(135deg,#00E5FF,#FF2ED1) !important;box-shadow:0 0 20px rgba(0,229,255,.55) !important}'
      + '@S@ .p-tab.wdw-on{color:#12031C !important;font-weight:800 !important}'
      + '@S@ .p-title{letter-spacing:1.4px;text-shadow:0 0 12px rgba(0,229,255,.55)}'
      + '@S@ .p-card{border-color:rgba(0,229,255,.45) !important;box-shadow:0 0 12px rgba(0,229,255,.22) !important}'
      + '@S@ .p-card.wdw-cur{box-shadow:0 0 0 1px #FF2ED1,0 0 20px rgba(255,46,209,.45) !important}'
      + '@S@ .p-card .badge{background:rgba(255,46,209,.28) !important;border-color:rgba(255,46,209,.6) !important}'
      + '@S@ .p-btn{border-color:rgba(180,110,255,.35) !important}'
      + '@S@ .p-btn.wdw-primary{background:linear-gradient(135deg,rgba(0,229,255,.9),rgba(255,46,209,.9)) !important;border-color:transparent !important;color:#12031C !important;font-weight:800 !important}'
      + '@S@ .p-btn.wdw-danger{background:rgba(255,46,209,.16) !important;border-color:rgba(255,46,209,.60) !important;color:#FFB3EC !important}'
      + '@S@ .p-chips button.wdw-on{background:rgba(0,229,255,.18) !important;border-color:rgba(0,229,255,.55) !important;color:#F6EBFF !important}'
      + '@S@ .p-foot{background:rgba(60,20,90,.35) !important}',
  },
  {
    id: 'minimal', name: '极简浅色',
    vars: '--wdw-ink:#1E1F22;--wdw-ink-2:#6B7280;--wdw-ink-3:#9AA1AC;'
      + '--wdw-accent:#2B6BFF;--wdw-glass-line:#E7E9EE;--wdw-glass-fill:#F5F6F8;'
      + '--wdw-glass-fill-hi:#EDEFF3;--wdw-ui-h:30px;--wdw-ui-radius:8px;',
    css: '@S@{background:#FFFFFF !important;border-color:#ECEDEF !important;border-radius:16px !important;'
      + 'box-shadow:0 10px 30px rgba(20,30,50,.08),0 2px 6px rgba(20,30,50,.05) !important}'
      + '@S@ .p-head{border-bottom-color:#ECEDEF !important}'
      + '@S@ .p-tabs{background:transparent !important;border-color:#ECEDEF !important;border-radius:0 !important}'
      + '@S@ .p-tabs__pill{display:none !important}'
      + '@S@ .p-tab.wdw-on{color:#1E1F22 !important;font-weight:600 !important;box-shadow:inset 0 -2px 0 0 #2B6BFF !important}'
      + '@S@ .p-card{background:#F2F3F5 !important;border-color:#E7E9EE !important;box-shadow:none !important}'
      + '@S@ .p-card.wdw-cur{box-shadow:inset 0 0 0 2px #2B6BFF !important}'
      + '@S@ .p-card .cap{background:rgba(255,255,255,.94) !important;color:#1E1F22 !important;font-weight:500 !important}'
      + '@S@ .p-card .badge{background:#FFFFFF !important;border-color:#E3E6EB !important;color:#374151 !important}'
      + '@S@ .p-card .del{background:#FFFFFF !important;color:#6B7280 !important;border:1px solid #E3E6EB !important}'
      + '@S@ .p-btn{background:#FFFFFF !important;border-color:#E3E6EB !important;color:#374151 !important}'
      + '@S@ .p-btn.wdw-primary{background:#2B6BFF !important;border-color:#2B6BFF !important;color:#FFFFFF !important;font-weight:600 !important}'
      + '@S@ .p-btn.wdw-danger{background:#FFF5F5 !important;border-color:#F3C9C9 !important;color:#D9534F !important}'
      + '@S@ .p-x{color:#9AA1AC !important}'
      + '@S@ .p-chips button.wdw-on{background:#2B6BFF !important;border-color:#2B6BFF !important;color:#FFFFFF !important}'
      + '@S@ .p-font--cur{box-shadow:inset 0 0 0 1px #2B6BFF !important;color:#1E1F22 !important}'
      + '@S@ .p-hint.p-tag{background:#F2F3F5 !important;border-color:#E7E9EE !important;color:#6B7280 !important}'
      + '@S@ .p-foot{background:#FCFCFD !important;border-top-color:#ECEDEF !important}',
  },
];
/** 皮肤 id 合法性（页面侧同名函数见 wallpaperPanel 内；这里供 Node 侧/测试用）。 */
function skinId(v) {
  for (var i = 0; i < SKINS.length; i++) if (SKINS[i].id === v) return v;
  return 'dark-tech';
}

// ── 整页皮肤（2026-10-29：「严格按参考图还原整页」）────────────────────────────
// 与面板皮肤同 id、同一次切换：面板换肤的同时把宿主页面（侧栏/主区/卡片壳/输入/弹层）也按该风格重绘。
// 设计取舍：
//   · 参考图本身就是"实底界面"，所以整页皮肤会让壁纸退化为边缘点缀（dark/glass 半透明可透出，
//     minimal 近实底）——这是"还原参考图"与"壁纸可见"的直接冲突，按用户选择以参考图为准。
//   · 规则用模板 + 变量（--wpg-*），5 套只换变量，避免 5×N 条硬编码互相打架。
//   · 选择器带两个 `:not(#…)` 把特异性抬到 (2,x,0)，稳压 theme-css 的 (1,x,0) 透明化规则。
const PAGE_SKINS = {
  'dark-tech': {
    font: '"SF Pro Text","Source Han Sans SC","Microsoft YaHei UI",sans-serif',
    ink: '#EDF2F7', ink2: 'rgba(214,225,235,.72)', accent: '#39D7FF', accent2: '#1FA8D0',
    sidebar: 'rgba(20,25,30,.80)', main: 'rgba(15,19,24,.62)', card: 'rgba(42,48,54,.90)',
    line: 'rgba(255,255,255,.09)', input: 'rgba(255,255,255,.06)', pop: 'rgba(24,28,34,.94)', r: '12px',
  },
  'shadow-glass': {
    font: '"PingFang SC","Microsoft YaHei UI",sans-serif',
    ink: '#E8ECF4', ink2: 'rgba(232,236,244,.72)', accent: '#4F8CFF', accent2: '#2E6FE0',
    sidebar: 'rgba(24,30,38,.62)', main: 'rgba(18,23,29,.42)', card: 'rgba(30,37,46,.66)',
    line: 'rgba(255,255,255,.12)', input: 'rgba(255,255,255,.07)', pop: 'rgba(28,34,42,.90)', r: '14px',
  },
  holo: {
    font: '"HarmonyOS Sans SC","Source Han Sans SC","Microsoft YaHei UI",sans-serif',
    ink: '#E8F7FF', ink2: 'rgba(196,229,255,.74)', accent: '#37C6FF', accent2: '#7A5CFF',
    sidebar: 'rgba(8,24,50,.82)', main: 'rgba(6,18,40,.60)', card: 'rgba(12,32,64,.72)',
    line: 'rgba(96,206,255,.28)', input: 'rgba(88,180,255,.10)', pop: 'rgba(10,28,58,.94)', r: '12px',
  },
  neon: {
    font: '"Rajdhani","Source Han Sans SC","Microsoft YaHei UI",sans-serif',
    ink: '#F6EBFF', ink2: 'rgba(220,190,255,.76)', accent: '#00E5FF', accent2: '#FF2ED1',
    sidebar: 'rgba(22,8,36,.84)', main: 'rgba(14,6,26,.62)', card: 'rgba(28,10,44,.76)',
    line: 'rgba(180,110,255,.30)', input: 'rgba(150,80,255,.12)', pop: 'rgba(24,10,40,.94)', r: '14px',
  },
  minimal: {
    font: '"Inter","Source Han Sans SC","Microsoft YaHei UI",sans-serif',
    ink: '#1E1F22', ink2: '#6B7280', accent: '#2B6BFF', accent2: '#1D4FD8',
    sidebar: '#F7F8FA', main: '#FFFFFF', card: '#F2F3F5',
    line: '#E7E9EE', input: '#F5F6F8', pop: '#FFFFFF', r: '12px',
  },
};

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
  // 皮肤表同理必须走 payload：2026-10-29 首版把 SKINS/skinCss 留在模块级，
  // 注入后 page 侧直接 ReferenceError: skinCss is not defined（注入 4 次全失败，health.injection 抓到）。
  var SKINS = payload.skins || [];
  var LS_SKIN = payload.lsSkin || 'wdw.skin';
  function skinId(v) {
    for (var i = 0; i < SKINS.length; i++) if (SKINS[i].id === v) return v;
    return (SKINS[0] && SKINS[0].id) || 'dark-tech';
  }
  function skinCss() {
    var out = [];
    for (var i = 0; i < SKINS.length; i++) {
      var s = SKINS[i];
      var sel = '#' + ID.root + '[data-wdw-skin="' + s.id + '"]';
      out.push(sel + '{' + s.vars + '}' + s.css.split('@S@').join(sel));
    }
    return out.join('\n');
  }
  // 整页皮肤：模板 + 每套变量。属性挂在 <html> 上，切肤即整页重绘（面板/宿主同步）。
  var PAGE = payload.pageSkins || {};
  function pageSkinCss() {
    var out = [];
    for (var i = 0; i < SKINS.length; i++) {
      var id = SKINS[i].id;
      var v = PAGE[id] || PAGE['dark-tech'] || {};
      var H = 'html[data-wdw-skin="' + id + '"]';
      // 两个 :not(#…) 把特异性抬到 (2,x,0)：theme-css 的透明化/可读面规则是 (1,x,0)，必须稳压
      var N = ':not(#wdw-noop):not(#wdw-noop2)';
      out.push(
        H + '{--wpg-ink:' + v.ink + ';--wpg-ink-2:' + v.ink2 + ';--wpg-accent:' + v.accent
        + ';--wpg-line:' + v.line + ';--wpg-card:' + v.card + ';--wpg-input:' + v.input
        + ';--wpg-pop:' + v.pop + ';--wpg-sidebar:' + v.sidebar + ';--wpg-main:' + v.main
        + ';--wpg-r:' + v.r + ';--wpg-font:' + v.font + ';--wb-accent:' + v.accent + '}',
        H + ' body' + N + '{font-family:var(--wpg-font) !important;color:var(--wpg-ink) !important}',
        H + ' .conversation-list' + N + ',' + H + ' [data-view-id=sidebar]' + N + ','
          + H + ' aside:not(#wdw-wallpaper-panel)' + N
          + '{background:var(--wpg-sidebar) !important;border-right:1px solid var(--wpg-line) !important}',
        H + ' .teams-container' + N + ',' + H + ' .main-content' + N + ',' + H + ' [data-view-id]' + N
          + ',' + H + ' .conversation-shell' + N + '{background:var(--wpg-main) !important}',
        H + ' [class*="wb-home-page-pc"]' + N + ',' + H + ' [class*="knowledge-sidebar-pc"]' + N + ','
          + H + ' [class*="wb-feed-content-shell"]' + N + ',' + H + ' .automation-run-group__item' + N + ','
          + H + ' [class*="atm-task-card"]' + N + ',' + H + ' [class*="my-files-panel"]' + N
          + '{background:var(--wpg-card) !important;border:1px solid var(--wpg-line) !important;border-radius:var(--wpg-r) !important}',
        H + ' .cr-input-container' + N + ',' + H + ' [class*="chat-input"]' + N
          + '{background:var(--wpg-input) !important;border-color:var(--wpg-line) !important}',
        H + ' .wb-popover' + N + ',' + H + ' [class*="wbs-modal"]' + N + ','
          + H + ' [class*="wbs-status-popover"]' + N + ',' + H + ' [class*="wbs-credit-summary-popover"]' + N + ','
          + H + ' [class*="workspace-tree-create-space-dialog-pc"]' + N
          + '{background:var(--wpg-pop) !important;border-color:var(--wpg-line) !important}',
        // 组件级：宿主按钮 / 开关 / 焦点环 / 滚动条 —— 只换皮，不改尺寸与行为
        H + ' .wb-button' + N + '{background:color-mix(in srgb,var(--wpg-accent) 16%,transparent) !important;'
          + 'border-color:color-mix(in srgb,var(--wpg-accent) 45%,transparent) !important;color:var(--wpg-ink) !important}',
        H + ' .wb-button--primary' + N + ',' + H + ' .wb-switch.wb-switch--checked' + N
          + '{background:var(--wpg-accent) !important;border-color:var(--wpg-accent) !important;color:#04121f !important}',
        H + ' :focus-visible{outline-color:var(--wpg-accent) !important}',
        H + ' ::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--wpg-accent) 34%,transparent) !important}',
        // 文本容器兜底：宿主若把字设成白色，在浅色皮肤下会看不见 → 用更高特异性压回皮肤文字色
        H + ' .cr-message-list' + N + ',' + H + ' [class*="wb-home-page-pc"]' + N + ','
          + H + ' .main-content' + N + ',' + H + ' .conversation-list' + N
          + '{color:var(--wpg-ink) !important;-webkit-text-fill-color:var(--wpg-ink) !important}',
        H + ' ::selection{background:var(--wpg-accent) !important;color:#04121f !important}'
      );
    }
    return out.join('\n');
  }
  /** 皮肤属性双写：<html> 管整页，面板根管面板自身（两份规则各自独立生效）。 */
  function applySkinAttr(id) {
    document.documentElement.setAttribute('data-wdw-skin', id);
    var el = document.getElementById(ID.root);
    if (el) el.setAttribute('data-wdw-skin', id);
  }
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
    // 皮肤：本机偏好（localStorage），非法值回落 dark-tech；切换只改属性，不重建 DOM
    skin: (function () { try { return skinId(localStorage.getItem(LS_SKIN) || ''); } catch (_) { return 'dark-tech'; } })(),
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
      '--wdw-ui-h:30px;--wdw-ui-radius:10px;--wdw-ease:cubic-bezier(0.16,1,0.3,1);--wdw-dur-fast:120ms;',
      '--wdw-ink:var(--wb-color-text-primary,#e8ecf4);--wdw-ink-2:var(--wb-color-text-secondary,rgba(232,236,244,.72));--wdw-ink-3:rgba(232,236,244,.5);',
      '--wdw-accent:var(--wb-accent,#4f8cff);',
      '--wdw-glass-line:rgba(255,255,255,.12);--wdw-glass-fill:rgba(255,255,255,.07);--wdw-glass-fill-hi:rgba(255,255,255,.13);',
      'background:color-mix(in srgb,var(--wb-bg-primary,#101418) 62%,transparent);',
      'background-image:linear-gradient(180deg,rgba(255,255,255,.07),rgba(255,255,255,.015));',
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
      '#' + ID.root + ' .p-tab{position:relative;z-index:1;flex:1 1 0;min-width:0;height:28px;padding:0 4px;border:0;background:transparent;border-radius:8px;cursor:pointer;white-space:nowrap;font-size:12px;line-height:1;color:var(--wdw-ink-2);transition:color var(--wdw-dur-fast) var(--wdw-ease)}',
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
      '#' + ID.root + ' .p-seg button{flex:1;height:28px;border-radius:10px;border:1px solid var(--wdw-glass-line);background:var(--wdw-glass-fill);color:var(--wdw-ink-2);cursor:pointer;font-size:12px;transition:background var(--wdw-dur-fast),border-color var(--wdw-dur-fast)}',
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
      '#' + ID.root + ' .p-card{position:relative;aspect-ratio:16/10;border-radius:12px;overflow:hidden;cursor:pointer;border:1px solid rgba(255,255,255,.14);background:#0b0d12 center/cover no-repeat;transition:border-color var(--wdw-dur-fast),transform var(--wdw-dur-fast),box-shadow var(--wdw-dur-fast)}',
      '#' + ID.root + ' .p-card:hover{border-color:rgba(255,255,255,.45);transform:translateY(-1px);box-shadow:0 6px 18px rgba(0,0,0,.35)}',
      '#' + ID.root + ' .p-card.wdw-cur{box-shadow:inset 0 0 0 2px var(--wdw-accent)}',
      '#' + ID.root + ' .p-card .cap{position:absolute;left:0;right:0;bottom:0;padding:3px 6px;font-size:10px;background:linear-gradient(transparent,rgba(0,0,0,.72));overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '#' + ID.root + ' .p-card .badge{position:absolute;top:4px;left:4px;padding:1px 5px;border-radius:999px;font-size:9px;background:rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.18)}',
      '#' + ID.root + ' .p-card .del{position:absolute;top:5px;right:31px;width:22px;height:22px;border-radius:50%;border:0;background:rgba(0,0,0,.55);color:#fff;cursor:pointer;font-size:12px;line-height:1;display:none}',
      '#' + ID.root + ' .p-card:hover .del{display:block}',
      // ── 壁纸仓库（标签 chips + 搜索 + 收藏星标）──
      '#' + ID.root + ' .p-repo{display:flex;gap:8px;align-items:center}',
      '#' + ID.root + ' .p-chips{display:flex;gap:4px;flex-wrap:wrap;flex:1 1 auto;min-width:0}',
      '#' + ID.root + ' .p-chips button{height:24px;padding:0 8px;border-radius:999px;border:1px solid var(--wdw-glass-line);background:var(--wdw-glass-fill);color:var(--wdw-ink-2);cursor:pointer;font-size:11px;line-height:1;transition:color var(--wdw-dur-fast),background var(--wdw-dur-fast)}',
      '#' + ID.root + ' .p-chips button:hover{color:var(--wdw-ink);background:var(--wdw-glass-fill-hi)}',
      '#' + ID.root + ' .p-chips button.wdw-on{background:color-mix(in srgb,var(--wdw-accent) 30%,transparent);border-color:color-mix(in srgb,var(--wdw-accent) 55%,transparent);color:var(--wdw-ink);font-weight:600}',
      '#' + ID.root + ' .p-search{flex:0 0 104px;height:24px;border-radius:999px;border:1px solid var(--wdw-glass-line);background:var(--wdw-glass-fill);color:inherit;font-size:11px;padding:0 9px;outline:none}',
      '#' + ID.root + ' .p-search:focus{border-color:color-mix(in srgb,var(--wdw-accent) 60%,transparent)}',
      '#' + ID.root + ' .p-repo-count{font-size:11px;color:var(--wdw-ink-3);padding:0 2px}',
      // 收藏星标：圆形容器 + flex 居中（字体居中不能靠 default 的按钮内边距，会偏）
      '#' + ID.root + ' .p-card .star{position:absolute;top:5px;right:5px;width:22px;height:22px;box-sizing:border-box;border-radius:50%;border:0;background:rgba(0,0,0,.5);color:#ffd166;cursor:pointer;font-size:13px;line-height:1;display:flex;align-items:center;justify-content:center;padding:0;text-align:center;opacity:0;transition:opacity var(--wdw-dur-fast)}',
      '#' + ID.root + ' .p-card:hover .star{opacity:1}',
      '#' + ID.root + ' .p-card .star.wdw-on{opacity:1}',
      // 滑块 / 开关
      '#' + ID.root + ' input[type=range]{width:120px;accent-color:var(--wdw-accent)}',
      '#' + ID.root + ' .p-sw{position:relative;width:40px;height:22px;border-radius:999px;border:1px solid rgba(255,255,255,.18);background:var(--wdw-glass-fill);cursor:pointer;transition:background var(--wdw-dur-fast);flex:0 0 auto}',
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
      // ── 字体页：调色盘 + 可搜索字体列表 ──
      '#' + ID.root + ' .p-colorwrap{display:flex;align-items:center;gap:8px}',
      '#' + ID.root + ' input[type=color]{width:40px;height:24px;padding:0;border:1px solid var(--wdw-glass-line);border-radius:8px;background:transparent;cursor:pointer}',
      '#' + ID.root + ' input[type=color]::-webkit-color-swatch-wrapper{padding:2px}',
      '#' + ID.root + ' input[type=color]::-webkit-color-swatch{border:0;border-radius:5px}',
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
    ].join('\n') + '\n' + skinCss() + '\n' + pageSkinCss();
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

    return '<div class="p-pane">' + seg + repoBar + offlineBarHtml()
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
      // ③ 界面风格：五套独立皮肤，只换视觉层（结构/交互/尺寸不动），选择落本机
      + '<div class="p-sec"><span class="p-sec-t">界面风格</span>'
      + '<div class="p-chips" role="radiogroup" aria-label="界面风格">'
      + SKINS.map(function (s) {
        var on = s.id === skinId(st.skin);
        return '<button type="button" role="radio" aria-checked="' + on + '" data-skin="' + s.id + '"'
          + (on ? ' class="wdw-on"' : '') + '>' + esc(s.name) + '</button>';
      }).join('')
      + '</div>'
      + '<div class="p-hint p-note">只换视觉：结构与交互不变，选择记在本机</div>'
      + '</div>'
      // ④ 吉祥物
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
    var cur = u.currentVersion || '1.2.3';
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
    var tip = st.toast ? '<div class="p-toast">' + esc(st.toast) + '</div>' : '';
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
  function toast(msg, ms) {
    st.toast = msg || '';
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    if (st.toast) {
      toastTimer = setTimeout(function () { st.toast = ''; paint(); }, ms || 1600);
      if (toastTimer.unref) toastTimer.unref();
    }
    paint();
  }

  // ── 骨架 ────────────────────────────────────────────────────────────────
  // WIRE_VER：面板结构/行为变更时 +1。重注入（CDP 重连补注入）会重建元素，
  // 避免旧闭包的事件监听与新 __wdwPanel 状态 divergence（双闭包串味）。
  var WIRE_VER = '7';   // 7：新增「界面风格」五套皮肤（系统页多一段 → 结构变更）；6：渲染模式诊断；5：暂停/退出拆分
  function build() {
    var el = document.getElementById(ID.root);
    if (el && el.getAttribute('data-wdw-ver') !== WIRE_VER) { try { el.remove(); } catch (_) {} el = null; }
    if (!el) {
      el = document.createElement('aside');
      el.id = ID.root;
      el.setAttribute('data-wdw-ver', WIRE_VER);
      // 皮肤属性双写：<html> 管整页皮肤，面板根管面板自身（切换只改属性，不重建 DOM）
      applySkinAttr(skinId(st.skin));
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
    // 皮肤属性幂等补齐：重注入/宿主重载后属性可能丢，这里兜一次（不重建 DOM）
    var sk = skinId(st.skin);
    if (el.getAttribute('data-wdw-skin') !== sk) el.setAttribute('data-wdw-skin', sk);
    if (document.documentElement.getAttribute('data-wdw-skin') !== sk) {
      document.documentElement.setAttribute('data-wdw-skin', sk);
    }
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
    });
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
    toast('正在应用' + (title ? '：' + title : '…'), 8000);
    return req('/api/theme-bg', { id: 'standalone', wallpaper: name }).then(function (d) {
      st.applying = '';
      if (d == null) { st.err = '应用失败：服务未响应'; paint(); return; }
      if (!d.ok) { st.err = '应用失败：' + (d.error || '未知原因'); paint(); return; }
      return loadWallpapers().then(function () {
        paint();
        toast('已应用' + (title ? '：' + title : ''));
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
  function applyWe(id, title) {
    st.applying = String(id); st.err = '';
    toast('正在应用' + (title ? '：' + title : '…'), 15000);
    return req('/api/we-apply', { id: 'standalone', weId: String(id), sceneFps: st.sceneFps, muted: true }).then(function (d) {
      st.applying = '';
      if (d == null) { st.err = '应用失败：服务未响应'; paint(); return; }
      if (!d.ok) { st.err = '应用失败：' + (d.error || '未知原因'); paint(); return; }
      return loadWallpapers().then(function () {
        paint();
        toast('已应用' + (d.title ? '：' + d.title : ''));
      });
    }).catch(function () { st.applying = ''; st.err = '应用失败：请求异常'; paint(); });
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
        var KNOWN = '.p-tab,[data-src],[data-rf],[data-fav],[data-del],.p-card,[data-act],[data-fontcolor],[data-font],[data-skin],.p-seg button,.p-chips button,.p-btn';
        if (typeof e.clientX === 'number' && !(t.closest && t.closest(KNOWN))) {
          var visual = document.elementFromPoint(e.clientX, e.clientY);
          if (visual && visual.closest && visual.closest(KNOWN)) t = visual;
        }
        // 页签
        var tabBtn = t.closest ? t.closest('.p-tab') : null;
        if (tabBtn) { setTab(tabBtn.getAttribute('data-tab')); return; }
        // 系统页：界面风格（五套皮肤）
        var skinBtn = t.closest ? t.closest('[data-skin]') : null;
        if (skinBtn) { setSkin(skinBtn.getAttribute('data-skin')); return; }
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

  /** 切皮肤：只改根节点属性 + 本地偏好，不重建 DOM（结构/事件一律不动）。 */
  function setSkin(id) {
    st.skin = skinId(id);
    try { localStorage.setItem(LS_SKIN, st.skin); } catch (_) {}
    applySkinAttr(st.skin);
    paint();
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
      'wdw-theme-style', 'wdw-bg-video', 'wdw-bg-scene'];
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
    setSkin: setSkin,
    getSkin: function () { return skinId(st.skin); },
    refresh: function () { return Promise.all([loadWallpapers(), loadCustom(), loadHealth(), loadMask()]).then(function () { paint(); }).catch(function () {}); },
  };
  return { ok: true, id: ID.root };
}

function panelExpression(payload) {
  var p = Object.assign({ ids: IDS, tabs: TABS, lsTab: LS_TAB, lsPrefs: LS_PREFS, lsRepo: LS_REPO, filters: REPO_FILTERS, lsFont: LS_FONT, fontColors: FONT_COLORS, fontSwatches: FONT_SWATCHES, skins: SKINS, lsSkin: LS_SKIN, pageSkins: PAGE_SKINS }, payload || {});
  return '(' + wallpaperPanel.toString() + ')(' + JSON.stringify(p) + ')';
}

module.exports = { IDS, TABS, REPO_FILTERS, panelExpression, wallpaperPanel };
