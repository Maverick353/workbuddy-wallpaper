'use strict';
/**
 * 真机验证：拿**真实发布产物**跑一次更新流程（apply / 拒绝 / 回滚）。
 *
 * 与 `scripts/verify.js` 的分工：
 *   · `verify.js` 是**离线**断言（CI 跑它），只能验分支逻辑；
 *   · 本脚本必须吃**真实发布包**，验的是"协议对接"——上一版正是栽在这里：
 *     e2e 用了自造的无前缀合成 zip，于是"部署包带一层顶层目录前缀"这个致命问题被绕过（假绿）。
 *
 * 用法：
 *   node scripts/verify-apply-real.js                    # 自动找 landing/ 或 dist/ 里的包
 *   node scripts/verify-apply-real.js --zip <路径>        # 指定包
 *
 * 找不包时**打印跳过并退出 0**（CI 里没有构建产物，不该因此变红）；发布前必须显式跑一次。
 * 全程只写系统临时目录，**绝不碰真实技能目录**。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const upd = require(path.join(ROOT, 'core', 'update.js'));

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

function findZip() {
  const i = process.argv.indexOf('--zip');
  if (i >= 0 && process.argv[i + 1]) return path.resolve(process.argv[i + 1]);
  const cands = [
    path.join(ROOT, 'landing', 'workbuddy-wallpaper.zip'),
    path.join(ROOT, 'dist', 'workbuddy-wallpaper.zip'),
  ];
  return cands.find((p) => fs.existsSync(p)) || null;
}

function makeOldTree(base, version) {
  const t = path.join(base, 'target');
  fs.mkdirSync(path.join(t, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(t, 'package.json'), JSON.stringify({ name: 'workbuddy-wallpaper', version }, null, 2));
  fs.writeFileSync(path.join(t, 'SKILL.md'), '# old skill\n');
  fs.writeFileSync(path.join(t, 'scripts', 'only-in-old.js'), '// 新包里没有这个文件 → 应被同步删除\n');
  return t;
}

let pass = 0, fail = 0;
const ok = (cond, msg) => { (cond ? pass++ : fail++); console.log((cond ? '  ✓ ' : '  ✗ ') + msg); };

(async () => {
  const REAL = findZip();
  if (!REAL) {
    console.log('跳过：找不到真实发布包（landing/ 或 dist/ 里没有 workbuddy-wallpaper.zip）。');
    console.log('发布前请先跑一次发版流程，再用 --zip 指定包重跑本脚本。');
    process.exit(0);
  }
  const buf = fs.readFileSync(REAL);
  const sha = sha256(buf);
  const targetVersion = JSON.parse(readInnerPkg(buf) || '{}').version || null;

  console.log('=== 0. 真实发布包 ===');
  console.log('  ' + path.relative(ROOT, REAL) + '  ' + buf.length + ' 字节');
  console.log('  sha256 = ' + sha);
  console.log('  包内版本 = ' + targetVersion);
  if (!targetVersion) {
    console.error('包内读不到 package.json 版本 —— 这个包本身有问题，停止。');
    process.exit(1);
  }

  console.log('\n=== 1. effectiveRoot 单元 ===');
  const t0 = fs.mkdtempSync(path.join(os.tmpdir(), 'wbwp-er-'));
  const mk = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
  mk(path.join(t0, 'a', 'package.json'), '{"version":"1.0.0"}');
  ok(upd.effectiveRoot(path.join(t0, 'a')) === path.join(t0, 'a'), '根下直接有 package.json → 用根');
  mk(path.join(t0, 'b', 'workbuddy-wallpaper', 'package.json'), '{"version":"1.0.0"}');
  ok(upd.effectiveRoot(path.join(t0, 'b')) === path.join(t0, 'b', 'workbuddy-wallpaper'), '单层顶层前缀 → 下沉一层');
  fs.mkdirSync(path.join(t0, 'c', 'd1'), { recursive: true });
  fs.mkdirSync(path.join(t0, 'c', 'd2'), { recursive: true });
  mk(path.join(t0, 'c', 'd1', 'package.json'), '{"version":"1.0.0"}');
  ok(upd.effectiveRoot(path.join(t0, 'c')) === path.join(t0, 'c'), '多个子目录 → 用根（不猜）');
  mk(path.join(t0, 'e', 'x', 'readme.md'), 'x');
  ok(upd.effectiveRoot(path.join(t0, 'e')) === path.join(t0, 'e'), '单目录里没有 package.json → 用根');
  upd.removeTree(t0);

  console.log('\n=== 2. 本地假更新源（扩展名刻意用 .bin，与生产落点一致）===');
  const srv = http.createServer((req, res) => {
    if (req.url.indexOf('workbuddy-wallpaper') >= 0) {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': buf.length });
      res.end(buf);
    } else { res.writeHead(404); res.end('nope'); }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + srv.address().port + '/workbuddy-wallpaper-' + targetVersion + '.bin';
  console.log('  ' + url);

  const cleanups = [];

  console.log('\n=== 3. 正常更新（真实包，带顶层前缀）===');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wbwp-apply-')); cleanups.push(base);
  const target = makeOldTree(base, '1.1.0');
  const dataDir = path.join(base, 'data');
  let r = null, err = null;
  try {
    r = await upd.applyUpdate({ dataDir, targetDir: target, version: targetVersion, zip: { url, sha256: sha, size: buf.length } });
  } catch (e) { err = e; }
  if (err) console.log('  抛错：' + err.message);
  ok(!!r && r.ok === true, 'applyUpdate 成功（修前必抛「包内版本(undefined) 与目标版本不一致」）');
  if (r) {
    ok(r.from === '1.1.0', '备份来源版本识别为 1.1.0（实得 ' + r.from + '）');
    const after = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'));
    ok(after.version === targetVersion, '覆盖后版本 = ' + targetVersion + '（实得 ' + after.version + '）');
    ok(!fs.existsSync(path.join(target, 'workbuddy-wallpaper')), '没有残留 "workbuddy-wallpaper/" 子目录（有效根下沉生效）');
    ok(fs.existsSync(path.join(target, 'scripts', 'companion.js')), '关键文件就位：scripts/companion.js');
    ok(fs.existsSync(path.join(target, 'core', 'update.js')), '关键文件就位：core/update.js');
    ok(fs.existsSync(path.join(target, 'SKILL.md')), '关键文件就位：SKILL.md');
    ok(!fs.existsSync(path.join(target, 'scripts', 'only-in-old.js')), '旧包独有的文件已被同步删除');
    const bk = path.join(upd.versionsDir(dataDir), '1.1.0');
    ok(fs.existsSync(path.join(bk, 'package.json')), '备份目录存在：versions/1.1.0/');
    ok(JSON.parse(fs.readFileSync(path.join(bk, 'package.json'), 'utf8')).version === '1.1.0', '备份里是旧版本（可回滚）');
    console.log('  （落地文件数 ' + upd.walkFiles(target).length + '，写入 ' + r.written + '，删除 ' + r.removed + '）');
  }

  console.log('\n=== 4. 反向：sha256 不符必须拒绝且不动已装文件 ===');
  const base2 = fs.mkdtempSync(path.join(os.tmpdir(), 'wbwp-apply2-')); cleanups.push(base2);
  const target2 = makeOldTree(base2, '1.1.0');
  let err2 = null;
  try {
    await upd.applyUpdate({ dataDir: path.join(base2, 'data'), targetDir: target2, version: targetVersion, zip: { url, sha256: 'de'.repeat(32), size: buf.length } });
  } catch (e) { err2 = e; }
  ok(!!err2 && /sha256/.test(err2.message), '被拒绝且原因是 sha256');
  ok(JSON.parse(fs.readFileSync(path.join(target2, 'package.json'), 'utf8')).version === '1.1.0', '目标目录未被改动，仍是 1.1.0');
  ok(fs.existsSync(path.join(target2, 'scripts', 'only-in-old.js')), '旧文件仍在（没有发生半覆盖）');
  ok(!fs.existsSync(path.join(base2, 'data', 'versions', '1.1.0')), '被拒绝时没有产生备份目录');

  console.log('\n=== 5. 反向：包内版本 ≠ 目标版本 必须拒绝 ===');
  const base3 = fs.mkdtempSync(path.join(os.tmpdir(), 'wbwp-apply3-')); cleanups.push(base3);
  const target3 = makeOldTree(base3, '1.1.0');
  let err3 = null;
  try {
    await upd.applyUpdate({ dataDir: path.join(base3, 'data'), targetDir: target3, version: '9.9.9', zip: { url, sha256: sha, size: buf.length } });
  } catch (e) { err3 = e; }
  ok(!!err3 && /不一致/.test(err3.message), '被拒绝且原因是版本不一致');
  ok(JSON.parse(fs.readFileSync(path.join(target3, 'package.json'), 'utf8')).version === '1.1.0', '目标目录未被动过');

  console.log('\n=== 6. 回滚：从备份回到旧版本 ===');
  if (r && r.backup) {
    let rb = null, errR = null;
    try { rb = upd.rollbackTo({ dataDir, targetDir: target, version: '1.1.0' }); } catch (e) { errR = e; }
    if (errR) console.log('  抛错：' + errR.message);
    ok(!errR, 'rollbackTo 未抛错');
    ok(JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).version === '1.1.0',
      '回滚后版本回到 1.1.0');
  } else {
    console.log('  （第 3 步没成功，跳过回滚验证）');
  }

  srv.close();
  for (const d of cleanups) { try { upd.removeTree(d); } catch (_) {} }

  console.log('\n' + (fail ? '✗ ' : '✓ ') + '通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', (e && e.stack) || e); process.exit(1); });

/** 从 zip 里读出包内（可能带一层前缀的）package.json。 */
function readInnerPkg(buf) {
  try {
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0; i--) { if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; } }
    if (eocd < 0) return null;
    const n = buf.readUInt16LE(eocd + 10), off = buf.readUInt32LE(eocd + 16);
    let p = off;
    for (let i = 0; i < n; i++) {
      const method = buf.readUInt16LE(p + 10);
      const csize = buf.readUInt32LE(p + 20);
      const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), cmtLen = buf.readUInt16LE(p + 32);
      const lho = buf.readUInt32LE(p + 42);
      const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
      if (/(^|\/)package\.json$/.test(name) && !/node_modules\//.test(name)) {
        const ln = buf.readUInt16LE(lho + 26), le = buf.readUInt16LE(lho + 28);
        const start = lho + 30 + ln + le;
        const raw = buf.subarray(start, start + (method === 0 ? csize : buf.readUInt32LE(p + 24)));
        const out = method === 0 ? raw : require('zlib').inflateRawSync(raw);
        if (name.split('/').length === 2) return out.toString('utf8');
      }
      p += 46 + nameLen + extraLen + cmtLen;
    }
  } catch (_) { return null; }
  return null;
}
