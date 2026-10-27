#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
/**
 * start-ui.js · 一键启动：独立壁纸服务 + 把壁纸 UI 注入宿主页面
 * ------------------------------------------------------------------
 * 做三件事（全部自包含，不依赖 WorkDaddy 的任何文件或进程）：
 *   ① 起零依赖壁纸服务（本目录 server/standalone.js，独立端口 + 独立数据目录）
 *   ② 自探测 CDP（9222 起依次试），把「拉绳 buddy + 六页签面板」注入页面
 *   ③ 常驻并自愈：页面重载后自动补注入（默认每 15s 检查一次；ws 断线立即重连）
 *
 * 与宿主的关系：只通过 CDP 注入 wdw-* 命名空间的 UI 与背景层；不写宿主任何文件。
 * 应用壁纸：面板里点某张壁纸 → 服务端落盘 → 这里调 CDP 把背景真正铺到页面上。
 *
 * 进程韧性（2026-10 修复「服务跑约 1 小时会死、死后面板全废」）：
 *   · 服务一旦监听成功，任何异步异常（CDP 断线回调、自愈轮询、请求处理里的
 *     未捕获错误）都只记录、不退出进程 —— 服务端口必须常驻；
 *   · ws 断线（宿主页面 reload 等）不再让 pend 请求悬挂：cdp.js 会立刻 reject
 *     并回调 onClose → 这里主动重连补注入（不等 15s 轮询）；
 *   · 重连失败自动重试若干轮，轮询作为兜底；注入失败不影响 HTTP API 可用性。
 *
 *   node scripts/start-ui.js                      # 前台常驻（Ctrl+C 停止并卸载）
 *   node scripts/start-ui.js --port 47851 --data-dir "D:/wp"
 *   node scripts/start-ui.js --no-inject          # 只起服务（供其它程序调用 API）
 *   node scripts/start-ui.js --no-watch           # 注入一次后仍常驻但不自愈
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { start, parseArgs } = require(path.join(ROOT, 'server', 'standalone.js'));
const { dataDir, seedWallpapers } = require('./server.js');
const dshUI = require(path.join(ROOT, 'ui', 'dsh-ui', 'index.js'));
const bg = require(path.join(ROOT, 'ui', 'background.js'));
const core = require(path.join(ROOT, 'core', 'index.js'));

// Node 版本自检（P0）：cdp.js 依赖 Node 22 才有的全局 WebSocket。
// 低版本下的表现是"服务正常在跑、界面永远不上屏"——最难查的静默失败，所以进门前就拦掉。
if (!require('./resolve-node.js').assertNodeOk('壁纸服务')) process.exit(1);

const BOOT = Date.now();
const log = (...a) => process.stdout.write('[start-ui] ' + a.join(' ') + '\n');

// ── 进程级兜底（最早注册）──────────────────────────────────────────────────
// 自愈轮询 / CDP 断线回调 / HTTP 请求处理里的任何异步异常都不得杀死进程：
// 服务端口 47851 常驻是本技能的生命线，页面 UI 丢了可以靠重连补回来。
// 唯一的进程死亡路径保留给「启动阶段服务没起来」（见 IIFE catch 的 serviceUp）。
process.on('unhandledRejection', (e) => {
  log('未处理的 Promise 拒绝（已忽略，服务继续运行）：' + ((e && e.message) || e));
});
process.on('uncaughtException', (e) => {
  // 只记录不退出：请求处理等场景的同步抛错（如媒体文件被锁/删除）不应拖垮整个服务。
  log('未捕获异常（已记录，服务继续运行）：' + ((e && e.stack) || e));
});

// ── CDP（零依赖自探测；实现在 scripts/cdp.js，stop-ui 共用）─────────────────
const { CDP_CANDIDATES, findCdp, hostSession } = require('./cdp.js');

/** 服务是否已成功监听：true 之后本进程不再因任何异常退出。 */
let serviceUp = false;
/** 正在退出（SIGINT/SIGTERM）：停掉一切重连与轮询，安静卸载。 */
let shuttingDown = false;

/** 当前壁纸资产 → 背景注入表达式（应用壁纸时用）。 */
function buildBackgroundExpr(theme, id, port, dir) {
  const assets = core.themeCss.resolveBackgroundAssets({
    theme: theme || { id }, id, themesDir: path.join(dir, 'themes'), port, daemonBoot: BOOT, dataDir: dir, log,
  });
  return bg.backgroundExpression({ css: assets.bgCssStr, videoUrl: assets.bgVideoUrl, sceneUrl: assets.bgSceneUrl });
}

