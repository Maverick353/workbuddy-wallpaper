// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
/**
 * dsh-ui/index.js · 壁纸 UI 的统一入口（Node 侧；dsh 为本模块内部代号）
 * ------------------------------------------------------------------
 * 把两个浏览器端组件合成一段「可注入代码」，并负责三件宿主侧的事：
 *   ① 立绘内联：assets/buddy.png → data URI（缺素材返回 null，组件自动回退矢量形象）
 *   ② 旧卡片让位：body.wdw-dsh-ui 隐藏宿主注入的经典卡片（#wbs-wallpaper-card）
 *   ②b chrome 让位：顶部菜单栏 + 左侧边栏区域透明化，让壁纸透出（见 CHROME_CSS 注释）
 *   ③ 会话/端口参数：apiBase（独立环境用）、hostApi（宿主环境复用闭包 api，带鉴权）
 *
 * 注入方式（两种都支持，同一份代码）：
 *   · 宿主：daemon.buildInjectScript() 把 dshUIExpression() 拼进 build() 闭包（与 root/api 同域）
 *   · 独立/调试：CDP Runtime.evaluate(dshUIExpression({ apiBase }))
 *
 * 幂等：rope-buddy / panel 各自用 data-wdw-ver 自判重建；本模块的表达式可重复执行。
 * 回退：删掉 daemon 里的拼接段 → 插件行为与接入前完全一致（旧卡片照旧）。
 */

const fs = require('fs');
const path = require('path');
const rope = require('./rope-buddy.js');
const panel = require('./panel.js');

const ART_PATH = path.join(__dirname, 'assets', 'buddy.png');
const STYLE_ID = 'wdw-dsh-ui-style';

/** 旧卡片让位：宿主注入的经典卡片（#wbs-wallpaper-card）一律隐藏，本 UI 是唯一界面。
 *  （2026-10-13 移除「经典卡片」模式切换：card 模式会藏掉拉绳导致面板无法再次打开的死锁，
 *   且独立形态下经典卡片依赖宿主注入、本就不完整。） */
const YIELD_CSS = 'body.wdw-dsh-ui #wbs-wallpaper-card{display:none !important}';

/**
 * chrome 让位 / 透明化（2026-10-13 定位与实测）：
 *   · 顶部 #workbuddy-menubar-container（30px 应用菜单栏，原 rgb(12,12,14) 不透明底）
 *     → 全透明化（背景/blur/阴影/边框全撤），与会话名称栏观感一致；保留其窗口拖动区
 *     与菜单/窗口按钮的可交互性（详见该规则处注释）
 *   · 右上角窗口控制按钮容器 .workbuddy-window-controls（原 rgb(12,12,14) 不透明）→ 透明化
 *   · 左侧 #root 的 background-image 第二层 linear-gradient(90deg, 40%黑 0→18%, 透明 42%)
 *     —— 侧栏宽 240px / 1222px ≈ 19.6%，正好整个落在实心黑区（死黑侧栏的根源）→ 整层剥掉
 *   · .conversation-sidebar → **原始贴边模式**（撤掉曾做过的「悬浮岛」）：贴左缘、满高、直角，
 *     透明 + **必须去掉宿主的 backdrop-filter**（否则采到黑画布底 → 侧栏变"不透明黑板"，实测 4 倍压暗）。
 *     旧版岛样式的内联残留由 yieldCode 清理。
 *   · .conversation-list 保持透明
 *   · 承载 tooltip/dropdown 的按钮容器：中和 daemon theme-patches 过宽的 [class*="tooltip"] 底色
 *   · 会话名称栏 .workbuddy-topbar（顶部 sticky、原 rgba(10,10,10,.55) 深色横栏）→
 *     透明化 + pointer-events 穿透（两条包裹层 none、可交互控件 auto）。理由见下方规则注释：
 *     透明 ≠ 不拦截点击，挡点击的是层叠顺序，必须同时改 pointer-events。
 * 输入区/列表项有独立背景兜底，可读性不受影响（实测）。菜单文字为白色，若换亮色壁纸
 * 糊字，把 menubar 的 alpha 提到 .5 或加暗角。
 */
