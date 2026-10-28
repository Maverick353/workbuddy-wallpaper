'use strict';
/**
 * 自我进化 · 验证
 *
 * 应用改动后必须过的三道：
 *   ① `node --check` —— 语法（只对 .js）
 *   ② `verify.js` 全绿，且**断言总数不得下降**（防"删断言让它变绿"）
 *   ③ 改动文件数/行数在预算内（在 apply 里先卡，这里只复核）
 *
 * 一律 spawnSync + 超时，不引第三方测试框架。
 */
const { spawnSync } = require('child_process');
const path = require('path');

function nodeCheck(root, files) {
  const js = files.filter((f) => /\.js$/.test(f));
  const bad = [];
  for (const f of js) {
    const r = spawnSync(process.execPath, ['--check', path.join(root, f)], { encoding: 'utf8', timeout: 20000 });
    if (r.status !== 0) bad.push({ file: f, err: String(r.stderr || '').split('\n').slice(0, 3).join(' ').trim() });
  }
  return { name: 'node --check', ok: bad.length === 0, detail: bad.length ? JSON.stringify(bad) : js.length + ' 个 JS 语法通过' };
}

function parseVerify(out) {
  const m = String(out).match(/通过\s*(\d+)\s*\/\s*失败\s*(\d+)/);
  return m ? { pass: Number(m[1]), fail: Number(m[2]) } : null;
}

function runVerify(root, opt) {
  const o = Object.assign({ timeoutMs: 180000, minPass: 0 }, opt || {});
  const r = spawnSync(process.execPath, ['scripts/verify.js'], { cwd: root, encoding: 'utf8', timeout: o.timeoutMs });
  const out = String(r.stdout || '') + String(r.stderr || '');
  const p = parseVerify(out);
  const okCode = r.status === 0;
  const okCount = !!p && p.fail === 0;
  const okFloor = !!p && p.pass >= o.minPass;
  return {
    name: 'verify.js',
    ok: okCode && okCount && okFloor,
    detail: p ? ('通过 ' + p.pass + ' / 失败 ' + p.fail + (okFloor ? '' : '（低于基线 ' + o.minPass + '，疑似删断言）')) : ('无法解析输出：' + out.slice(-200)),
    pass: p ? p.pass : 0,
  };
}

function runAll(root, changedFiles, opt) {
  const checks = [nodeCheck(root, changedFiles)];
  if (!opt || opt.withVerify !== false) checks.push(runVerify(root, { minPass: (opt && opt.minPass) || 0 }));
  return { ok: checks.every((c) => c.ok), checks };
}

module.exports = { nodeCheck, runVerify, runAll, parseVerify };
