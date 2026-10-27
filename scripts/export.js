#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
/**
 * export.js · 用户数据的导出 / 导入（零依赖，stored-zip）
 * ------------------------------------------------------------------
 * 为什么需要：数据全在 `%APPDATA%\workbuddy-wallpaper`，换机/重装/备份只能手拷目录 ——
 * 而那里混着**令牌、锁、下载暂存**这类不该带走或不该覆盖的东西，手拷很容易出事。
 *
 * 设计取舍：
 *   · 只导出**用户资产**（壁纸、主题、蒙版、偏好配置），
 *     排除 `.api-token`（凭据）、`.companion.lock` / `.ui.pid` / `.companion.hb`（运行态）、
 *     `update/`（下载暂存）、`we-renderer/`（随包生成，版本不符会自愈覆盖）、`*.log`。
 *   · 用 **stored（不压缩）** 的 zip：零依赖、实现简单、不会因为 zlib 版本差异产生跨平台麻烦。
 *     壁纸多是 webp/mp4，压缩收益本来就低。
 *   · 导入是**合并覆盖**，不是镜像：绝不给目标目录做 syncTree（那会删掉 .api-token 等）。
 *   · 导入前默认先备份到 `<dataDir>/import-backup-<ts>/`（可用 --no-backup 关掉）。
 *
 * 用法：
 *   node scripts/export.js --out backup.zip
 *   node scripts/export.js --import backup.zip [--data-dir <dir>] [--dry-run] [--no-backup]
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const update = require('../core/update.js');

const APP = 'workbuddy-wallpaper';

/** 默认数据目录（与 standalone 保持一致）。 */
function defaultDataDir() {
  const base = process.env.APPDATA ||
    (process.platform === 'win32' ? path.join(os.homedir(), 'AppData', 'Roaming') : path.join(os.homedir(), '.config'));
  return path.join(base, APP);
}

// 导出白名单：宁可少带，也不要带出凭据或运行态。
const INCLUDE_DIRS = ['themes'];
const INCLUDE_FILES = ['mask.json', 'current-theme.json', 'update.json', 'we-cache.json', 'fonts-cache.json'];
// 明确排除（即使落在 include 里也跳过）
const DENY = [/^\.api-token$/, /^\.companion\.lock$/, /^\.ui\.pid$/, /^\.companion\.hb$/, /^\.stopped$/, /\.log$/i];

function shouldSkip(rel) {
  return DENY.some((re) => re.test(rel));
}

function collect(dataDir) {
  const out = [];
  for (const f of INCLUDE_FILES) {
    const abs = path.join(dataDir, f);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile() && !shouldSkip(f)) {
      out.push({ rel: f, abs });
    }
  }
  for (const d of INCLUDE_DIRS) {
    const root = path.join(dataDir, d);
    if (!fs.existsSync(root)) continue;
    const stack = [''];
    while (stack.length) {
      const sub = stack.pop();
      const dir = path.join(root, sub);
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = path.posix.join(d, sub, e.name);
        if (e.isDirectory()) { stack.push(path.posix.join(sub, e.name)); continue; }
        if (shouldSkip(rel)) continue;
        out.push({ rel, abs: path.join(root, sub, e.name) });
      }
    }
  }
  return out;
}

// ── 最小 zip 写入（stored，无压缩）────────────────────────────────────────
function dosTime(d) {
  const t = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() / 2)) & 0xffff;
  const dt = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  return { t, dt };
}

function writeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const now = new Date();
  const { t, dt } = dosTime(now);

  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = e.data;
    const crc = update.crc32(data) >>> 0;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);          // version needed
    lh.writeUInt16LE(0x0800, 6);      // flag: UTF-8 文件名
    lh.writeUInt16LE(0, 8);           // method: stored
    lh.writeUInt16LE(t, 10);
    lh.writeUInt16LE(dt, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); // compressed = uncompressed
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);

    const local = Buffer.concat([lh, name, data]);
    locals.push(local);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);          // version made by
    ch.writeUInt16LE(20, 6);          // version needed
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(t, 12);
    ch.writeUInt16LE(dt, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30);          // extra
    ch.writeUInt16LE(0, 32);          // comment
    ch.writeUInt16LE(0, 34);          // disk
    ch.writeUInt16LE(0, 36);          // internal attrs
    ch.writeUInt32LE(0, 38);          // external attrs
    ch.writeUInt32LE(offset, 42);     // local header offset
    centrals.push(Buffer.concat([ch, name]));

    offset += local.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat(locals.concat([centralBuf, eocd]));
}