const CHROME_CSS = [
  // 顶部应用菜单栏（编辑/窗口/帮助/关于）：全透明化，与会话名称栏同一观感。
  // ⚠️ 此处**只透明、不加 pointer-events:none** —— 与 .workbuddy-topbar 的处置刻意不同：
  //    实测本容器 `-webkit-app-region: drag`（整条 1920x30 都是窗口拖动区，中间空白处
  //    elementFromPoint 命中的就是它本身）。pointer-events:none 会让命中测试跳过它 →
  //    拖窗口失效。且它并未挡住壁纸插件（buddy 被 clampPos 限制在 y≥29；面板 z=997 虽
  //    低于本栏 z=10000，但其关闭按钮中心在 y≈37 > 30 仍可点）。故保留可交互性。
  '#workbuddy-menubar-container{background:transparent !important;background-color:transparent !important;background-image:none !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;box-shadow:none !important;border-color:transparent !important;}',
  // 右上角「窗口控制按钮」（— ▢ ✕）容器：原本是不透明深色块（.workbuddy-window-controls
  // bg=rgb(12,12,14)，138x30）→ 透明化，与菜单栏/会话栏连成一片。
  // 其竞争规则在 #workbuddy-desktop-layout-overrides 的 `body[data-platform="windows"] .workbuddy-window-controls`
  // （无 !important）→ 本规则带 !important 即稳赢（试算实测 bg→rgba(0,0,0,0)）。
  // 只改容器、不动 .workbuddy-window-control-button 本身，保留按钮自身的 hover 反馈与点击。
  '#workbuddy-window-controls-container,#workbuddy-window-controls-container .workbuddy-window-controls,.workbuddy-window-controls{background:transparent !important;background-color:transparent !important;background-image:none !important;box-shadow:none !important;border-color:transparent !important;}',
  '#root{background-image:none !important;}',
  // 会话侧栏：**回退为原始贴边模式**（2026-10-13 用户要求撤掉「悬浮岛」）。
  // 仅保留「透明 + 让壁纸透出」；宽高不设，交给宿主自己的内联值。
  // ⚠️ 必须同时去掉宿主的 backdrop-filter（blur(18px) saturate(1.15)）：实测（bisect）
  //    侧栏区域平均亮度 基线 20.6 → 去 backdrop-filter 后 78.6（≈4 倍），隐藏侧栏 79.1。
  //    即「带 backdrop-filter 时合成器采样的 backdrop 不含壁纸层（壁纸 iframe 位于负 z 层），
  //    采到近乎纯黑的画布底 → 侧栏看起来是一块不透明黑板」。去掉后侧栏才真正透出壁纸。
  //    宿主该规则特异度高于双类名，故用三连类名（0,3,0）+ !important（实测生效）。
  '.conversation-sidebar.conversation-sidebar.conversation-sidebar{margin:0 !important;border-radius:0 !important;background-color:transparent !important;background-image:none !important;border:0 !important;box-shadow:none !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;}',
  '.conversation-list.conversation-list{background-color:transparent !important;background-image:none !important;}',
  // 宿主原生分隔线（近黑 1px）→ 透明：用户视感里的「左侧黑线」
  //   · .conversation-list 右边框 rgb(19,19,22)：贯穿侧栏全高的竖线（0,30 360x1002）
  //   · .conversation-list-footer 上边框 rgb(27,27,32)：底部工具栏横线（0,975 359x57）
  //   二者特异度需压宿主，沿用三连类名 + !important（与会话侧栏同策略）
  '.conversation-list.conversation-list.conversation-list{border-right-color:transparent !important;}',
  '.conversation-list-footer.conversation-list-footer{border-top-color:transparent !important;}',
  // 左上残留黑线（2026-10-13 二轮排查）：宿主布局容器留下的 1px 深色竖条
  //   · .sources-panel：1px 宽 x 1002 高，背景 rgb(10,10,10)，紧贴左缘 x=0（贯穿全高的竖黑线）
  //   · .detail-panel-container：1px 左缘边框 rgb(27,27,32)（x=-1）
  '.sources-panel.sources-panel.sources-panel{background-color:transparent !important;background-image:none !important;border-color:transparent !important;}',
  '.detail-panel-container.detail-panel-container{border-left-color:transparent !important;}',
  // 「编辑(E)」左侧的竖分隔线：`#workbuddy-titlebar-left-slot::after` 伪元素（1x16px rgb(27,27,32)）
  '#workbuddy-titlebar-left-slot::after{background:transparent !important;background-color:transparent !important;}',
  // 左上深色块：`.sidebar-next-main-header`（-16,30 32x64，rgb(12,12,14) + 底部 1px 边框）
  '.sidebar-next-main-header{background-color:transparent !important;background-image:none !important;border-color:transparent !important;}',
  // 「发现应用」按钮的黑框：仅去掉静态边框（保留 hover 反馈，hover 时宿主样式生效）
  '.conversation-sidebar .wb-button:not(:hover){border-color:transparent !important;}',
  // 承载 tooltip/dropdown 的**按钮/触发器容器**被 daemon 的 theme-patches 误涂：
  //   `html[data-theme=dark] body[data-vscode-theme-name] [class*="tooltip"]:not(…):not(…)…{background:var(--wb-bg-popover) !important}`
  //   （以及同族的 [class*="dropdown"]/[class*="popover"]/[class*="popper"]…）——作者已为若干
  //   误伤加过 :not(...) 排除，但漏了这批：实测「语音按钮」父级 .cr-voice-trigger-tooltip、
  //   左上 .artifact-tabs__action-tooltip、CSS-Module 命名的 ._tooltipTriggerFill_* / ._dropdown_* 等
  //   32×32 图标按钮全被涂成不透明 popover 底色（rgb(17,17,19)）→ 看起来是「黑色按钮」。
  //   该选择器特异度极高（~0,8,2 + !important），硬拼不划算 → **就地重定义 CSS 变量**，
  //   让它自己的 var(--wb-bg-popover) 解析为透明（只作用于这些「触发器/包裹层」，真实气泡不受影响）。
  '.cr-voice-trigger-tooltip,[class*="tooltipTrigger"],[class*="tooltip-trigger"],[class*="tooltip-wrapper"],[class*="tooltip-anchor"],[class*="action-tooltip"],[class*="_tooltip"],[class*="_dropdown"]{--wb-bg-popover:transparent !important;}',
  // ── 会话名称栏（.workbuddy-topbar：顶部显示当前会话名的 sticky 横栏）──
  // ① 透明化：原本 bg = rgba(10,10,10,.55) 不透明深色（实测 color(srgb .039 .039 .039 / .55)），
  //    宽 1640 高 64、z-index 101 横贯会话区顶部，会盖住壁纸与下层 UI → 设为全透明。
  // ② 不拦截点击：⚠️ 仅「透明」不能恢复点击 —— 透明元素依然捕获指针事件（CSS 命中的是盒模型，
  //    不是像素）。真正决定点击去向的是 z-index/层叠顺序 + pointer-events：
  //    · 本栏 z=101；拉绳 buddy z=996、面板 z=997 都在它之上，故这两者当前可点；
  //    · 但任何 z 低于 101 的界面元素落在本栏矩形内，点击会被本栏吃掉 → 故给两条包裹层
  //      设 pointer-events:none，让点击「穿透」到下层；再把真正的可交互控件（按钮/输入/
  //      role=button/menuitem/tabindex）恢复 auto，保证栏上原有按钮照常可用。
  // 优先级：daemon 的 #wbs-theme-style 用 `body[data-vscode-theme-name] .workbuddy-topbar`
  // （0,2,1 + !important）给本栏上深色底与 blur，规则数（class数）比单类多 → 必须用
  // 三连类名（0,3,0）才能压过（与侧栏同一手法：仅靠单类名 !important 会被压）。
  '.workbuddy-topbar.workbuddy-topbar.workbuddy-topbar{background:transparent !important;background-image:none !important;background-color:transparent !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;box-shadow:none !important;border-color:transparent !important;pointer-events:none !important;}',
  '.workbuddy-topbar-options.workbuddy-topbar-options{background:transparent !important;background-image:none !important;box-shadow:none !important;pointer-events:none !important;}',
  '.workbuddy-topbar button,.workbuddy-topbar a,.workbuddy-topbar input,.workbuddy-topbar select,.workbuddy-topbar textarea,.workbuddy-topbar [role="button"],.workbuddy-topbar [role="menuitem"],.workbuddy-topbar [role="tab"],.workbuddy-topbar [tabindex]{pointer-events:auto !important;}',
].join('\n');

