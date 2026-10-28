// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
/**
 * pause.js · 「暂停壁纸」与「退出插件」是两个不同的东西，标志文件也必须是两个
 * --------------------------------------------------------------------------
 *   `.paused`  —— 用户只是想暂时不看壁纸：
 *                服务照跑、看门狗照常看护、面板与吉祥物都还在，只把背景层拆掉；
 *                **重启服务后依然是暂停状态**（尊重用户意图，不能被自愈顺手抹掉）。
 *   `.stopped` —— 用户真要退出插件（原有语义，未改）：
 *                服务退出、companion 不再拉起，恢复要手动运行启动脚本。
 *
 * 为什么必须分开：原来的「关闭壁纸」直接写 `.stopped`，而 companion 见到它就
 * `return`，连注销重登都不拉起 —— 想要「先关一会儿」的用户实际执行了「卸载」，
 * 而且面板一起消失，连自救入口都没有。这是本次修改要消灭的那类不可逆操作。
 *
 * 文件内容：JSON `{ at, by }`（by 记录来源，便于排障；解析失败一律当「暂停中」，
 * 因为「用户说过不想看」比「壁纸不见了」更安全）。
 */

const fs = require('fs');
const path = require('path');

const FLAG_PAUSED = '.paused';
const FLAG_STOPPED = '.stopped';

function flagPath(dataDir, name) {
  return path.join(String(dataDir || '.'), name);
}

/** 读暂停状态。任何异常都按「未暂停」处理（缺文件是常态，不是错误）。 */
function readPaused(dataDir) {
  try {
    const raw = fs.readFileSync(flagPath(dataDir, FLAG_PAUSED), 'utf8');
    let at = null;
    let by = null;
    try {
      const j = JSON.parse(raw);
      at = Number(j && j.at) || null;
      by = (j && j.by) || null;
    } catch (_) {
      // 老格式/被手工改过：内容不是 JSON 也算暂停中，at 尽力取时间戳
      const n = Number(String(raw).trim());
      at = isFinite(n) && n > 0 ? n : null;
    }
    return { paused: true, at, by };
  } catch (_) {
    return { paused: false, at: null, by: null };
  }
}

/** 写/删暂停标志。返回写入后的状态。 */
function setPaused(dataDir, on, by) {
  const p = flagPath(dataDir, FLAG_PAUSED);
  if (on) {
    try {
      fs.mkdirSync(String(dataDir || '.'), { recursive: true });
      fs.writeFileSync(p, JSON.stringify({ at: Date.now(), by: by || 'api' }));
    } catch (_) { /* 写不进去也不抛：内存态仍生效，下次启动只是回到未暂停 */ }
  } else {
    try { fs.unlinkSync(p); } catch (_) { /* 本来就没有 */ }
  }
  return readPaused(dataDir);
}

/** 「已退出插件」是否成立（只读判断，供 doctor/面板/文档一致性使用）。 */
function isStopped(dataDir) {
  try { return fs.existsSync(flagPath(dataDir, FLAG_STOPPED)); } catch (_) { return false; }
}

module.exports = { FLAG_PAUSED, FLAG_STOPPED, readPaused, setPaused, isStopped };
