#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
/**
 * lnk.js · 读写 Windows 快捷方式（.lnk / MS-SHLLINK）—— 零依赖，纯 Node
 * ==================================================================
 * 为什么要自己写：本技能要让 WorkBuddy 带 `--remote-debugging-port=9222` 启动，
 * 可靠做法是**改写它的快捷方式**。而改写 .lnk 有两条路：
 *   · 走 wscript/cscript（WScript.Shell.CreateShortcut）—— 简单，但**脚本宿主可能被策略禁**，
 *     而且本项目要在 CI/无 GUI 环境里可测；
 *   · 直接改二进制 —— 本文件走这条。
 *
 * 格式要点（**均经真实 .lnk 字节级验证**，别凭印象改）：
 *   · ShellLinkHeader 76 字节；LinkFlags 在 offset 20（4 字节 LE）
 *   · 置位含义：0x01 HasLinkTargetIDList · 0x02 HasLinkInfo · 0x04 HasName · 0x08 HasRelativePath
 *              0x10 HasWorkingDir · 0x20 HasArguments · 0x40 HasIconLocation · 0x80 IsUnicode
 *   · offset 76 起：HasLinkTargetIDList 时先 2 字节 IDListSize，再 IDListSize 字节 IDList
 *   · 紧接着 LinkInfo（HasLinkInfo 时）：头 4 字节就是它自己的 Size，按它跳过即可
 *   · 再紧接 StringData：按 flags 决定存在哪些，顺序**固定**为
 *       NAME → RELATIVE_PATH → WORKING_DIR → ARGUMENTS → ICON_LOCATION
 *     每项是 CountedString = [2 字节字符数][n 个 UTF-16LE 字符]，**结尾没有 NUL**
 *   · 最后是 ExtraData（每块自带 size，不必解析）
 *
 * ★ 关键性质：IDList 的长度字段位于 StringData **之前**，且结构里没有任何绝对偏移指针指向
 *   StringData/ExtraData ⇒ **改 StringData 的长度不需要回填任何 header 字段**，
 *   插入/替换只需重排字节 + 必要时改 1 个 flag 位。
 *   实测：往无参版本插入 ARGUMENTS 后，输出与真实文件逐字节一致。
 */
const fs = require('fs');

const OFF_FLAGS = 20;
const OFF_IDLIST_SIZE = 76;
const F = {
  ID_LIST: 0x01, LINK_INFO: 0x02, NAME: 0x04, RELATIVE_PATH: 0x08,
  WORKING_DIR: 0x10, ARGUMENTS: 0x20, ICON_LOCATION: 0x40, UNICODE: 0x80,
};
/** StringData 的固定顺序。 */
const STR_ORDER = [
  ['NAME', F.NAME],
  ['RELATIVE_PATH', F.RELATIVE_PATH],
  ['WORKING_DIR', F.WORKING_DIR],
  ['ARGUMENTS', F.ARGUMENTS],
  ['ICON_LOCATION', F.ICON_LOCATION],
];
/** ARGUMENTS 应插在这几项之后。 */
const BEFORE_ARGS = ['NAME', 'RELATIVE_PATH', 'WORKING_DIR'];

/** 解析一个 .lnk 的结构（只读，不修改）。 */
function parse(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 78) throw new Error('不是有效的 .lnk（太短）');
  if (buf.readUInt32LE(0) !== 0x0000004C) throw new Error('不是有效的 .lnk（header size 不是 76）');
  const flags = buf.readUInt32LE(OFF_FLAGS);
  let off = OFF_IDLIST_SIZE;
  if (flags & F.ID_LIST) {
    const n = buf.readUInt16LE(off);
    off += 2 + n;
  }
  if (flags & F.LINK_INFO) {
    off += buf.readUInt32LE(off);           // LinkInfo 自带 Size
  }
  const strStart = off;
  const items = [];
  for (const [name, bit] of STR_ORDER) {
    if (!(flags & bit)) continue;
    const count = buf.readUInt16LE(off);
    const byteLen = (flags & F.UNICODE) ? count * 2 : count;
    const raw = buf.slice(off + 2, off + 2 + byteLen);
    const value = (flags & F.UNICODE) ? raw.toString('utf16le') : raw.toString('latin1');
    items.push({ name, bit, offset: off, count, byteLen, end: off + 2 + byteLen, value });
    off += 2 + byteLen;
  }
  return { flags, strStart, items, extraStart: off, unicode: !!(flags & F.UNICODE) };
}