let artCache;
/** 立绘 data URI（首次读取后缓存；缺失返回 null → 组件回退矢量 buddy）。 */
function artDataUri() {
  if (artCache !== undefined) return artCache;
  try { artCache = 'data:image/png;base64,' + fs.readFileSync(ART_PATH).toString('base64'); }
  catch (_) { artCache = null; }
  return artCache;
}

/** 旧卡片让位（静态）+ 旧版「岛式侧栏」残留清理。
 *  body 加 wdw-dsh-ui 配合 YIELD_CSS。
 *  2026-10-13 用户要求侧栏回退为原始贴边模式 → 移除原先的 MutationObserver「持久补写岛样式」
 *  机制（该机制曾因同步递归回调用微任务饿死主线程，属脆弱设计，一并去掉）。
 *  但旧版是用**内联 !important** 写死的，仅删代码这些内联样式仍会生效 → 这里必须主动清一次：
 *  只删「优先级为 important」的属性（那是我们写的；宿主自己的内联 width/height 无 important，
 *  不能误删），并清掉标记属性；随后派发一次 resize 促使宿主重渲染、恢复它自有的内联尺寸。 */
function yieldCode() {
  return [
    '(function(){',
    'if(typeof document==="undefined")return;',
    'try{document.body.classList.add("wdw-dsh-ui");}catch(_){}',
    'try{localStorage.removeItem("wdw.ui.mode");}catch(_){}',
    'if(window.__wdwIslandCleaned)return;',
    'window.__wdwIslandCleaned=1;',
    'try{var el=document.querySelector(".conversation-sidebar");',
    'if(el&&el.getAttribute("data-wdw-island")==="1"){',
    '  el.removeAttribute("data-wdw-island");',
    '  ["width","margin","height","border-radius","background-color","background-image","backdrop-filter","-webkit-backdrop-filter","border","box-shadow","overflow"].forEach(function(p){try{if(el.style.getPropertyPriority(p)==="important")el.style.removeProperty(p);}catch(_){}});',
    '  try{window.dispatchEvent(new Event("resize"));}catch(_){}',
    '}}catch(_){}',
    'try{if(window.__wdwIslandWatch&&window.__wdwIslandWatch.disconnect)window.__wdwIslandWatch.disconnect();}catch(_){}',
    'try{delete window.__wdwIslandWatch;}catch(_){}',
    '})();',
  ].join('\n');
}

