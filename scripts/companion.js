#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
/**
 * companion.js · 壁纸服务看门（与 WorkBuddy 同生共死）
 * ------------------------------------------------------------------
 * 管什么：让独立壁纸服务（scripts/start-ui.js）跟着 WorkBuddy 的生命周期走 ——
 *   · WorkBuddy 在跑且服务没在跑 → 自动起服务（spawn start-ui.js）
 *   · WorkBuddy 没了 → 自动停服务（按 .ui.pid taskkill；页面已不存在，无需 CDP 卸载）
 *   服务自己崩了（WorkBuddy 还在）→ 下个 tick 自然重启（幂等）
 *
 * 怎么跑：
 *   node scripts/companion.js                    # 看门常驻（5s 一 tick）
 *   node scripts/companion.js --status           # 四行诊断后退出
 *   node scripts/companion.js --stop-service     # 手动停服务
 *   node scripts/companion.js --install-autostart    # 写开机启动项（隐藏窗口 vbs）
 *   node scripts/companion.js --uninstall-autostart  # 删开机启动项
 *
 * 日志：<数据目录>/companion.log（ISO 时间戳，同时打 console）。
 *   数据目录 = require('./server.js').dataDir()（Windows: %APPDATA%/workbuddy-wallpaper）。
 *
 * 怎么卸：
 *   ① node scripts/companion.js --uninstall-autostart（删开机启动项）
 *   ② 删 <数据目录>/.companion.lock（单实例锁；看门退出时会自己清理）
 *   ③ taskkill /F /PID <companion pid>（看门进程；服务会由下一个看门或手动管）
 *
 * 韧性：tick 整体 try/catch + uncaughtException 只记录不退出（与 start-ui 同模式）；
 *   起服务失败退避 30s，杜绝重启风暴；WorkBuddy 状态连续 2 次读数一致才动作（防抖 ~10s）。
 *   自检三件套（2026-10-13 收尾补齐）：① 日志按 1MB 轮转（companion.log.1），不会无限增长；
 *   ② pid 活着但端口连续 4 tick 不通 ⇒ 判「假死」强杀重起；③ 每 60 tick（≈5min）打心跳。
 * 单实例：<数据目录>/.companion.lock 写自己 PID；已存活 → 打印并 exit 0。
 * 平台：仅 Windows（依赖 tasklist / taskkill / netstat）。
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const { dataDir } = require('./server.js');

// Node 版本自检（P0）：见 scripts/resolve-node.js 顶部说明。
if (!require('./resolve-node.js').assertNodeOk('壁纸看门狗')) process.exit(1);

const DIR = dataDir();
const PID_FILE = path.join(DIR, '.ui.pid');            // start-ui 启停时维护
const LOCK_FILE = path.join(DIR, '.companion.lock');   // 本脚本单实例锁
const LOG_FILE = path.join(DIR, 'companion.log');
const START_UI = path.join(__dirname, 'start-ui.js');
const SELF = path.resolve(__filename);               // 本脚本绝对路径（vbs 启动项用）
const VBS_NAME = 'wallpaper-companion.vbs';
const DEFAULT_PORT = 47851;          // start-ui 的默认端口（--status 诊断用）
const TICK_MS = 5000;                // 看门周期
const CONFIRM_TICKS = 2;             // 防抖：连续两次读数一致才动作（≈10s）
const START_CONFIRM_MS = 3000;       // 起服务后等 .ui.pid 出现的确认时长
const START_BACKOFF_MS = 30000;      // 起失败退避时长（防快速重启风暴）
const PORT_DOWN_LIMIT = 4;           // pid 活着但端口不通连续 N tick → 判假死重起（≈20s）
const HEARTBEAT_TICKS = 60;          // 每 N tick 打一次心跳（≈5min，证明看门还活着）
const LOG_MAX_BYTES = 1024 * 1024;   // 日志轮转阈值（1MB）
const LOG_KEEP = 1;                  // 保留的滚动份数（companion.log.1）
const CDP_PORT = 9222;               // 宿主调试端口（--status 诊断用）

/** 日志轮转：超过 LOG_MAX_BYTES 就把当前日志滚成 .1（保留 LOG_KEEP 份），防无限增长。 */
function rotateIfNeeded() {
  try {
    if (fs.statSync(LOG_FILE).size < LOG_MAX_BYTES) return;
    for (let i = LOG_KEEP; i > 1; i--) {
      const from = LOG_FILE + '.' + (i - 1), to = LOG_FILE + '.' + i;
      if (fs.existsSync(from)) { try { fs.renameSync(from, to); } catch (_) {} }
    }
    fs.renameSync(LOG_FILE, LOG_FILE + '.1');
  } catch (_) {}
}

