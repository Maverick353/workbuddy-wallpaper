// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
/**
 * proc.js · 「这个 pid 到底是不是我们的进程」（零依赖，仅 Windows）
 * ------------------------------------------------------------------
 * 为什么需要它：**Windows 会回收 pid**。
 *
 * 2026-10-20 事故：看门狗死时占用 pid 4316，系统把 4316 回收给了 `svchost.exe`。
 * 而当时全仓的存活判定都只做 `pidAlive()`（"这个 pid 上有没有进程"），于是：
 *   · 单实例锁永久失效 —— 之后每次启动（含每次登录自启）都判「已有实例在跑」，**壁纸静默停机两天**；
 *   · `--stop-watchdog` 会 `taskkill /F /PID 4316` —— **那是在杀 svchost**。
 *
 * 结论（写进执行纪律）：**凡是拿 pid 判断"它是不是我们的东西"，都必须过这里。**
 * 注意 `nodePidAlive()` 也只是"更安全"，不是"绝对正确" —— 这台机器上 node.exe 有十来个，
 * pid 完全可能被回收给另一个 node。所以对**有端口的服务**要额外以端口为准（见 companion.js）。
 *
 * 详见 `修复计划-进程存活判定.md` 的 D2/D3/D4。
 */
const { spawnSync } = require('child_process');

function tasklistOut(args) {
  const r = spawnSync('tasklist', args, { windowsHide: true, encoding: 'buffer' });
  if (r.status !== 0) return '';
  return (r.stdout || Buffer.alloc(0)).toString();
}

/** 这个 pid 上有没有进程（**不保证是我们的**）。 */
function pidAlive(pid) {
  if (!pid || pid <= 0) return false;
  const out = tasklistOut(['/FI', 'PID eq ' + pid, '/NH']);
  return out.indexOf(String(pid)) >= 0;   // 无匹配时只打印本地化 INFO 行（不含 PID 数字）
}

/** 取映像名（小写）；查不到返回 null。 */
function imageName(pid) {
  if (!pid || pid <= 0) return null;
  const out = tasklistOut(['/FI', 'PID eq ' + pid, '/NH', '/FO', 'CSV']);
  const lines = String(out || '').split(/\r?\n/).filter((l) => l.trim());
  for (const line of lines) {
    const m = line.match(/^"([^"]+)","(\d+)"/);
    if (m && Number(m[2]) === Number(pid)) return m[1].toLowerCase();
  }
  return null;                            // 无匹配时只有一行本地化 INFO
}

/**
 * 这个 pid 是不是"我们自己这类进程"（node.exe）。
 * 查不到映像名时**保守返回 true** —— 宁可少起一个实例，也不要重复起。
 */
function nodePidAlive(pid) {
  if (!pidAlive(pid)) return false;
  const img = imageName(pid);
  if (img === null) return true;
  return img === 'node.exe';
}

module.exports = { pidAlive, imageName, nodePidAlive };