function styleCode() {
  return [
    '(function(){',
    'if(typeof document==="undefined")return;',
    'var s=document.getElementById(' + JSON.stringify(STYLE_ID) + ');',
    'if(!s){s=document.createElement("style");s.id=' + JSON.stringify(STYLE_ID) + ';(document.head||document.documentElement).appendChild(s);}',
    's.textContent=' + JSON.stringify(YIELD_CSS + '\n' + CHROME_CSS) + ';',
    '})();',
  ].join('\n');
}

/** 字体皮肤：把「文字颜色（纯白/纯黑）」与「字体族」写进 `<style id="wdw-font-style">`。
 *  独立于面板生命周期 —— 注入时即按 localStorage['wdw.font'] 应用；面板只负责改值
 *  （window.__wdwFont.set）。两项都只在被选中时覆盖（默认 = 不产出任何规则）。 */
function fontCode() {
  return [
    '(function(){',
    'if(typeof document==="undefined")return;',
    'var KEY="wdw.font";',
    'var FAM={',
    'default:"",',
    'yahei:"\\"Microsoft YaHei\\",\\"微软雅黑\\",system-ui,sans-serif",',
    'simhei:"SimHei,\\"黑体\\",sans-serif",',
    'simsun:"SimSun,\\"宋体\\",serif",',
    'kaiti:"KaiTi,\\"楷体\\",serif",',
    'dengxian:"DengXian,\\"等线\\",sans-serif",',
    'mono:"Consolas,\\"Courier New\\",monospace"',
    '};',
    'function read(){try{return JSON.parse(localStorage.getItem(KEY)||"{}")||{};}catch(_){return {};}}',
    'function apply(){',
    'var p=read();var css="";',
    // 特异性：宿主用「类选择器 + !important」给自己的文字上色（实测 .conversation-section-label-text
    // 等），body * 只有 (0,0,1) 会被压 → 用 :not(#id) 把选择器抬到 (1,0,2)。
    // 另：不少文字的可见色来自 -webkit-text-fill-color（它会盖过 color），必须一起设。
    'var SEL="html,body,html body *:not(#wdw-noop)";',
    // 颜色：支持任意 #rrggbb（面板调色盘），兼容历史值 white/black；空串 = 不覆盖
    'var cc=String(p.color||"");var c="";',
    'if(/^#[0-9a-fA-F]{6}$/.test(cc))c=cc;else if(cc==="white")c="#ffffff";else if(cc==="black")c="#000000";',
    'if(c){',
    'css+=SEL+"{color:"+c+" !important;-webkit-text-fill-color:"+c+" !important}";',
    'css+="html body *:not(#wdw-noop)::before,html body *:not(#wdw-noop)::after{color:"+c+" !important;-webkit-text-fill-color:"+c+" !important}";',
    // SVG 文本 + 图标：图标的可见色来自 fill（宿主灌的是 rgb(255,255,255)），必须一起改，
    // 否则「纯黑」下文字全黑、图标却还是白的（用户实测反馈）。
    // 用 :not([fill=none]) 放过描边式图标，避免把空心图标填成实心块。
    'css+="html body svg text,html body svg tspan{fill:"+c+" !important}";',
    'css+="html body svg:not([fill=none]),html body svg *:not([fill=none]){fill:"+c+" !important}";',
    '}',
    // 字体：历史短码走 FAM；面板现在直接存整条 CSS 栈（含引号）→ 原样用
    'var f=FAM[p.family]||((typeof p.family==="string"&&p.family.indexOf(String.fromCharCode(34))>=0)?p.family:"");',
    'if(f)css+=SEL+"{font-family:"+f+" !important}";',
    'var s=document.getElementById("wdw-font-style");',
    'if(!s){s=document.createElement("style");s.id="wdw-font-style";(document.head||document.documentElement).appendChild(s);}',
    'if(s.textContent!==css)s.textContent=css;',
    '}',
    'window.__wdwFont={apply:apply,get:read,set:function(k,v){var p=read();p[k]=v;try{localStorage.setItem(KEY,JSON.stringify(p));}catch(_){}apply();}};',
    'apply();',
    '})();',
  ].join('\n');
}

/**
 * 生成可注入代码（自执行表达式序列）。
 * @param {{ apiBase?: string, art?: string|null, hostApi?: boolean }} [opts]
 *   apiBase 独立环境的内核地址；hostApi=true 时面板优先用宿主闭包的 api()（自带鉴权）；
 *   art 传 undefined 用内置立绘，传 null 强制走矢量形象。
 */
function dshUIExpression(opts) {
  const o = opts || {};
  const art = o.art !== undefined ? o.art : artDataUri();

  const ropeExpr = rope.ropeBuddyExpression(art ? { art } : {});
  const panelOpts = {};
  if (o.apiBase) panelOpts.apiBase = o.apiBase;
  if (o.hostApi) panelOpts.hostApi = true;
  const panelExpr = panel.panelExpression(panelOpts);

  return [
    '/* workbuddy-wallpaper · 壁纸 UI（拉绳 buddy + 五页签面板）*/',
    styleCode(),
    fontCode(),
    yieldCode(),
    ropeExpr + ';',
    panelExpr + ';',
  ].join('\n');
}

module.exports = { STYLE_ID, artDataUri, dshUIExpression };