/** 日志：ISO 时间戳 append 到 companion.log（带轮转），同时打 console。 */
function log(...a) {
  const line = new Date().toISOString() + ' [companion] ' + a.join(' ') + '\n';
  rotateIfNeeded();
  try { fs.appendFileSync(LOG_FILE, line); } catch (_) {}
  process.stdout.write(line);
}

/** 同步 sleep（零依赖；仅用于起服务后的 3s 确认等待）。 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** tasklist 输出（buffer → 字符串；进程名/PID 均为 ASCII，本地化表头无碍）。 */
function tasklistOut(args) {
  const r = spawnSync('tasklist', args, { windowsHide: true, encoding: 'buffer' });
  if (r.status !== 0) return '';
  return (r.stdout || Buffer.alloc(0)).toString();
}

/** WorkBuddy 是否在跑（返回存活 pid 数组；空 = 没跑）。 */
function workbuddyPids() {
  const out = tasklistOut(['/FI', 'IMAGENAME eq WorkBuddy.exe', '/NH']);
  const pids = [];
  out.split(/\r?\n/).forEach((line) => {
    if (line.indexOf('WorkBuddy.exe') < 0) return;
    const m = /(\d+)/.exec(line);   // 行内首个数字串即 PID（映像名无数字）
    if (m) pids.push(Number(m[1]));
  });
  return pids;
}

/** 某 PID 是否活着（tasklist /FI "PID eq x" 有匹配行）。 */
function pidAlive(pid) {
  if (!pid || pid <= 0) return false;
  const out = tasklistOut(['/FI', 'PID eq ' + pid, '/NH']);
  return out.indexOf(String(pid)) >= 0;   // 无匹配时只打印本地化 INFO 行（不含 PID 数字）
}

/** 读 .ui.pid（无效/缺失返回 null）。 */
function readPidFile() {
  try {
    const v = Number((fs.readFileSync(PID_FILE, 'utf8') || '').trim());
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch (_) { return null; }
}

function removePidFile() { try { fs.unlinkSync(PID_FILE); } catch (_) {} }

/**
 * 回写 .ui.pid。
 * 用途：端口上已经有活服务、但 pid 文件丢了（被手工删掉 / 写盘失败）时**复用**它，
 * 而不是再 spawn 一个（那会因端口占用起不来，陷入「每 30s 失败一次」的空转）。
 */
function writePidFile(pid) {
  try { fs.writeFileSync(PID_FILE, String(pid)); return true; } catch (_) { return false; }
}

/** netstat -ano 输出（一次调用供多处端口判定复用）。 */
function netstatOut() {
  const r = spawnSync('netstat', ['-ano'], { windowsHide: true, encoding: 'buffer' });
  return r.status === 0 ? (r.stdout || Buffer.alloc(0)).toString() : '';
}

/** 从 netstat 输出里取 127.0.0.1:<port> 的 LISTENING pid（无则 0）。 */
function listenPid(out, port) {
  const m = new RegExp('127\\.0\\.0\\.1:' + port + '\\s+\\S+\\s+LISTENING\\s+(\\d+)').exec(out);
  return m ? Number(m[1]) : 0;
}

/** 127.0.0.1:<port> 是否 LISTENING。 */
function portListening(port) {
  const pid = listenPid(netstatOut(), port);
  return { listening: pid > 0, pid };
}

/** 停服务：taskkill /F /T（杀进程树）；pid 文件失效则清理。reason 仅用于日志措辞。 */
function stopService(reason) {
  const pid = readPidFile();
  if (!pid) return false;
  const r = spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, encoding: 'buffer' });
  if (r.status === 0) {
    log(reason + ' → 已停止壁纸服务 (pid=' + pid + ')');
    removePidFile();
    return true;
  }
  if (!pidAlive(pid)) {
    log('服务进程已不在 (pid=' + pid + ') → 清理失效 pid 文件');
    removePidFile();
    return true;
  }
  log('停止服务失败 (pid=' + pid + '): taskkill 退出码 ' + r.status);
  return false;
}