/** 读 ARGUMENTS（没有返回 null）。 */
function readArguments(buf) {
  const it = parse(buf).items.find((i) => i.name === 'ARGUMENTS');
  return it ? it.value : null;
}

/** 读 NAME（快捷方式显示名）。 */
function readName(buf) {
  const it = parse(buf).items.find((i) => i.name === 'NAME');
  return it ? it.value : null;
}

/** 读 LinkInfo 里的 LocalBasePath（= 目标 exe 的完整路径）。取不到返回 null。 */
function readTarget(buf) {
  const p = parse(buf);
  if (!(p.flags & F.LINK_INFO)) return null;
  let li = OFF_IDLIST_SIZE;
  if (p.flags & F.ID_LIST) li += 2 + buf.readUInt16LE(li);
  try {
    const localBasePathOffset = buf.readUInt32LE(li + 16);
    if (!localBasePathOffset) return null;
    let end = li + localBasePathOffset;
    while (end < buf.length && buf[end] !== 0) end++;
    return buf.slice(li + localBasePathOffset, end).toString('latin1');
  } catch (_) {
    return null;
  }
}

/** 把一段纯 ASCII 参数编成 CountedString（结尾不带 NUL）。 */
function encodeArg(str, unicode) {
  const s = String(str == null ? '' : str);
  if (unicode) {
    const body = Buffer.from(s, 'utf16le');
    const head = Buffer.alloc(2);
    head.writeUInt16LE(body.length / 2, 0);
    return Buffer.concat([head, body]);
  }
  const body = Buffer.from(s, 'latin1');
  const head = Buffer.alloc(2);
  head.writeUInt16LE(body.length, 0);
  return Buffer.concat([head, body]);
}

/**
 * 把 ARGUMENTS 设成 args（有则替换、无则插入），返回**新 Buffer**（不改原 buffer）。
 * 只动两处：StringData 里那一段字节 + LinkFlags 的 bit5。
 */
function setArguments(buf, args) {
  const p = parse(buf);
  const entry = encodeArg(args, p.unicode);
  const existing = p.items.find((i) => i.name === 'ARGUMENTS');

  if (existing) {
    // 已有 ARGUMENTS → 原位替换（前后字节原样保留）
    return Buffer.concat([buf.slice(0, existing.offset), entry, buf.slice(existing.end)]);
  }
  // 没有 → 插在 WORKING_DIR 之后、ICON_LOCATION 之前（若这些都不存在则插在 StringData 开头）
  const before = p.items.filter((i) => BEFORE_ARGS.includes(i.name));
  const insertAt = before.length ? before[before.length - 1].end : p.strStart;
  const out = Buffer.concat([buf.slice(0, insertAt), entry, buf.slice(insertAt)]);
  out.writeUInt32LE(p.flags | F.ARGUMENTS, OFF_FLAGS);   // 置位 HasArguments
  return out;
}

// ── CLI：node scripts/lnk.js <目标.lnk> [--set-args "..."] [--dry-run] ──
if (require.main === module) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.log('用法: node scripts/lnk.js <快捷方式.lnk> [--set-args "参数"] [--dry-run]');
    process.exit(0);
  }
  const buf = fs.readFileSync(file);
  const p = parse(buf);
  console.log('文件      : ' + file + '  (' + buf.length + ' 字节)');
  console.log('LinkFlags : 0x' + p.flags.toString(16).toUpperCase().padStart(8, '0') + (p.unicode ? '  (Unicode)' : '  (ANSI)'));
  console.log('目标 exe  : ' + (readTarget(buf) || '(未解析到)'));
  console.log('显示名    : ' + (readName(buf) || '(无)'));
  for (const it of p.items) console.log('  ' + it.name.padEnd(14) + ' @0x' + it.offset.toString(16) + '  len=' + it.count + '  ' + JSON.stringify(it.value));
  const si = args.indexOf('--set-args');
  if (si >= 0 && args[si + 1] !== undefined) {
    const out = setArguments(buf, args[si + 1]);
    console.log('\n设置 ARGUMENTS = ' + JSON.stringify(args[si + 1]) + '  → 新长度 ' + out.length + ' 字节');
    if (args.includes('--dry-run')) console.log('（--dry-run：未写盘）');
    else { fs.writeFileSync(file, out); console.log('已写入：' + file); }
  }
  process.exit(0);
}

module.exports = { parse, readArguments, readName, readTarget, setArguments, F };
