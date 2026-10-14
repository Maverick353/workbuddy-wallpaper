'use strict';
/**
 * wallpaper · 独立服务（standalone）
 * ------------------------------------------------------------------
 * 不依赖 WorkDaddy daemon，自己监听一个本地回环端口，方便：
 *   - 开发期直接调 API / 验证插件
 *   - 在没跑 WorkDaddy 时也能查看壁纸目录与 Wallpaper Engine 扫描结果
 *
 * 用法：
 *   node scripts/plugins/wallpaper/server/standalone.js --port 47841
 *   node scripts/plugins/wallpaper/server/standalone.js --port 47841 --data-dir "C:\\tmp\\wdtest"
 *
 * 安全：只监听 127.0.0.1，不做任何外网暴露，也不需要 token。
 * 注意：standalone 不注入 applyTheme，所以 /api/theme-bg 与 /api/we-apply 只会落盘、不会立即应用主题
 *       （applied:false, pending:true）——这正是无 CDP 时的预期行为。
 */

const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { createRoutes } = require('./routes.js');

function parseArgs(argv) {
  const out = { port: 47841, host: '127.0.0.1', dataDir: '', weRendererDir: '' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port' || arg === '-p') out.port = Number(argv[++i]) || out.port;
    else if (arg === '--host') out.host = argv[++i] || out.host;
    else if (arg === '--data-dir') out.dataDir = argv[++i] || '';
    else if (arg === '--we-renderer') out.weRendererDir = argv[++i] || '';
  }
  return out;
}

function defaultDataDir() {
  // 兜底目录（正常情况下 start-ui / server.js 都会显式传 dataDir 进来）。
  // 这里曾残留父项目的工作目录名，会导致裸跑 standalone 时把数据写进 WorkDaddy 的目录里。
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'workbuddy-wallpaper');
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'workbuddy-wallpaper');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'workbuddy-wallpaper');
}

function json(res, code, obj) {
  if (res.writableEnded) return;
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (_) { resolve({}); } });
  });
}

function start(options = {}) {
  const args = { ...parseArgs([]), ...options };
  const dataDir = args.dataDir || defaultDataDir();
  const weRendererDir = args.weRendererDir || path.join(dataDir, 'we-renderer');
  const ctx = {
    json,
    readBody,
    log: typeof options.log === 'function' ? options.log : (...a) => process.stdout.write('[wallpaper] ' + a.join(' ') + '\n'),
    dataDir,
    weRendererDir,
    applyTheme: typeof options.applyTheme === 'function' ? options.applyTheme : null,
    version: options.version || 'standalone',
    apiToken: '',
  };
  const router = createRoutes(ctx);

  const server = http.createServer((req, res) => {
    // CORS：独立服务被 file:// 宿主页面（Electron 渲染页）直接 fetch —— 必须放行跨源，
    // 否则 POST JSON 的预检（OPTIONS）会失败、应用类接口静默无效（实测踩过）。
    // 安全性：只监听回环 + 无凭据，本机可信场景。
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    let url;
    try { url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`); } catch (_) {
      res.writeHead(400); return res.end('bad request');
    }
    const p = url.pathname;
    if (p === '/') {
      const h = router.health().body;
      return json(res, 200, h);
    }
    if (p === '/api/shutdown' && (req.method === 'POST' || req.method === 'GET')) {
      // 主动关闭（面板「关闭壁纸」按钮用）：写 .stopped 标志 → companion 据此不自动重启
      // （区分「用户主动关」与「崩溃」），然后优雅退出。
      try { fs.writeFileSync(path.join(dataDir, '.stopped'), String(Date.now())); } catch (_) {}
      json(res, 200, { ok: true, stopping: true });
      setTimeout(() => { try { server.close(); } catch (_) {} process.exit(0); }, 150);
      return;
    }
    if (p.startsWith('/api/') && router.isApiPath(p)) return router.handle(req, res, url, p);
    if (router.isStaticPath(req)) return router.serveStatic(req, res, url);
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('not found');
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(args.port, args.host, () => {
      const address = server.address();
      resolve({ server, port: address.port, host: address.host, dataDir, url: `http://${args.host}:${address.port}/` });
    });
  });
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  start(args).then(({ url, dataDir, port }) => {
    process.stdout.write(`wallpaper standalone 已启动：${url}\n数据目录：${dataDir}\n健康检查：${url}api/wallpaper/health\n`);
  }).catch((error) => {
    process.stderr.write(`启动失败：${error.message}\n`);
    process.exit(1);
  });
}

module.exports = { start, parseArgs, defaultDataDir };