/** 起服务（detached，脱离看门进程树；失败由调用方退避）。 */
function spawnService() {
  const child = spawn(process.execPath, [START_UI], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', (e) => log('spawn start-ui 出错: ' + e.message));
  child.unref();
  return child;
}

// ── CLI 子命令 ─────────────────────────────────────────────────────────────
function statusCmd() {
  const wb = workbuddyPids();
  const pid = readPidFile();
  const alive = !!(pid && pidAlive(pid));
  const ns = netstatOut();
  const svcPid = listenPid(ns, DEFAULT_PORT);
  const cdpPid = listenPid(ns, CDP_PORT);
  process.stdout.write('[companion] WorkBuddy: ' + (wb.length ? '运行中 (pid ' + wb.join(', ') + ')' : '未运行') + '\n');
  process.stdout.write('[companion] 壁纸服务: ' + (alive ? 'pid ' + pid + ' 存活' : '未运行（.ui.pid ' + (pid ? '指向的进程已死' : '缺失') + '）') + '\n');
  process.stdout.write('[companion] ' + DEFAULT_PORT + ': ' + (svcPid ? 'LISTENING (pid ' + svcPid + ')' : '未监听') + '\n');
  const cdpOk = cdpPid > 0;
  process.stdout.write('[companion] CDP ' + CDP_PORT + ': ' + (cdpOk ? 'LISTENING（可注入 UI）' : '未监听 —— UI 注入不可用') + '\n');
  // ⚠️ 2026-10-14 修正（P1「死路文案」）：旧版这里写「请在 WorkDaddy 状态页点『一键恢复』」——
  //    那是父项目 WorkDaddy 的界面，**本技能根本没有这个页面/按钮**，用户照着做必然找不到、彻底卡死。
  //    现在改成自指的、可真正执行的指引，并把「下一步该做什么」直接说出来。
  if (!cdpOk) {
    process.stdout.write('\n下一步：让 WorkBuddy 带上调试端口启动 ——\n');
    if (fs.existsSync(path.join(__dirname, 'fix-shortcut.js'))) {
      process.stdout.write('  · 自动：' + 'node scripts/fix-shortcut.js' + '   （改快捷方式；改前会先说明并等你回车）\n');
    }
    process.stdout.write('  · 手动：WorkBuddy 快捷方式 → 右键属性 → 「目标」末尾加一个空格，再加\n');
    process.stdout.write('          --remote-debugging-port=' + CDP_PORT + '\n');
    process.stdout.write('  改完必须**完全退出 WorkBuddy、再用该快捷方式重新打开**\n');
    process.stdout.write('  （Electron 单实例：应用已在运行时再点快捷方式，新参数会被旧实例忽略）\n');
  }
  process.exit(0);
}

function stopServiceCmd() {
  if (!readPidFile()) { log('--stop-service：无 .ui.pid，服务未在运行'); process.exit(0); }
  stopService('手动 --stop-service');
  process.exit(0);
}

function startupDir() {
  return path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

function installAutostartCmd() {
  const dir = startupDir();
  if (!fs.existsSync(dir)) { log('--install-autostart：启动文件夹不存在: ' + dir); process.exit(1); }
  const vbs = path.join(dir, VBS_NAME);
  // 隐藏窗口启动（mode 0）；路径带空格 → VBS 里用三引号转义。
  //
  // ⚠️ 2026-10-14 重要修正（P0）：旧版把 install 时的 process.execPath 与仓库绝对路径**冻结**写进 vbs。
  //    实测本机 10 天内 WorkBuddy 把自带 node 从 22.22.2-3 换到 -5、再到 -6（旧目录从磁盘删除）
  //    → 冻结的路径必然失效，而 vbs 没有控制台、没有日志 → **开机自启静默死亡**，用户只会觉得"壁纸又没了"。
  //    现在改成**登录时才解析**：node 走「宿主版本索引 versions\current → 任一版本目录 → PATH」，
  //    项目路径走「记录路径 → 已安装技能目录」；全部失败就写日志 + 弹一次提示（绝不静默）。
  //    内容保持**纯 ASCII**（.vbs 的编码坑：非 ASCII 在不同代码页下会乱码）。
  const vbsLines = [
    "' wallpaper-companion.vbs - generated by scripts/companion.js --install-autostart",
    "' Starts the wallpaper service watchdog at user login, hidden.",
    "' Resolves node.exe and companion.js AT LOGIN TIME - nothing is version-frozen,",
    "' so a host node upgrade (or a moved folder) no longer kills autostart silently.",
    "' Remove with: node scripts/companion.js --uninstall-autostart",
    'Option Explicit',
    'Dim fso, sh, homeDir, dataDir, logPath, stampPath, nodeExe, compScript, cands, c',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'Set sh  = CreateObject("WScript.Shell")',
    'homeDir = sh.ExpandEnvironmentStrings("%USERPROFILE%")',
    'dataDir = sh.ExpandEnvironmentStrings("%APPDATA%") & "\\workbuddy-wallpaper"',
    'logPath = dataDir & "\\autostart-error.log"',
    'stampPath = dataDir & "\\autostart-error.stamp"',
    '',
    "' 1) node.exe: host version index -> any version dir -> PATH",
    'nodeExe = ResolveNode(fso, sh, homeDir)',
    '',
    "' 2) companion.js: recorded path -> installed-skill path",
    'compScript = ""',
    'cands = Array("' + String(SELF).replace(/"/g, '""') + '", homeDir & "\\.workbuddy\\skills\\workbuddy-wallpaper\\scripts\\companion.js")',
    'For Each c In cands',
    '  If compScript = "" Then',
    '    If fso.FileExists(c) Then compScript = c',
    '  End If',
    'Next',
    '',
    'If nodeExe = "" Or compScript = "" Then',
    '  ReportFailure fso, logPath, stampPath, nodeExe, compScript',
    '  WScript.Quit 1',
    'End If',
    'sh.Run """" & nodeExe & """ """ & compScript & """", 0, False',
    '',
    'Function ResolveNode(fso, sh, homeDir)',
    '  Dim root, v, sd, parts, p',
    '  ResolveNode = ""',
    '  root = homeDir & "\\.workbuddy\\binaries\\node\\versions"',
    '  If fso.FileExists(root & "\\current") Then',
    '    On Error Resume Next',
    '    v = Trim(fso.OpenTextFile(root & "\\current", 1).ReadAll())',
    '    On Error GoTo 0',
    '    If Len(v) > 0 Then',
    '      If fso.FileExists(root & "\\" & v & "\\node.exe") Then ResolveNode = root & "\\" & v & "\\node.exe"',
    '    End If',
    '  End If',
    '  If ResolveNode = "" Then',
    '    If fso.FolderExists(root) Then',
    '      For Each sd In fso.GetFolder(root).SubFolders',
    '        If fso.FileExists(sd.Path & "\\node.exe") Then ResolveNode = sd.Path & "\\node.exe"',
    '      Next',
    '    End If',
    '  End If',
    '  If ResolveNode = "" Then',
    '    parts = Split(sh.ExpandEnvironmentStrings("%PATH%"), ";")',
    '    For Each p In parts',
    '      If ResolveNode = "" Then',
    '        If fso.FileExists(p & "\\node.exe") Then ResolveNode = p & "\\node.exe"',
    '      End If',
    '    Next',
    '  End If',
    'End Function',
    '',
    'Sub ReportFailure(fso, logPath, stampPath, nodeExe, compScript)',
    '  Dim f, ageH',
    '  On Error Resume Next',
    '  Set f = fso.OpenTextFile(logPath, 8, True, -1)',
    '  f.WriteLine "[" & Now & "] autostart FAILED"',
    '  f.WriteLine "  node       : " & nodeExe',
    '  f.WriteLine "  companion  : " & compScript',
    '  f.WriteLine "  fix        : re-run the installer: node scripts\\install.js"',
    '  f.WriteLine "               or re-download: github.com/Maverick353/workbuddy-wallpaper/releases"',
    '  f.Close',
    "' popup at most once per 24h (log is always written)",
    '  ageH = 999',
    '  If fso.FileExists(stampPath) Then ageH = DateDiff("h", fso.GetFile(stampPath).DateLastModified, Now)',
    '  If ageH >= 24 Then',
    '    Set f = fso.CreateTextFile(stampPath, True)',
    '    f.WriteLine Now',
    '    f.Close',
    '    MsgBox "WorkBuddy wallpaper: autostart failed." & vbCrLf & vbCrLf & _',
    '      "Details: " & logPath & vbCrLf & vbCrLf & _',
    '      "Fix: open the project folder and run  node scripts\\install.js  again.", 48, "WorkBuddy Wallpaper"',
    '  End If',
    'End Sub',
  ];
  const content = vbsLines.join('\r\n') + '\r\n';
  const same = fs.existsSync(vbs) && fs.readFileSync(vbs, 'utf8') === content;
  try {
    fs.writeFileSync(vbs, content, 'utf8');
  } catch (e) {
    // 写启动文件夹失败（受控文件夹访问/杀软）—— 别再抛堆栈给用户看
    log('--install-autostart：写入失败：' + e.message);
    log('  目标：' + vbs);
    log('  可能被「受控文件夹访问」或杀软拦截。可换用管理员终端重跑本命令。');
    process.exit(1);
  }
  log('--install-autostart：' + (same ? '开机启动项已存在且内容一致（幂等）' : '已写入开机启动项（登录时动态解析 node，不会随宿主升级失效）') + ': ' + vbs);
  process.exit(0);
}

/** 停看门狗：卸载时必须调用，否则它下个 tick 会一直尝试从已删目录拉起服务。 */
function stopWatchdogCmd() {
  const pid = (() => { try { return Number((fs.readFileSync(LOCK_FILE, 'utf8') || '').trim()) || 0; } catch (_) { return 0; } })();
  if (!pid) { log('--stop-watchdog：没有 .companion.lock（看门狗未在运行）'); process.exit(0); }
  if (pid === process.pid) { log('--stop-watchdog：锁指向的就是本进程，跳过'); process.exit(0); }
  if (!pidAlive(pid)) {
    try { fs.unlinkSync(LOCK_FILE); } catch (_) {}
    log('--stop-watchdog：锁里的进程 ' + pid + ' 已不在 → 清理残留锁');
    process.exit(0);
  }
  const r = spawnSync('taskkill', ['/F', '/PID', String(pid)], { windowsHide: true, encoding: 'buffer' });
  if (r.status === 0) {
    try { fs.unlinkSync(LOCK_FILE); } catch (_) {}
    log('--stop-watchdog：已停止看门狗 (pid=' + pid + ')');
  } else {
    log('--stop-watchdog：停止失败 (pid=' + pid + ')，可手动 taskkill /F /PID ' + pid);
  }
  process.exit(0);
}

function uninstallAutostartCmd() {
  const vbs = path.join(startupDir(), VBS_NAME);
  if (!fs.existsSync(vbs)) { log('--uninstall-autostart：开机启动项不存在（无需删除）: ' + vbs); process.exit(0); }
  try { fs.unlinkSync(vbs); log('--uninstall-autostart：已删除开机启动项: ' + vbs); }
  catch (e) { log('--uninstall-autostart：删除失败: ' + e.message); process.exit(1); }
  process.exit(0);
}

function usageCmd() {
  process.stdout.write(
    'companion.js · 壁纸服务看门\n' +
    '  node scripts/companion.js                     看门常驻（WorkBuddy 在→服务在）\n' +
    '  node scripts/companion.js --status            四行诊断（WorkBuddy/服务/端口/CDP）\n' +
    '  node scripts/companion.js --stop-service      手动停服务\n' +
    '  node scripts/companion.js --stop-watchdog     停掉常驻的看门狗\n' +
    '  node scripts/companion.js --install-autostart 开机自启（隐藏 vbs，登录时动态解析）\n' +
    '  node scripts/companion.js --uninstall-autostart 取消开机自启\n'
  );
  process.exit(0);
}

// ── 单实例锁 ───────────────────────────────────────────────────────────────
function releaseLock() {
  try { if ((fs.readFileSync(LOCK_FILE, 'utf8') || '').trim() === String(process.pid)) fs.unlinkSync(LOCK_FILE); } catch (_) {}
}

function acquireLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const old = Number((fs.readFileSync(LOCK_FILE, 'utf8') || '').trim());
      if (old && old !== process.pid && pidAlive(old)) return false;   // 已有一个看门在跑
      log('发现失效/残留 lock（pid=' + old + '）→ 接管');
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid));
    return true;
  } catch (e) {
    log('lock 读写失败: ' + e.message);
    return false;
  }
}

