// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
/**
 * theme-css · 主题背景 CSS/URL 拼装（从 daemon.js applyThemeByCdp 等价抽出）
 * ==================================================================
 * 职责单一化重构（R1）：巨函数中「背景资产解析 + CSS/URL 拼装」的纯逻辑层。
 * 输入全部参数化（themesDir / port / daemonBoot / mask 由调用方传入），
 * 输出与原内联实现**逐字符等价**——等价性由 test/theme-css-snapshot.test.js
 * 快照 + 真机 computed style diff 双重锁定，禁止在此调整任何视觉参数。
 * ⚠️ 例外记录：2026-10-13 按用户反馈有意移除三处压暗层 —— #root 的「底部渐暗」(180deg)、
 *    #root 的「左侧边缘渐变」(90deg)、[data-view-id=main-content] 的「底部渐变」，
 *    缘由与影响见下方 bgHead/bgTail 处注释。除此之外仍禁止在本文件随意调整视觉参数。
 *    注：本技能工程目录内并未携带 test/ 快照用例（该测试属上游 daemon 仓库）。
 *
 * 三类背景分支（与原实现一致）：
 *   视频（.mp4/.webm/.ogg/.mov）→ bgVideoUrl（/theme-media 流，带 mtime+size 版本参数）
 *   场景（.pkg）               → bgSceneUrl（WebWallGL 渲染页，r=daemonBoot 强制重载）
 *   图片（其余）               → bgCssStr 内联 url(dataURL)
 * 三类的 bgCssStr 公共头尾一致：蒙版渐变 + 容器/侧栏/主内容透明化。
 */

const fs = require('fs');
const path = require('path');
// VIDEO_EXTS 以 wallpaper core/media.js 为单一源（daemon.js 顶部保留的副本仅为
// 注入表达式内部使用，两者必须一致的约定由此收敛为一处定义）。
const { VIDEO_EXTS } = require('./media.js');

/** 背景蒙版不透明度：读 dataDir/mask.json（默认 0 = 不压暗壁纸；2026-10-13 用户要求消除蒙版）。 */
function readMask(dataDir) {
  let mask = 0;
  try {
    const maskFile = path.join(dataDir, 'mask.json');
    if (fs.existsSync(maskFile)) {
      const v = parseFloat(JSON.parse(fs.readFileSync(maskFile, 'utf8')).opacity);
      if (!Number.isNaN(v)) mask = Math.min(1, Math.max(0, v));
    }
  } catch (_) {}
  return mask;
}

/** 在 themesDir 下解析主题背景文件的真实路径（candidates + 兜底全子目录搜索）。 */
function resolveBackgroundPath(themesDir, theme, id) {
  const safeId = String(theme.id || id).replace(/[^A-Za-z0-9_-]/g, '_');
  const candidates = [
    path.join(themesDir, safeId, String(theme.image).replace(/^\.\.?[/\\]/, '')),
    path.join(themesDir, safeId, 'background.' + String(theme.image).split('.').pop()),
    path.join(themesDir, String(theme.image).replace(/^\.\.?[/\\]/, '')),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return { safeId, imgPath: c };
  }
  // 兜底：按文件名在 themes 所有子目录里搜索（兼容旧 build 上传时目录 id 与主题 id 不一致的情况）
  try {
    const wanted = String(theme.image).split('/').pop().split('\\').pop();
    for (const sub of fs.readdirSync(themesDir)) {
      const p = path.join(themesDir, sub, wanted);
      if (fs.existsSync(p)) return { safeId, imgPath: p };
    }
  } catch (_) {}
  return { safeId, imgPath: null };
}

/**
 * 解析主题背景并拼装 CSS / 媒体 URL。
 * @param {object} p
 *   theme        主题对象（需 image 字段；来自 getTheme(id)）
 *   id           主题 id
 *   themesDir    主题根目录（daemon THEMES_DIR）
 *   port         daemon 实际监听端口（daemon ACTUAL_PORT）
 *   daemonBoot   daemon 启动纪元（daemon DAEMON_BOOT）
 *   dataDir      数据目录（读 mask.json）
 * @returns {{ bgCssStr: string, bgVideoUrl: string|null, bgSceneUrl: string|null }}
 */
