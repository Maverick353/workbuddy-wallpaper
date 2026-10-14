#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
/**
 * resolve-node.js · 找 node + 校验版本
 * ==================================================================
 * 为什么需要它：
 *   ① WorkBuddy **不把自己的 Node 放进 PATH** —— 它通过环境变量暴露：
 *        CODEBUDDY_NODE_BIN      = 解析好的 node.exe 绝对路径
 *        WORKBUDDY_EXTRA_PATHS   = 一串「直接含 node.exe 的目录」，';' 分隔
 *      所以从 WorkBuddy 之外双击启动的脚本（.cmd / 登录时的自启）里，
 *      `where node` 必然是失败的 —— 这也是很多"装了没反应"的根因。
 *   ② 本项目实际需要 **Node ≥ 22**：scripts/cdp.js 用了全局 WebSocket（Node 22 才有）。
 *      18/20 上它的表现是「服务正常在跑，但界面永远不上屏」——最难查的那种失败。
 *
 * 探测顺序（尽量贴宿主官方做法）：
 *   1) process.execPath                  —— 已经在 node 下跑，最可信（仅用于"现在就要 spawn"）
 *   2) CODEBUDDY_NODE_BIN                —— 宿主钦定
 *   3) WORKBUDDY_EXTRA_PATHS             —— 宿主钦定（';' 分隔）
 *   4) PATH                              —— 兜底
 *   5) <USERPROFILE>/.workbuddy/binaries/node/versions/current  —— 登录态/双击态下唯一可用的线索
 *      （读这个纯文本版本号文件，再拼 versions/<值>/node.exe）
 *   6) 扫描 versions/<版本>/node.exe 取最新     —— 最后兜底
 *   全都失败 → **大声失败**，给出人话原因与下一步。
 *
 * ⚠️ 顺序说明：宿主自带的 run-node.cmd 里明确写着「故意不深挖宿主内部 binaries 布局，
 *    猜错了会选到半解压或过期安装」。所以 5)/6) 排在那几条之后，且每一步都先 existsSync 校验。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const MIN_MAJOR = 22;

const exists = (p) => { try { return !!p && fs.existsSync(p); } catch (_) { return false; } };

/** 从版本号字符串取 major。'22.22.2' -> 22；无法解析返回 0。 */
function majorOf(v) {
  const m = /^v?(\d+)\./.exec(String(v || ''));
  return m ? Number(m[1]) : 0;
}

/** 当前进程的 node 版本是否达标。 */
function currentNodeOk(minMajor) {
  const maj = majorOf(process.version);
  return maj >= (minMajor || MIN_MAJOR) ? { ok: true, version: process.version, major: maj } : { ok: false, version: process.version, major: maj };
}

/** 宿主版本索引目录（versions/）。 */
function versionsRoot() {
  return path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'versions');
}

/**
 * 找可用的 node.exe。
 * @param {{minMajor?: number, preferSelf?: boolean}} [opts]
 * @returns {{exe: string|null, source: string, version?: string, tried: string[]}}
 */
function resolveNode(opts) {
  const o = opts || {};
  const min = o.minMajor || MIN_MAJOR;
  const tried = [];

  const accept = (exe, source) => {
    if (!exists(exe)) { tried.push(source + '（不存在）'); return null; }
    return { exe, source, tried };
  };

  // 1) 自身（已跑在 node 下）
  if (o.preferSelf !== false) {
    const r = accept(process.execPath, 'self(process.execPath)');
    if (r) return r;
  }
  // 2) 宿主钦定
  const r2 = accept(process.env.CODEBUDDY_NODE_BIN, 'env:CODEBUDDY_NODE_BIN');
  if (r2) return r2;
  // 3) 宿主钦定路径串
  const extra = String(process.env.WORKBUDDY_EXTRA_PATHS || '')
    .split(path.delimiter)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const d of extra) {
    const r = accept(path.join(d, 'node.exe'), 'env:WORKBUDDY_EXTRA_PATHS');
    if (r) return r;
  }
  // 4) PATH
  for (const d of String(process.env.PATH || '').split(path.delimiter)) {
    if (!d) continue;
    const r = accept(path.join(d, 'node.exe'), 'PATH');
    if (r) return r;
  }
  // 5) 宿主版本索引 versions/current（登录态 / 双击态唯一线索）
  const root = versionsRoot();
  const cur = path.join(root, 'current');
  if (exists(cur)) {
    let v = '';
    try { v = String(fs.readFileSync(cur, 'utf8') || '').trim(); } catch (_) {}
    if (v) {
      const r = accept(path.join(root, v, 'node.exe'), 'versions/current');
      if (r) return r;
    }
  }
  // 6) 扫 versions/<版本>/node.exe（取目录名最大的，通常是较新）
  if (exists(root)) {
    try {
      const dirs = fs.readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
        .reverse();
      for (const d of dirs) {
        const r = accept(path.join(root, d, 'node.exe'), 'versions/<版本>');
        if (r) return r;
      }
    } catch (_) {}
  }
  return { exe: null, source: 'none', tried };
}

/**
 * 启动时自检：版本不达标就打印人话原因与下一步，并返回 false。
 * 各入口（start-ui / companion / server）都该先调它。
 */
function assertNodeOk(label, minMajor) {
  const min = minMajor || MIN_MAJOR;
  const cur = currentNodeOk(min);
  if (cur.ok) return true;
  const w = (s) => process.stderr.write(s + '\n');
  w('');
  w('✗ ' + (label || '本项目') + ' 需要 Node ≥ ' + min + '，当前是 ' + process.version + '（major ' + cur.major + '）');
  w('  原因：scripts/cdp.js 用了 Node 内置的全局 WebSocket（Node 22 起才有）。');
  w('  用低版本跑的表现很隐蔽：服务能起来、日志正常，但**界面永远不出来**。');
  w('');
  w('  怎么修（任选其一）：');
  w('   · 用 WorkBuddy 自带的 Node 跑（它 ≥ 22）：先启动一次 WorkBuddy，再执行');
  w('       node "' + path.join(__dirname, path.basename(process.argv[1] || '')) + '"');
  w('   · 或升级系统 Node 到 22+：https://nodejs.org/');
  w('   · 打印本机可用 node：node scripts/resolve-node.js');
  w('');
  return false;
}

// CLI：直接运行则打印解析结果
if (require.main === module) {
  const cur = currentNodeOk();
  console.log('当前进程 node : ' + process.version + (cur.ok ? '  ✓ 达标' : '  ✗ 需要 ≥' + MIN_MAJOR));
  const r = resolveNode();
  if (r.exe) {
    console.log('解析到可用 node: ' + r.exe);
    console.log('  来源        : ' + r.source);
  } else {
    console.log('✗ 没找到 node.exe');
    console.log('  已尝试      : ' + r.tried.join(' / '));
  }
  console.log('探测顺序说明  : self → CODEBUDDY_NODE_BIN → WORKBUDDY_EXTRA_PATHS → PATH → versions/current → versions/*');
  process.exit(cur.ok ? 0 : 1);
}

module.exports = { resolveNode, currentNodeOk, assertNodeOk, majorOf, versionsRoot, MIN_MAJOR };