// ── 对外 API ──────────────────────────────────────────────────────────────
function exportData(opts) {
  const o = opts || {};
  const dataDir = o.dataDir || defaultDataDir();
  const out = o.out;
  if (!out) throw new Error('缺少导出文件路径（--out <file.zip>）');
  if (!fs.existsSync(dataDir)) throw new Error('数据目录不存在：' + dataDir);

  const files = collect(dataDir);
  if (!files.length) throw new Error('没有可导出的数据（目录是空的？）');

  const entries = [{
    name: 'manifest.json',
    data: Buffer.from(JSON.stringify({
      app: APP,
      schema: 1,
      exportedAt: new Date().toISOString(),
      version: readVersion(),
      files: files.length,
    }, null, 2)),
  }];
  let bytes = 0;
  for (const f of files) {
    const data = fs.readFileSync(f.abs);
    bytes += data.length;
    entries.push({ name: f.rel, data });
  }
  const buf = writeZip(entries);
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, buf);
  return { ok: true, out: path.resolve(out), files: files.length, sourceBytes: bytes, zipBytes: buf.length };
}

function readVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version; }
  catch (_) { return 'unknown'; }
}

function importData(opts) {
  const o = opts || {};
  const dataDir = o.dataDir || defaultDataDir();
  const zip = o.zip;
  if (!zip || !fs.existsSync(zip)) throw new Error('找不到导入文件：' + zip);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wbwp-import-'));
  let res;
  try {
    res = update.unzipTo(zip, tmp);
    const root = update.effectiveRoot(tmp);
    const manifestPath = path.join(root, 'manifest.json');
    if (!fs.existsSync(manifestPath)) throw new Error('不是本技能的导出包（缺 manifest.json）');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.app !== APP) throw new Error('导出包属于别的应用：' + manifest.app);

    // 收集待导入文件。⚠️ `walkFiles(root)` 返回的是**相对路径**（相对第二个参数，默认 root），
    //    所以这里直接用，别再套 path.relative（会把相对路径当 cwd 相对 → 拼出绝对路径，触发穿越校验）。
    const plan = [];
    for (const rel of update.walkFiles(root)) {
      if (rel === 'manifest.json') continue;
      const safe = update.safeEntryName(rel);
      if (!safe || safe !== rel) throw new Error('导出包里有非法路径：' + rel);
      if (shouldSkip(rel)) continue;
      plan.push({ rel, abs: path.join(root, rel) });
    }
    if (o.dryRun) return { ok: true, dryRun: true, willWrite: plan.length, dataDir };

    fs.mkdirSync(dataDir, { recursive: true });

    // 导入前备份（合并覆盖前留一个整目录快照，防"导错了回不去"）
    let backupDir = null;
    if (!o.noBackup) {
      backupDir = path.join(dataDir, 'import-backup-' + new Date().toISOString().replace(/[:.]/g, '-'));
      fs.mkdirSync(backupDir, { recursive: true });
      try { update.syncTree(dataDir, backupDir); } catch (_) {}
    }

    let written = 0;
    for (const p of plan) {
      const to = path.join(dataDir, p.rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(p.abs, to);
      written++;
    }
    return { ok: true, imported: written, dataDir, backupDir, fromVersion: manifest.version, at: manifest.exportedAt };
  } finally {
    try { update.removeTree(tmp); } catch (_) {}
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────
function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : '';
}

if (require.main === module) {
  try {
    const dataDir = arg('data-dir') || defaultDataDir();
    if (process.argv.includes('--import')) {
      const zip = arg('import');
      const r = importData({
        zip, dataDir,
        dryRun: process.argv.includes('--dry-run'),
        noBackup: process.argv.includes('--no-backup'),
      });
      if (r.dryRun) process.stdout.write('将要写入 ' + r.willWrite + ' 个文件 → ' + r.dataDir + '\n（--dry-run，未写入）\n');
      else process.stdout.write('已导入 ' + r.imported + ' 个文件 → ' + r.dataDir + '\n备份：' + (r.backupDir || '(未备份)') + '\n');
      if (!r.dryRun) process.stdout.write('提示：服务在跑的话要重启一次才生效。\n');
    } else {
      const out = arg('out') || path.join(process.cwd(), APP + '-data-' + Date.now() + '.zip');
      const r = exportData({ dataDir, out });
      process.stdout.write('已导出 ' + r.files + ' 个文件（' + r.sourceBytes + ' B → ' + r.zipBytes + ' B）\n');
      process.stdout.write('文件：' + r.out + '\n');
      process.stdout.write('不含：.api-token / 锁与心跳 / update 暂存 / we-renderer / 日志\n');
    }
  } catch (e) {
    process.stderr.write('失败：' + ((e && e.message) || e) + '\n');
    process.exit(1);
  }
}

module.exports = { exportData, importData, writeZip, collect, defaultDataDir, INCLUDE_DIRS, INCLUDE_FILES };
