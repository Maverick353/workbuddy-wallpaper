'use strict';
/**
 * 自我进化 · 应用与回滚
 *
 * 这是整条链路唯一"会改文件"的地方，因此边界写得比功能多：
 *
 * 权限边界
 *   · 只允许写 allowedPrefixes（默认 docs/ + CHANGELOG.md + README.md）
 *   · 硬拒 deniedPrefixes（.git/ _backup/ _tmp/ installer/ landing / landing-site / dist/ node_modules/ .evolve/）
 *     （注意：这里只能写目录名，不能写通配符 —— 注释里出现「星号+斜杠」会提前闭合块注释）
 *   · 硬拒密钥类文件名（*.pem *.key *.p12 *.pfx .api-token）
 *   · 代码/配置（.js .json .cmd .iss .vbs .md 之外）一律要 allowCode + 人工 approve
 *
 * 安全前置
 *   · git status 必须干净（否则备份/还原会盖掉用户未提交的改动）
 *   · 改动预算：默认 ≤3 文件、≤120 行
 *
 * 回滚
 *   · 应用前把原文件逐字节复制到 .evolve/backup/<id>/，写 manifest（含"原本不存在"的标记）
 *   · 断言失败 → 自动回滚；也可 `evolve rollback <id>` 手工还原
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const journal = require('./journal');
const validate = require('./validate');

const DEFAULTS = {
  allowedPrefixes: ['docs/', 'CHANGELOG.md', 'README.md'],
  deniedPrefixes: ['.git/', '_backup/', '_tmp/', 'installer/', 'landing/', 'landing-site/', 'dist/', 'node_modules/', '.evolve/', '_rollback/'],
  deniedFileRe: /(\.pem|\.key|\.p12|\.pfx|\.api-token)$/i,
  codeExtRe: /\.(js|cjs|mjs|json|cmd|iss|vbs|ps1)$/i,
  maxFiles: 3,
  maxLines: 120,
  requireCleanGit: true,
};

function norm(p) { return String(p).replace(/\\/g, '/').replace(/^\.\//, ''); }

function classifyPath(file, cfg) {
  const p = norm(file);
  const a = Object.assign({}, DEFAULTS, cfg || {});
  if (/\.\./.test(p) || p.startsWith('/') || /^[A-Za-z]:/.test(p)) return { ok: false, why: '路径越界（绝对路径或 ..）' };
  if (a.deniedFileRe.test(p)) return { ok: false, why: '命中了密钥类文件名黑名单' };
  for (const d of a.deniedPrefixes) if (p === d.replace(/\/$/, '') || p.startsWith(d)) return { ok: false, why: '命中黑名单目录 ' + d };
  for (const okp of a.allowedPrefixes) if (p === okp.replace(/\/$/, '') || p.startsWith(okp)) {
    // 允许目录里也可能混进代码：docs/ 下的 .js 也要当代码看待
    return { ok: true, needsCode: a.codeExtRe.test(p) && !/\.md$/i.test(p) };
  }
  return { ok: false, why: '不在白名单内（' + a.allowedPrefixes.join(', ') + '）' };
}

function gitClean(root) {
  const r = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', timeout: 20000 });
  if (r.status !== 0) return { ok: false, why: '不是 git 仓库或 git 不可用' };
  const dirty = String(r.stdout || '').trim();
  return { ok: dirty === '', why: dirty ? '工作区有未提交改动：\n' + dirty.split('\n').slice(0, 8).join('\n') : '' };
}

/** 预检：不写任何东西，只判断"能不能做"。 */
function precheck(root, proposal, cfg, opt) {
  const a = Object.assign({}, DEFAULTS, cfg || {});
  const o = opt || {};
  const ops = (proposal && proposal.ops) || [];
  const reasons = [];
  if (!ops.length) reasons.push('提案里没有可执行操作');

  const files = [];
  let lines = 0;
  for (const op of ops) {
    const c = classifyPath(op.file, a);
    if (!c.ok) reasons.push(op.file + '：' + c.why);
    else if (c.needsCode && !o.allowCode) reasons.push(op.file + '：是代码/配置文件，需 --allow-code 且人工 approve');
    if (!files.includes(norm(op.file))) files.push(norm(op.file));
    if (op.op === 'append-doc') lines += String(op.body || '').split('\n').length;
    else if (op.op === 'replace-exact') lines += String(op.replace || '').split('\n').length;
    else reasons.push('不支持的操作 ' + op.op);
  }
  if (files.length > a.maxFiles) reasons.push('改动文件数 ' + files.length + ' > 预算 ' + a.maxFiles);
  if (lines > a.maxLines) reasons.push('改动行数 ' + lines + ' > 预算 ' + a.maxLines);
  if (a.requireCleanGit && !o.skipCleanCheck) {
    const g = gitClean(root);
    if (!g.ok) reasons.push(g.why);
  }
  return { ok: reasons.length === 0, reasons, files, lines };
}

