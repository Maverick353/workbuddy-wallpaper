#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
/**
 * gen-api-docs.js · 从 server/routes.js 的 ROUTES 表生成接口清单
 * ------------------------------------------------------------------
 * 为什么不用手写文档：手写的接口文档**一定会漂**。这里把 `ROUTES` 当唯一事实源，
 * 生成 `docs/api/接口清单.md`；`verify.js` 会比对"重新生成的结果"与磁盘文件，
 * 不一致就红 —— 也就是说：**加了接口不改文档，CI 直接挂**。
 *
 * 路由一旦新增但没在本文件的 CATALOG 里写说明 → 生成直接失败（exit 1），
 * 逼你把"这个接口干什么、要不要令牌"补上。
 *
 * 用法：node scripts/gen-api-docs.js [--check]
 *   --check  只比对不写；不一致非 0 退出（给 CI / 断言用）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ROUTES_SRC = path.join(ROOT, 'server', 'routes.js');
const OUT = path.join(ROOT, 'docs', 'api', '接口清单.md');

// 每个接口的人工说明。**新增路由必须在这里补一条**，否则生成失败。
const CATALOG = {
  'GET /api/wallpaper/health': { desc: '健康检查：版本、挂载方式、数据目录、渲染器状态', auth: '否', params: '—', ret: 'ok / plugin / dirs / renderer' },
  'GET /api/wallpapers': { desc: '列出官方壁纸（随包种子）', auth: '否', params: '—', ret: 'wallpapers[]：name/type/title' },
  'GET /api/custom-wallpapers': { desc: '列出用户上传的自定义壁纸', auth: '否', params: '—', ret: 'wallpapers[]' },
  'POST /api/custom-wallpapers': { desc: '上传自定义壁纸（图片）', auth: '否', params: 'body：图片二进制或 dataURL', ret: 'name / size' },
  'DELETE /api/custom-wallpapers': { desc: '删除指定自定义壁纸', auth: '否', params: 'query：name', ret: 'ok' },
  'GET /api/we-wallpapers': { desc: '列出 Wallpaper Engine 库（含缓存）', auth: '否', params: 'query：refresh=1 可强刷', ret: 'items[]：id/title/type/size' },
  'POST /api/we-apply': { desc: '应用某个 WE 壁纸（场景/视频）', auth: '否', params: 'body：id / options', ret: 'ok / applied' },
  'POST /api/theme-bg': { desc: '设置主题背景（图片/视频/场景三选一）', auth: '否', params: 'body：type / id / opacity', ret: 'ok / applied' },
  'POST /api/inject': { desc: '手动重新注入页面 UI（注入丢失时的自救入口；需注入器在运行）', auth: '是', params: '—（无请求体）', ret: 'ok / injection{ok,at,attempts,lastError}' },
  'GET /api/mask': { desc: '读取当前蒙版浓度', auth: '否', params: '—', ret: 'opacity' },
  'POST /api/mask': { desc: '设置蒙版浓度（0–1）', auth: '否', params: 'body：opacity', ret: 'ok / opacity' },
  'GET /api/fonts': { desc: '枚举本机已装字体（面板字体页的数据源）', auth: '否', params: '—', ret: 'fonts[]' },
  'GET /api/update': { desc: '读缓存中的更新状态（**不发网络**，面板打开即用）', auth: '**是**', params: '—', ret: 'currentVersion / latest / hasUpdate / mustUpdate / canUpdate / notes' },
  'POST /api/update/check': { desc: '强制检查更新（访问 feed）', auth: '**是**', params: 'body：force=true', ret: '同 GET /api/update' },
  'POST /api/update/apply': { desc: '下载并应用更新（验签 → 备份 → 覆盖 → 重启）', auth: '**是**', params: 'body：expectVersion', ret: 'ok / version / from / backup / zipSha256 / restart' },
  'POST /api/update/rollback': { desc: '回滚到备份版本（受 minSupported 降级护栏限制）', auth: '**是**', params: 'body：version', ret: 'ok / version / written / removed' },
};

function parseRoutes() {
  const src = fs.readFileSync(ROUTES_SRC, 'utf8');
  const block = src.slice(src.indexOf('const ROUTES = ['), src.indexOf('];', src.indexOf('const ROUTES = [')));
  const out = [];
  const re = /\['(GET|POST|DELETE|PUT)',\s*'([^']+)'\]/g;
  let m;
  while ((m = re.exec(block))) out.push(m[1] + ' ' + m[2]);
  return out;
}

function build() {
  const routes = parseRoutes();
  const missing = routes.filter((r) => !CATALOG[r]);
  if (missing.length) {
    throw new Error('以下路由没有在 CATALOG 里写说明（新增接口必须补文档）：\n  ' + missing.join('\n  '));
  }
  const extra = Object.keys(CATALOG).filter((k) => !routes.includes(k));
  if (extra.length) {
    throw new Error('CATALOG 里有已不存在的路由（删接口时请同步删除说明）：\n  ' + extra.join('\n  '));
  }

  const lines = [];
  lines.push('# 接口清单 · workbuddy-wallpaper');
  lines.push('');
  lines.push('> **本文件由 `scripts/gen-api-docs.js` 从 `server/routes.js` 的 `ROUTES` 表生成，不要手改。**');
  lines.push('> `verify.js` 会比对生成结果与磁盘文件，不一致即失败（防止文档漂移）。');
  lines.push('>');
  lines.push('> 鉴权口径：标注 **是** 的接口为受保护路径，必须带请求头 `x-wbwp-token`；');
  lines.push('> 令牌在 `<数据目录>/.api-token`。同时校验 `Origin`：允许 `file://`（注入页）与同源，其余 403。');
  lines.push('> 服务只监听 `127.0.0.1`。');
  lines.push('');
  lines.push('| 方法 | 路径 | 说明 | 需令牌 | 参数 | 返回 |');
  lines.push('|---|---|---|---|---|---|');
  for (const r of routes) {
    const c = CATALOG[r];
    const [method, p] = r.split(' ');
    lines.push('| `' + method + '` | `' + p + '` | ' + c.desc + ' | ' + c.auth + ' | ' + c.params + ' | ' + c.ret + ' |');
  }
  lines.push('');
  lines.push('统计：共 **' + routes.length + '** 条 API 路由，其中受保护 **' +
    routes.filter((r) => CATALOG[r].auth === '**是**').length + '** 条。');
  lines.push('');
  lines.push('## 静态路径（不走鉴权）');
  lines.push('');
  lines.push('`/wallpapers/` · `/theme-media/` · `/wallpaper-engine/scene-live/` · `/wallpaper-engine/scene-files/`');
  lines.push('');
  return { text: lines.join('\n'), count: routes.length };
}

function main() {
  const checkOnly = process.argv.includes('--check');
  let built;
  try { built = build(); } catch (e) {
    process.stderr.write('✗ ' + e.message + '\n');
    process.exit(1);
  }
  if (checkOnly) {
    const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (cur !== built.text) {
      process.stderr.write('✗ docs/api/接口清单.md 与 routes.js 不一致（跑 node scripts/gen-api-docs.js 重新生成）\n');
      process.exit(1);
    }
    process.stdout.write('✓ 接口清单与 routes.js 一致（' + built.count + ' 条）\n');
    return;
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, built.text);
  process.stdout.write('✓ 已生成 docs/api/接口清单.md（' + built.count + ' 条路由）\n');
}

if (require.main === module) main();
module.exports = { build, parseRoutes, CATALOG, OUT };