// ── 看门主循环 ─────────────────────────────────────────────────────────────
let wbState = null;      // 已确认的 WorkBuddy 状态（null=未确认过）
let wbPending = null;    // 上次 tick 读数（待确认 → 防抖）
let backoffUntil = 0;    // 起服务失败退避截止（ms 时间戳）
let tickCount = 0;       // tick 计数（心跳节拍）
let portDownStreak = 0;  // pid 活着但端口不通的连续 tick 数（假死判定）

function ensureService() {
  const pid = readPidFile();
  if (pid && pidAlive(pid)) {
    // 自检：进程活着 ≠ 服务可用。端口连续 PORT_DOWN_LIMIT 个 tick 不通 ⇒ 判假死，强杀重起。
    if (portListening(DEFAULT_PORT).listening) { portDownStreak = 0; backoffUntil = 0; return; }
    portDownStreak++;
    log('服务 pid=' + pid + ' 存活但 ' + DEFAULT_PORT + ' 未监听（' + portDownStreak + '/' + PORT_DOWN_LIMIT + '）');
    if (portDownStreak < PORT_DOWN_LIMIT) return;
    log('判定服务假死 → 强制重启');
    try { spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, encoding: 'buffer' }); } catch (_) {}
    removePidFile();
    portDownStreak = 0;
  } else {
    portDownStreak = 0;
    // ⚠️ pid 文件缺失/失效 ≠ 服务真的没跑：端口可能仍被一个**活着的**服务占着
    //    （`.ui.pid` 被手工删掉、写盘失败、或 pid 被复用都会这样）。
    //    此时若直接 spawn，新进程会因端口占用起不来 → 每 30s 失败一次空转，而旧服务一直在正常干活。
    //    **先探端口，能复用就复用**：回写 pid 文件即恢复判断。
    const live = portListening(DEFAULT_PORT);
    if (live.listening) {
      const ok = writePidFile(live.pid);
      log('检测到 ' + DEFAULT_PORT + ' 上已有服务在跑 (pid=' + live.pid + ') → 复用' +
          (ok ? '并回写 .ui.pid' : '（pid 文件回写失败，仅本次跳过重启）'));
      backoffUntil = 0;
      return;
    }
  }
  if (Date.now() < backoffUntil) return;                       // 退避中，不重启风暴
  // 用户主动关闭过（面板「关闭壁纸」→ 服务写 .stopped）：不自动拉起，
  // 直到用户删 .stopped 或手动跑 start-ui（start-ui 启动时会清掉它）。
  const stopped = path.join(DIR, '.stopped');
  try { if (fs.existsSync(stopped)) return; } catch (_) {}
  log('WorkBuddy 在跑、壁纸服务未运行 → 启动服务（spawn ' + path.basename(START_UI) + '）');
  try { spawnService(); } catch (e) { log('spawn 失败: ' + e.message); }
  sleepSync(START_CONFIRM_MS);                                 // 等 .ui.pid 落盘
  const pid2 = readPidFile();
  if (pid2 && pidAlive(pid2)) {
    log('服务已就绪 (pid=' + pid2 + ', http://127.0.0.1:' + DEFAULT_PORT + ')');
    backoffUntil = 0;
  } else {
    log('服务启动失败（' + START_CONFIRM_MS / 1000 + 's 内 .ui.pid 未就绪，如端口占用）→ 退避 ' + START_BACKOFF_MS / 1000 + 's');
    backoffUntil = Date.now() + START_BACKOFF_MS;
  }
}

