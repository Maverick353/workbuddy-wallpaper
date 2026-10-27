// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
/**
 * proc.js · 「这个 pid 到底是不是我们的进程」（零依赖，Windows + POSIX）
 * ------------------------------------------------------------------
 * 为什么需要它：**操作系统会回收 pid**。
 *
 * 2026-10-20 事故：看门狗死时占用 pid 4316，Windows 把 4316 回收给了 `svchost.exe`。
 * 而当时全仓的存活判定都只做 `pidAlive()`（"这个 pid 上有没有进程"），于是：
 *   · 单实例锁永久失效 —— 之后每次启动（含每次登录自启）都判「已有实例在跑」，**壁纸静默停机两天**；
 *   · `--stop-watchdog` 会 `taskkill /F /PID 4316` —— **那是在杀 svchost**。
 *
 * 结论（写进执行纪律）：**凡是拿 pid 判断"它是不是我们的东西"，都必须过这里。**
 * 注意 `nodePidAlive()` 也只是"更安全"，不是"绝对正确" —— 这台机器上 node 进程有十来个，
 * pid 完全可能被回收给另一个 node。所以对**有端口的服务**要额外以端口为准（见 companion.js）。
 *
 * ⚠️ 跨平台：CI 同时跑 ubuntu 与 windows。第一版只写了 `tasklist`，
 *    在 Linux 上 `imageName()` 恒为 null → 连带"更新单飞锁"判定失效（CI 直接红四条）。
 *    现在 Windows 走 `tasklist`，POSIX 走 `/proc/<pid>/comm` 再回退 `ps -o comm=`。
 *
 * 详见 `docs/plan/修复计划-进程存活判定.md` 的 D2/D3/D4。
 */
const fs = require('fs');
const { spawnSync } = require('child_process');

const IS_WIN = process.platform === 'win32';

function tasklistOut(args) {
  const r = spawnSync('tasklist', args, { windowsHide: true, encoding: 'buffer' });
  if (r.status !== 0) return '';
  return (r.stdout || Buffer.alloc(0)).toString();
}

/** 这个 pid 上有没有进程（**不保证是我们的**）。 */
function pidAlive(pid) {
  if (!pid || pid <= 0) return false;
  if (!IS_WIN) {
    // POSIX：信号 0 只做存在性/权限探测，不真的发信号。
    // EPERM = 进程存在但无权向它发信号 → 仍然算"活着"。
    try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
  }
  const out = tasklistOut(['/FI', 'PID eq ' + pid, '/NH']);
  return out.indexOf(String(pid)) >= 0;   // 无匹配时只打印本地化 INFO 行（不含 PID 数字）
}

/** 取映像名（小写，不含路径）；查不到返回 null。 */
function imageName(pid) {
  if (!pid || pid <= 0) return null;

  if (IS_WIN) {
    const out = tasklistOut(['/FI', 'PID eq ' + pid, '/NH', '/FO', 'CSV']);
    const lines = String(out || '').split(/\r?\n/).filter((l) => l.trim());
    for (const line of lines) {
      const m = line.match(/^"([^"]+)","(\d+)"/);
      if (m && Number(m[2]) === Number(pid)) return m[1].toLowerCase();
    }
    return null;                          // 无匹配时只有一行本地化 INFO
  }

  // Linux：优先 `/proc/<pid>/exe`（可执行文件本身，**不受线程名改写影响**）。
  // 为什么不用 comm 打头：comm 是"线程名"，进程可以自己改名（Node 在某些平台/版本上
  // 主线程 comm 并非 `node`）—— 2026-10-20 CI 就是靠这条线索才把"自身判活"修对。
  try {
    const exe = fs.readlinkSync('/proc/' + pid + '/exe');
    const base = String(exe).replace(/\s*\(deleted\)\s*$/, '').split('/').pop();
    if (base) return base.toLowerCase();
  } catch (_) {}
  // 其次 comm（简单、总能读）
  try {
    const s = fs.readFileSync('/proc/' + pid + '/comm', 'utf8').trim();
    if (s) return s.toLowerCase();
  } catch (_) {}
  // 回退（macOS 等没有 /proc 的系统）：ps -o comm=
  try {
    const r = spawnSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' });
    if (r.status === 0) {
      const name = String(r.stdout || '').trim().split(/\r?\n/)[0].split('/').pop();
      if (name) return name.toLowerCase();
    }
  } catch (_) {}
  return null;
}

/**
 * 这个 pid 是不是"我们自己这类进程"（node）。
 * 查不到映像名时**保守返回 true** —— 宁可少起一个实例，也不要重复起。
 */
function nodePidAlive(pid) {
  if (!pidAlive(pid)) return false;
  const img = imageName(pid);
  if (img === null) return true;
  if (IS_WIN) return img === 'node.exe';
  // POSIX：`node` / `nodejs`（Debian 历史命名）/ `node22` 这类带版本后缀的也认
  return /^node(js)?[\d._-]*$/.test(img);
}

module.exports = { pidAlive, imageName, nodePidAlive, IS_WIN };