function resolveBackgroundAssets(p) {
  const { theme, id, themesDir, port, daemonBoot, dataDir } = p;
  // bgVideoUrl：主题背景是视频时为 /theme-media 的流地址，供注入表达式创建 <video> 背景层；图片背景保持 null
  let bgVideoUrl = null;
  // bgSceneUrl：主题背景是 scene.pkg 场景时为 WebWallGL 渲染页地址（iframe 加载），供注入表达式创建场景背景层
  let bgSceneUrl = null;
  let bgCssStr = '';
  if (theme && theme.image) {
    try {
      const { safeId, imgPath } = resolveBackgroundPath(themesDir, theme, id);
      if (imgPath) {
        const mask = readMask(dataDir);
        // 背景毛玻璃已退役：应用容器（含侧边任务栏）改为纯透明普通样式，壁纸清晰透出
        //（可读性由上方黑色蒙版压暗保证）。readBackgroundBlur 与 /api/blur 接口保留向后兼容。
        const containerBlurCss = 'backdrop-filter:none !important;-webkit-backdrop-filter:none !important;';
        // 背景层公共部分：仅均匀蒙版 + 容器透明化
        // 图片：在 bgHead 后追加 url(dataURL)；视频：不加 url，改用 /theme-media 的 <video>（由注入表达式创建）
        // 2026-10-13 视觉调整（有意为之，非误改）：
        //   ① 移除「底部渐暗」层（180deg 58%→100%），② 移除「左侧边缘渐变」（90deg 0-18% 压 40%）。
        //   原因：用户对比后要求「整个页面亮度跟最上面一样」——而 #root 从 y=30 才开始、顶部 30px
        //   本来就不在 #root 内，故只有 #root 上的这些压暗层会让内容区比顶部暗。全部撤掉后
        //   全页亮度一致。若日后需要压暗（提升文字可读性），用「外观」页的均匀蒙版即可。
        // ── 特异性提升（2026-10-14 实测确立；2026-10-16 补注：X/P 必须声明在 bgHead 之前）──
        // 宿主给自己的容器/文字配了「类选择器 + !important」，我们 (0,2,1) 级的规则**压不住**。
        // 通解：给每条选择器挂 `:not(#不存在id)`，把特异性抬到 (1,0,x)（三连类名亦可，但这里选择器
        // 形态多样，统一用 :not 更省心）。⚠️ 验证时必须**跨任务读值**：同一任务内改完样式立刻
        // getComputedStyle 会返回旧值，会让人误判"没生效"（本文件今天的排查就踩过这个坑）。
        const X = ':not(#wdw-noop)';
        const P = 'body[data-vscode-theme-name] ';
        // ⚠️ `#root` 必须挂 `:not(#wdw-noop)` 抬特异性（2026-10-16 事故）：
        //   同机还有一份**旧壁纸注入**（WorkDaddy daemon 的 `#wbs-theme-style`，端口 47832，
        //   经同一个 CDP 9222 注入），它也给 `#root` 挂 `background-image`（一条 90deg 40% 左渐暗
        //   + 一条 180deg 底部渐暗 + 一张内嵌 base64 壁纸）。两条规则**同优先级 (1,0,0)、都 !important**
        //   → 纯靠「谁后注入谁赢」。注入顺序取决于两个服务的启动先后，**今天是随机的**：
        //   实测 daemon 的 style 排在后面时，我们的场景壁纸被整屏盖成「偏蓝 + 底部山脉」。
        //   修法：`#root:not(#wdw-noop)` 抬到 (1,1,0)，**不看顺序稳赢**。已实测最坏顺序（插到 head 最前）仍生效。
        const bgHead = [
          '#root' + X + '{background:',
          'linear-gradient(rgba(0,0,0,' + mask + '),rgba(0,0,0,' + mask + '))',
        ].join('');
        const bgTail = [
          P + '.teams-container' + X + ',' + P + '.teams-container.is-mac' + X + '{background:transparent !important;' + containerBlurCss + '}',
          P + '[data-view-id]' + X + '{background:transparent !important}',
          P + '.main-content' + X + '{background:transparent !important}',
          // 左侧菜单（会话列表）透明，背景直接透出
          P + '.conversation-list' + X + ',' + P + '[data-view-id=sidebar]' + X + '{background:transparent !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important}',
          // 2026-10-14 定位：WorkBuddy 5.8.2 新增了三个**不透明的布局容器**，把整张壁纸盖死
          //   （实测：.teams-grid-scroll-content = rgb(20,20,20) 覆盖 97% 视口、
          //    ._gridView_<hash> = rgb(31,31,31) 覆盖 97%、.conversation-shell = rgb(20,20,20) 覆盖 74%）。
          //   表现为「壁纸不显示 + 整页纯黑」。类名含 CSS-module 哈希，故 _gridView_ 用属性子串匹配。
          P + '.teams-grid-scroll-content' + X + '{background:transparent !important}',
          P + '[class*="_gridView_"]' + X + ',' + P + '[class*="_gridViewItem_"]' + X + '{background:transparent !important}',
          P + '.conversation-shell' + X + '{background:transparent !important}',
          // ── 2026-10-28「资料库页像图片裂了」事故：页面型内容失去了可读面 ──
          //   症状：引导卡片正中透出一块白色窗户，表格行直接浮在星空上，右侧一大片壁纸。
          //   实测根因：卡片自带底色只有 rgba(255,255,255,.06)，表格外壳 wb-feed-content-shell 全透明，
          //   而 wb-home-page-pc(1364) ⊃ body(1024) ⊃ dock(928) ⊃ card 四层都没有实底 ⇒ 壁纸直接穿透。
          //   那块"窗户"是**壁纸图案**，不是图片没加载：摘掉壁纸层后白块即消失（已用像素差验证）。
          //   ⚠️ 2026-10-29 用户反馈「资料库仍未适配」：当天把底板定成 .97（几乎实心）后，整页变成一大块
          //     死黑，壁纸在该页完全看不到 —— 属于"为了可读性把适配性做没了"。
          //   ⇒ 改为**分层**：外层页壳透壁纸（.62），可读性交给内层内容面（表格壳 .45 深 + 卡片白 .10）。
          //     实测取值：.74 时壁纸对卡片影响 69 级（图案可辨）→ 现在 .62 + 内层 .45，总遮挡 ≈ .79，
          //     图案只剩氛围感、看不出硬边，同时页边与卡片间隙能明确看到壁纸。
          //   ⚠️ 不加 backdrop-filter（.82 + blur(18px) 观感最好，但 GPU 425% → 629%，≈多烧 2 核）。
          P + '[class*="wb-home-page-pc"]' + X + '{background:rgba(13,15,20,.62) !important;border-radius:16px}',
          P + '[class*="wb-home-page-body"]' + X + ',' + P + '[class*="wb-home-guide-dock"]' + X + '{background:transparent !important}',
          // 左侧知识库栏比内容区略实（.72），保证栏内文字在壁纸亮部也可读，同时与内容区分层不糊成一片
          P + '[class*="knowledge-sidebar-pc"]' + X + '{background:rgba(13,15,20,.72) !important;border-radius:16px}',
          // 「我的文件」抽屉面板（2026-10-29 扫描：原生近黑，与页壳同样处理）
          P + '[class*="my-files-panel"]' + X + '{background:rgba(13,15,20,.62) !important}',
          // 只给卡片本体（-card-pc），别用 [class*="wb-home-guide-card"] —— 那会连 -title-pc / -desc-pc
          // 一起上色，文字底下出现一块块浅色方块（实测踩过）。
          P + '[class*="wb-home-guide-card-pc"]' + X + '{background:rgba(255,255,255,.10) !important}',
          P + '[class*="wb-home-guide-card-list"]' + X + ',' + P + '[class*="wb-home-guide-header"]' + X + '{background:transparent !important}',
          // 表格/列表外壳：不再只是 .05 白（那是配 .97 死底用的），改为深底 .45 —— 行内文字直接压在
          // 壁纸上会花，深底 + 外层 .62 合计 .79，既保读又不至于让页面变死黑。
          P + '[class*="wb-feed-content-shell"]' + X + '{background:rgba(13,15,20,.45) !important;border:1px solid rgba(255,255,255,.08) !important;border-radius:12px}',
          // 2026-10-29「报告卡片背后一片死黑」事故：定时任务报告页的 automation-run-group__item
          // 自带**不透明**底（实测 rgb(10,10,10) 与 rgb(22,22,25)，848×400 两块，把壁纸盖死；
          // 我们的选择器在该页 0 命中，纯宿主原生样式）。改半透明玻璃底：壁纸透出、文字仍可读。
          // 取值 .62：壁纸是深色星空场景时正文对比足够；同样不加 backdrop-filter（GPU 代价，见上）。
          // 双 token 连写匹配（"__item __item--"）只命中卡片根，不会误染标题等内部元素。
          P + '[class*="automation-run-group__item automation-run-group__item--"]' + X + '{background:rgba(13,15,20,.62) !important;border:1px solid rgba(255,255,255,.10) !important}',
          // 同批扫描（2026-10-29）发现：定时任务页「本会话用量」卡片 atm-task-card 原生也是实心黑，
          // 与上面同一处理（.62 玻璃底 + 细边），保持全站卡片观感一致。
          P + '[class*="atm-task-card"]' + X + '{background:rgba(13,15,20,.62) !important;border:1px solid rgba(255,255,255,.10) !important}',
          // 2026-10-29 逐按钮扫描补漏（宿主原生 rgb(36,36,36) 实心黑）：
          //   · 下拉气泡 wb-popover（资料库「新建/最近/本地产物」菜单）
          //   · 新建空间弹窗 workspace-tree-create-space-dialog-pc
          //   · 弹层遮罩 workspace-tree-modal-overlay-pc 原 rgba(0,0,0,.8)，压到 .55 让壁纸仍可辨
          // 弹层不比页面，内容密集 → 保留 .86~.90 的实度，只让壁纸成为一层极淡底纹。
          P + '[class*="wb-popover"]' + X + '{background:rgba(28,30,36,.86) !important}',
          P + '[class*="workspace-tree-create-space-dialog-pc"]' + X + '{background:rgba(22,24,30,.90) !important}',
          P + '[class*="workspace-tree-modal-overlay-pc"]' + X + '{background:rgba(0,0,0,.55) !important}',
          // 同批扫描：WorkDaddy 注入层（wbs-*）的弹层同样是 rgb(36,36,36) 实心黑。
          //   模态框用 :not([class*="wbs-modal-"]) 只命中根节点，避免把 -title/-body/-actions 也上色。
          P + '[class*="wbs-modal"]:not([class*="wbs-modal-"])' + X + '{background:rgba(22,24,30,.90) !important}',
          P + '[class*="wbs-modal-mask"]' + X + '{background:rgba(0,0,0,.55) !important}',
          P + '[class*="wbs-status-popover"]' + X + ',' + P + '[class*="wbs-credit-summary-popover"]' + X + ',' + P + '[class*="wbs-telemetry-tooltip"]' + X + '{background:rgba(28,30,36,.88) !important}',
          // 2026-10-14 二轮：左侧任务栏里成片发黑的小块 —— 同样是 5.8.2 新增的不透明底 rgb(31,31,31)：
          //   小节标签 .conversation-section-label（任务/分组）、小节头 [class*="_headerTopPadding_"]、
          //   消息队列 .conversation-message-queue、短标签 [class*="_capsule_"]、
          //   输入区外框 .cr-input-container（内层 [class*="chat-input"] 仍保留 40% 毛玻璃保证可读性）。
          P + '.conversation-section-label' + X + '{background:transparent !important}',
          P + '[class*="_headerTopPadding_"]' + X + '{background:transparent !important}',
          P + '.conversation-message-queue' + X + ',' + P + '.cb-message-queue' + X + '{background:transparent !important}',
          // 「N 个后台任务运行中」胶囊（[class*="_capsule_"]）：原本 1px rgb(58,58,58) 深灰描边，
          // 在透明主题下就是一圈「黑线」→ 换成与聊天输入框同款细边框（rgba(255,255,255,.16)）
          // + 极淡玻璃底，观感与输入框一致（2026-10-14 用户要求）。
          P + '[class*="_capsule_"]' + X + '{background-color:rgba(255,255,255,.06) !important;background-image:none !important;border-color:rgba(255,255,255,.16) !important}',
          P + '[class*="_previewHeader_"]' + X + '{background:transparent !important}',
          P + '.cr-input-container' + X + '{background:transparent !important}',
          // WorkDaddy 注入的输入框内联按钮（「暂存提示词」/「增强」）自带 90% 白底，在透明主题下
          // 就是两个白圆块（用户实测反馈）。与同排的语音/模型选择按钮对齐：一律透明。
          P + '[class*="wbs-stash-inline"]' + X + ',' + P + '[class*="wbs-explore-inline"]' + X + '{background:transparent !important;border-color:transparent !important}',
          // 输入框区域：毛玻璃背景（背景透出）
          P + '[class*="chat-input"]' + X + '{background:color-mix(in srgb,var(--wb-bg-primary) 40%,transparent) !important;backdrop-filter:blur(20px) saturate(1.15);-webkit-backdrop-filter:blur(20px) saturate(1.15)}',
          // 2026-10-13 移除「主内容区底部渐变」（原 38%→100% 压 55% 深色）：底部发暗的主因之一，
          // 按用户反馈去掉。如需重新压暗底部以提升可读性，改用提高均匀蒙版（外观页滑条）即可。
        ].join('');
        const imgExt2 = path.extname(imgPath).toLowerCase();
        if (VIDEO_EXTS.indexOf(imgExt2) !== -1) {
          // 视频背景：不内联 dataURL；<video> 层由注入表达式创建，源为 daemon /theme-media 流
          // 关键：URL 路径恒为 background.<ext>，换壁纸时路径不变。必须带内容版本参数（mtime+size），
          // 否则前端「是否需要重新加载」的判断永远命中旧键 -> 一直播放上一次的旧视频。
          let bgVer = '0';
          try { const _st = fs.statSync(imgPath); bgVer = Math.round(_st.mtimeMs) + '-' + _st.size; } catch (_) {}
          bgVideoUrl = 'http://127.0.0.1:' + port + '/theme-media/' + encodeURIComponent(safeId) + '/' + encodeURIComponent(path.basename(imgPath)) + '?v=' + bgVer;
          bgCssStr = bgHead + ' !important;}' + bgTail + 'html' + X + ',body' + X + '{background:transparent !important}';
        } else if (imgExt2 === '.pkg') {
          // 场景背景：iframe 加载 vendored WebWallGL 渲染页。
          // 渲染器契约（lib/webwallgl 实测）：src 是 mediaBase 下的**目录 token**，
          // 渲染器自行探测 <src>/project.json（松散形态）与 <src>/scene.pkg 等候选（打包形态）。
          // mediaBase 指向 daemon 的 /wallpaper-engine/scene-files（从 Steam 创意工坊目录直读，带 ETag 304）。
          // r= daemon 启动纪元：daemon 重启后强制 iframe 重载，避免持有断连的旧渲染会话。
          const weTok = String((theme && theme.weId) || '').replace(/[^0-9]/g, '');
          // 场景渲染选项（可配置化）：无 weOptions 时输出与历史实现逐字节一致
          const o = (theme && theme.weOptions) || null;
          const sceneFps = o && Number.isFinite(Number(o.sceneFps)) ? Math.min(120, Math.max(1, Math.round(Number(o.sceneFps)))) : 30;
          const muted = o && o.muted === false ? 'false' : 'true';
          const fit = o && ['cover', 'contain', 'fill'].indexOf(String(o.fit)) >= 0 ? String(o.fit) : 'cover';
          const mediaBase = 'http://127.0.0.1:' + port + '/wallpaper-engine/scene-files';
          bgSceneUrl = 'http://127.0.0.1:' + port + '/wallpaper-engine/scene-live/index.html?type=scene&src=' + encodeURIComponent(weTok) + '&mediaBase=' + encodeURIComponent(mediaBase) + '&fit=' + fit + '&sceneFps=' + sceneFps + '&muted=' + muted + '&r=' + daemonBoot;
          bgCssStr = bgHead + ' !important;}' + bgTail + 'html' + X + ',body' + X + '{background:transparent !important}';
        } else {
          const buf = fs.readFileSync(imgPath);
          const mime = imgExt2 === '.png' ? 'image/png' : imgExt2 === '.webp' ? 'image/webp' : 'image/jpeg';
          const dataUrl = 'data:' + mime + ';base64,' + buf.toString('base64');
          bgCssStr = bgHead + ',url(' + dataUrl + ') right center / cover no-repeat fixed !important;}' + bgTail;
        }
      }
    } catch (e) {
      // 与原内联实现一致：背景失败仅记日志，主题其余部分照常应用
      if (typeof p.log === 'function') p.log('[theme] 背景图加载失败: ' + e.message);
    }
  }
  return { bgCssStr, bgVideoUrl, bgSceneUrl };
}

module.exports = { resolveBackgroundAssets, readMask, resolveBackgroundPath };