function tick() {
  try {
    const wb = workbuddyPids().length > 0;
    if (wb !== wbPending) { wbPending = wb; return; }          // 读数翻转：等下一 tick 确认（防抖）
    if (wb !== wbState) {
      const first = wbState === null;
      wbState = wb;
      log(first ? ('看门首次确认：WorkBuddy ' + (wb ? '在运行' : '未运行'))
        : (wb ? '检测到 WorkBuddy 已启动' : '检测到 WorkBuddy 已关闭'));
    }
    if (wbState) ensureService();
    else stopService('WorkBuddy 已关闭');

    // 心跳：周期性证明「看门还活着」，也是排查时判断看门是否早死的唯一可靠依据。
    tickCount++;
    if (tickCount % HEARTBEAT_TICKS === 0) {
      const pid = readPidFile();
      log('心跳：看门存活（tick=' + tickCount + '）｜WorkBuddy ' + (wbState ? '在运行' : '未运行') +
        '｜服务 ' + (pid && pidAlive(pid) ? 'pid ' + pid : '未运行'));
    }
  } catch (e) {
    log('tick 异常（已忽略，看门继续）：' + ((e && e.message) || e));
  }
}

function main() {
  if (process.platform !== 'win32') {
    process.stderr.write('[companion] 仅支持 Windows（依赖 tasklist/taskkill/netstat）\n');
    process.exit(1);
  }
  const mode = process.argv[2] || '';
  if (mode === '--status') return statusCmd();
  if (mode === '--stop-service') return stopServiceCmd();
  if (mode === '--stop-watchdog') return stopWatchdogCmd();
  if (mode === '--install-autostart') return installAutostartCmd();
  if (mode === '--uninstall-autostart') return uninstallAutostartCmd();
  if (mode === '--help' || mode === '-h') return usageCmd();
  if (mode) { log('未知参数: ' + mode); return usageCmd(); }

  // ── 看门常驻模式 ──
  try { fs.mkdirSync(DIR, { recursive: true }); } catch (_) {}
  if (!acquireLock()) {
    const old = Number((fs.readFileSync(LOCK_FILE, 'utf8') || '').trim());
    process.stdout.write('[companion] companion 已在运行 (pid=' + old + ')，退出\n');
    log('检测到已在运行的 companion (pid=' + old + ') → 放弃启动');
    process.exit(0);
  }
  // 兜底（与头注释的韧性声明一致）：看门进程绝不允许静默死亡 —— 任何未捕获异常只记录。
  // tick 自身有 try/catch，这里兜住 tick 之外（observer/信号处理等）的漏网异常。
  process.on('uncaughtException', (e) => {
    try { log('未捕获异常（已记录，看门继续运行）：' + ((e && e.stack) || e)); } catch (_) {}
  });
  process.on('unhandledRejection', (e) => {
    try { log('未处理的 Promise 拒绝（已记录，看门继续运行）：' + ((e && e.stack) || e)); } catch (_) {}
  });
  process.on('SIGINT', () => { releaseLock(); process.exit(0); });
  process.on('SIGTERM', () => { releaseLock(); process.exit(0); });
  log('看门已启动 (pid=' + process.pid + ', tick=' + TICK_MS / 1000 + 's, log=' + LOG_FILE + ')');
  tick();
  setInterval(tick, TICK_MS);
}

main();