/** 读 current-theme.json 里的主题 id（启动时据此恢复上次壁纸）。 */
function readCurrentThemeId(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'current-theme.json'), 'utf8'));
    return (j && (j.id || j.theme || j.currentTheme)) || null;
  } catch (_) { return null; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 更新检查的「触发时机」之一：服务启动后延迟一次 + 之后每 N 小时一次。
 * 另外两条（面板打开时按需 / 用户手动点）走 HTTP 接口，不在这里。
 *
 * 三条不变量：
 *   ① **延迟启动**（默认 25s）—— 先让服务、注入、壁纸都跑完，绝不抢启动路径；
 *      只有静态站可拉，所以只能轮询；这四条触发叠加起来才是"准推送"。
 *   ② **绝不因为更新失败而影响服务**：全程 try/catch，失败只写一行日志。
 *   ③ `unref()` 定时器 —— 它不该阻止进程退出（stop-ui / Ctrl+C 要能干净退）。
 */
function startUpdateLoop(dir) {
  const upd = core.update;
  let cfg;
  try { cfg = upd.loadConfig({ dataDir: dir }); } catch (_) { return; }
  if (cfg.disabled) { log('更新检查已关闭（WBWP_UPDATE_OFF=1）'); return; }
  const ver = core.PLUGIN_VERSION || '';
  const run = async (tag) => {
    try {
      const r = await upd.checkForUpdate({ dataDir: dir, currentVersion: ver, force: false });
      if (!r.ok) { log('更新检查失败（' + tag + '）：' + (r.error || '未知原因')); return; }
      if (r.hasUpdate) {
        log('发现新版本 v' + r.latest + '（当前 v' + r.currentVersion + '）→ 面板「关于」页可一键更新');
      } else {
        log('已是最新版本 v' + r.currentVersion);
      }
      if (r.mustUpdate) log('⚠ 当前 v' + r.currentVersion + ' 低于最低支持版本 v' + r.minSupported + '，必须更新');
    } catch (e) {
      log('更新检查异常（' + tag + '）：' + ((e && e.message) || e));
    }
  };
  const delayMs = Math.max(1, Number(cfg.startupDelaySeconds || 25)) * 1000;
  const everyMs = Math.max(1, Number(cfg.checkIntervalHours || 6)) * 3600 * 1000;
  const t1 = setTimeout(() => { run('startup'); }, delayMs);
  const t2 = setInterval(() => { run('interval'); }, everyMs);
  if (t1.unref) t1.unref();
  if (t2.unref) t2.unref();
  log('更新检查已安排：启动后 ' + Math.round(delayMs / 1000) + 's 首次，之后每 ' +
    Math.round(everyMs / 3600000) + 'h 一次（主源 ' + (cfg.feeds[0] || '未配置') + '）');
}

(async () => {
  const rawArgs = process.argv.slice(2);
  const args = parseArgs(rawArgs);
  // 默认端口：`--port` > 环境变量 `WBWP_PORT` > 47851。
  // 为什么加环境变量：47851 被别的工具占住时（实测有过），用户没法改端口 ——
  // 而看门狗（companion.js）是按固定端口判活的，两边必须读**同一个来源**，否则永远判"服务没起来"。
  if (!rawArgs.includes('--port') && !rawArgs.includes('-p')) {
    args.port = Number(process.env.WBWP_PORT) || 47851;  // 本 skill 默认端口（避开其它工具）
  }
  const noInject = rawArgs.includes('--no-inject');
  const noWatch = rawArgs.includes('--no-watch');
  const dir = args.dataDir || dataDir();
  const seeded = seedWallpapers(dir);

  let session = null;
  let apiBase = '';
  let cdpPort = 0;

  // ── ① 服务（applyTheme 回调里直接注入背景层）────────────────────────────
  const started = await start({
    port: args.port,
    dataDir: dir,
    log: (m) => log('  [svc] ' + m),
    applyTheme: async (id) => {
      try {
        if (!session) return { ok: false, pending: true, id, warn: '宿主未连接，壁纸已保存' };
        const theme = core.store.readThemeJson({ dataDir: dir }, id);
        await session.ev(buildBackgroundExpr(theme, id, started.port, dir));
        log('已应用壁纸 → 宿主页面（theme=' + id + '）');
        return { ok: true, id };
      } catch (e) {
        return { ok: false, id, error: e.message };
      }
    },
  });
  serviceUp = true;   // 监听成功：此后进程对一切异常免疫（只记录，不退出）
  apiBase = 'http://127.0.0.1:' + started.port;
  // pid 文件：供 stop-ui.js 精确停掉本进程（数据目录内，与宿主无关）
  const pidFile = path.join(dir, '.ui.pid');
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(pidFile, String(process.pid)); } catch (_) {}
  // 手动启动 = 用户恢复意图：清掉「主动关闭」标志（companion 据此恢复自动看护）
  try { fs.unlinkSync(path.join(dir, '.stopped')); } catch (_) {}
  process.on('exit', () => { try { fs.unlinkSync(pidFile); } catch (_) {} });
  log('服务已启动 ' + apiBase + '（数据目录 ' + dir + '，种子 ' + seeded + ' 张）');

  // ── ①b 更新检查循环（不阻塞：延迟 + unref，失败只记日志）─────────────────
  startUpdateLoop(dir);

  if (noInject) { log('--no-inject：仅服务模式，Ctrl+C 退出。'); return; }

  // ── ② 注入（UI + 当前壁纸背景）──────────────────────────────────────────
  const cp = await findCdp();
  if (!cp) {
    log('未发现 CDP 端点（候选端口 ' + CDP_CANDIDATES.join('/') + '）。');
    log('宿主未开启远程调试时无法注入 UI —— 服务仍在运行，可直接调用 HTTP API。');
    log('提示：WorkBuddy 需以 --remote-debugging-port=9222 启动，否则界面注入不上。');
    return;
  }
  cdpPort = cp;

  // 断线即重连：ws close/error 时 cdp.js 同步回调（宿主页面 reload、target 销毁），
  // 防抖 800ms 后立即重连补注入 —— 不必等 15s 轮询。
  const hooks = { onClose: onSessionLost, onError: onSessionLost };
  let reconnecting = false;
  let reconnectTimer = null;

  function onSessionLost() {
    if (shuttingDown || reconnecting || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnectAndInject('CDP 连接断开');
    }, 800);
  }

  /** 重连并补注入：hostSession 重新拉 /json/list 找 page（reload 后 target 已重建），
   *  失败重试 3 轮（间隔 1.5s）；所有失败只记日志，绝不抛出未捕获异常。 */
  async function reconnectAndInject(reason) {
    if (reconnecting) return;
    reconnecting = true;
    try {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const { session: s2 } = await hostSession(cdpPort, hooks);
          session = s2;
          await injectAll();
          log(reason + ' → 已重连并补注入');
          return;
        } catch (e) {
          log(reason + ' → 重连失败（' + attempt + '/3）：' + ((e && e.message) || e));
          if (attempt < 3) await sleep(1500);
        }
      }
    } finally {
      reconnecting = false;
    }
  }

  const injectAll = async () => {
    if (!session) throw new Error('无 CDP 会话');
    await session.ev(dshUI.dshUIExpression({ apiBase, apiToken: started.apiToken }));
    const id = readCurrentThemeId(dir);
    if (id) {
      try { await session.ev(buildBackgroundExpr(core.store.readThemeJson({ dataDir: dir }, id), id, started.port, dir)); } catch (_) {}
    }
    return true;
  };

  // 首次连接/注入：失败不打死进程，转入同一套重连自愈（服务仍常驻）。
  try {
    const { session: s } = await hostSession(cdpPort, hooks);
    session = s;
    log('已连上宿主（CDP ' + cdpPort + '）');
    await injectAll();
    const st = await session.ev('JSON.stringify({rope:!!document.getElementById("wdw-rope-buddy"),panel:!!document.getElementById("wdw-wallpaper-panel"),yield:document.body.classList.contains("wdw-dsh-ui")})');
    log('注入完成：' + st);
    log('拉绳 buddy 已挂到页面顶部；点它打开面板（壁纸库 / 字体 / 系统 / 扩展 / 关于）');
    log('Ctrl+C 停止（会自动卸载页面 UI 并关闭服务）');
  } catch (e) {
    log('首次注入失败：' + ((e && e.message) || e) + ' —— 转入断线重连自愈');
    onSessionLost();
  }

  // ── ③ 自愈（页面重载后补注入）────────────────────────────────────────────
  if (!noWatch) {
    let polling = false;
    setInterval(async () => {
      if (polling || shuttingDown) return;   // 上一轮未结束则跳过本轮（防慢表达式叠加）
      polling = true;
      try {
        if (!session) throw new Error('无 CDP 会话');
        const has = await session.ev('!!document.getElementById("wdw-rope-buddy")');
        if (!has) { await injectAll(); log('检测到页面已重载 → 已补注入'); }
      } catch (_) {
        // ws 断线时 session.ev 会立刻 reject（cdp.js 断线语义）→ 走主动重连
        await reconnectAndInject('轮询发现 CDP 断线');
      } finally {
        polling = false;
      }
    }, 15000);
  }

  const bye = async () => {
    shuttingDown = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    const UI_UNINSTALL = '(function(){try{["wdw-rope-buddy","wdw-wallpaper-panel","wdw-dsh-ui-style","wdw-rope-buddy-style","wdw-panel-style","wdw-font-style"].forEach(function(id){var e=document.getElementById(id);if(e)e.remove();});try{document.body.classList.remove("wdw-dsh-ui");}catch(_){}try{localStorage.removeItem("wdw.ui.mode");}catch(_){}try{delete window.__wdwRopeBuddy;}catch(_){}try{delete window.__wdwPanel;}catch(_){}return "ok";}catch(e){return "err:"+e.message;}})()';
    try { await session.ev(UI_UNINSTALL); } catch (_) {}
    try { await session.ev(bg.backgroundUninstallExpression()); } catch (_) {}
    try { started.server.close(); } catch (_) {}
    log('已卸载页面 UI 与背景层，并停止服务');
    process.exit(0);
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
})().catch((e) => {
  log('启动流程失败：' + ((e && e.message) || e));
  if (!serviceUp) {
    // 服务都没起来：保留原有失败语义（退出码 1，stop-ui/看护进程可据此判断）
    process.exit(1);
  }
  // 服务已常驻：注入/自愈失败不影响 HTTP API，进程继续活着由轮询兜底恢复
  log('服务仍在运行（注入失败不影响 API 可用性）；CDP 自愈会继续尝试。');
});