function backup(root, id, files) {
  const dir = path.join(journal.dir(root), 'backup', id);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = [];
  for (const f of files) {
    const abs = path.join(root, f);
    const existed = fs.existsSync(abs);
    if (existed) {
      const dst = path.join(dir, f);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(abs, dst);
    }
    manifest.push({ file: f, existed });
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id, at: Date.now(), files: manifest }, null, 2));
  return dir;
}

/** 真正落盘。返回每个 op 的结果。 */
function applyOps(root, ops) {
  const done = [];
  for (const op of ops) {
    const abs = path.join(root, norm(op.file));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (op.op === 'append-doc') {
      const before = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
      const header = before ? '' : ('# ' + path.basename(op.file, '.md') + '\n\n');
      const body = String(op.body || '').replace(/\s+$/, '') + '\n';
      fs.writeFileSync(abs, before + (before.endsWith('\n') || !before ? '' : '\n') + (before ? '\n' : '') + header + body);
      done.push({ op: op.op, file: norm(op.file), lines: body.split('\n').length, created: !before });
    } else if (op.op === 'replace-exact') {
      const before = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
      const find = String(op.find || '');
      const n = before.split(find).length - 1;
      if (!find || n !== 1) throw new Error(norm(op.file) + '：精确替换要求原文恰好出现 1 次，实际 ' + n + ' 次');
      fs.writeFileSync(abs, before.split(find).join(String(op.replace || '')));
      done.push({ op: op.op, file: norm(op.file), lines: String(op.replace || '').split('\n').length, occurrences: n });
    } else {
      throw new Error('不支持的操作 ' + op.op);
    }
  }
  return done;
}

function rollback(root, id) {
  const dir = path.join(journal.dir(root), 'backup', id);
  const mf = path.join(dir, 'manifest.json');
  if (!fs.existsSync(mf)) return { ok: false, error: '找不到备份：' + mf };
  const manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
  const restored = [];
  for (const f of manifest.files) {
    const abs = path.join(root, f.file);
    if (f.existed) {
      fs.copyFileSync(path.join(dir, f.file), abs);
      restored.push({ file: f.file, action: 'restored' });
    } else {
      try { fs.unlinkSync(abs); restored.push({ file: f.file, action: 'deleted(created-by-apply)' }); } catch (_) { restored.push({ file: f.file, action: 'skip(missing)' }); }
    }
  }
  journal.append(root, { type: 'rollback', id: id, files: restored });
  return { ok: true, restored };
}

/**
 * 完整应用流程：预检 → 备份 → 落盘 → 验证 → 失败自动回滚。
 * @returns {{ok, phase, ...}}
 */
function apply(root, proposal, cfg, opt) {
  const o = opt || {};
  const id = proposal.id;
  const pre = precheck(root, proposal, cfg, o);
  if (!pre.ok) {
    journal.append(root, { type: 'apply-rejected', id: id, reasons: pre.reasons });
    return { ok: false, phase: 'precheck', reasons: pre.reasons };
  }
  if (o.dryRun) {
    journal.append(root, { type: 'apply-dryrun', id: id, files: pre.files, lines: pre.lines });
    return { ok: true, phase: 'dryrun', files: pre.files, lines: pre.lines, ops: proposal.ops };
  }

  const bdir = backup(root, id, pre.files);
  journal.append(root, { type: 'apply-start', id: id, files: pre.files, lines: pre.lines, backup: bdir });
  let done;
  try {
    done = applyOps(root, proposal.ops);
  } catch (e) {
    rollback(root, id);
    journal.append(root, { type: 'apply-failed', id: id, phase: 'write', error: e.message });
    return { ok: false, phase: 'write', error: e.message, rolledBack: true };
  }

  const v = validate.runAll(root, pre.files, { minPass: o.minPass || (cfg && cfg.apply && cfg.apply.minAssertions) || 0, withVerify: o.verify !== false });
  if (!v.ok) {
    rollback(root, id);
    journal.append(root, { type: 'apply-failed', id: id, phase: 'validate', checks: v.checks, rolledBack: true });
    return { ok: false, phase: 'validate', checks: v.checks, rolledBack: true };
  }

  journal.append(root, { type: 'apply-ok', id: id, files: done, checks: v.checks, backup: bdir });
  journal.patchState(root, { lastApplyAt: Date.now() });
  return { ok: true, phase: 'applied', files: done, checks: v.checks, backup: bdir };
}

module.exports = { precheck, apply, applyOps, rollback, backup, classifyPath, gitClean, DEFAULTS };
