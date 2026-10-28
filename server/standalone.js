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
 * 安全（P1-3 起）：只监听 127.0.0.1，**并且对更新类 / 关机类接口做「Origin + 本地令牌」双校验**。
 *   原先是 `Access-Control-Allow-Origin: '*'` + 全部路由无鉴权 —— 你随便逛个网页，它就能对你的
 *   127.0.0.1 发请求触发一次更新、或者把壁纸关掉。现在：
 *   · Origin 只回显受信来源（注入面板跑在 file://，Chromium 发的是字面量 "null"）；
 *   · 受保护路径必须带 `x-wbwp-token`，令牌在 `<dataDir>/.api-token`，经注入 payload 送到面板。
 *   · Origin 可伪造/可缺失，所以它只是纵深防御，真正的门是令牌。
 * 注意：standalone 不注入 applyTheme，所以 /api/theme-bg 与 /api/we-apply 只会落盘、不会立即应用主题
 *       （applied:false, pending:true）——这正是无 CDP 时的预期行为。
 */

const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createRoutes } = require('./routes.js');

// ── P1-3：受保护路径与令牌 ──────────────────────────────────────────────────
/** 需要鉴权的路径前缀（更新类 + 关机类）。其余接口暂不覆盖，见已知问题 KN-2。 */
const PROTECTED_PREFIXES = ['/api/update', '/api/shutdown', '/api/inject', '/api/pause'];
const TOKEN_FILE = '.api-token';

function isProtectedPath(p) {
  return PROTECTED_PREFIXES.some((x) => p === x || p.startsWith(x + '/'));
}

function tokenMatches(got, want) {
  if (!got || !want || got.length !== want.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want)); } catch (_) { return false; }
}

/**
 * 读取或生成本地令牌（32 字节 hex）。
 * 为什么**持久化**而不是每次启动随机生成：面板是注入进页面的，注入不会在服务重启时自动刷新；
 * 每次换令牌 ⇒ 一重启旧页面全部 401，用户看到的是"面板全是错误"。
 */
function loadOrCreateToken(dataDir) {
  const p = path.join(dataDir, TOKEN_FILE);
  try {
    const t = String(fs.readFileSync(p, 'utf8') || '').trim();
    if (t.length >= 32) return t;
  } catch (_) {}
  const t = crypto.randomBytes(32).toString('hex');
  try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(p, t); } catch (_) {}
  return t;
}

/**
 * 这个 Origin 是否可放行。
 * · 无 Origin（curl / 本机脚本）→ 放行，交给令牌拦；
 * · `null`（file:// 页面的跨源请求）→ 放行；
 * · 与服务自身同源 → 放行；
 * · 其它（浏览器里的任意 https 页面）→ **拒**。
 */
function originAllowed(origin, hostHeader) {
  if (!origin) return true;
  const o = String(origin).toLowerCase();
  if (o === 'null') return true;
  const host = String(hostHeader || '').toLowerCase();
  return o === 'http://' + host || o === 'https://' + host;
}

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
  const apiToken = loadOrCreateToken(dataDir);
  const ctx = {
    json,
    readBody,
    log: typeof options.log === 'function' ? options.log : (...a) => process.stdout.write('[wallpaper] ' + a.join(' ') + '\n'),
    dataDir,
    weRendererDir,
    applyTheme: typeof options.applyTheme === 'function' ? options.applyTheme : null,
    // 注入可见性：只有 start-ui 会传（独立服务没有注入能力，两个字段为 null，health.injection 报 null）
    injection: options.injection || null,
    reinject: typeof options.reinject === 'function' ? options.reinject : null,
    // 暂停/恢复壁纸（可逆）。与 shutdown 的 `.stopped`（不可逆）是两条独立路径。
    setPaused: typeof options.setPaused === 'function' ? options.setPaused : null,
    version: options.version || 'standalone',
    apiToken,
  };
  const router = createRoutes(ctx);

  const server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`); } catch (_) {
      res.writeHead(400); return res.end('bad request');
    }
    const p = url.pathname;
    const origin = req.headers.origin;
    const allowed = originAllowed(origin, req.headers.host);

    // CORS（P1-3）：只对受信来源回显，不再无条件 '*'。
    // 原始动机仍然成立：面板跑在 file:// 宿主页里，跨源 fetch 必须放行，否则 POST JSON 的预检就失败。
    if (allowed) {
      res.setHeader('Access-Control-Allow-Origin', origin || '*');
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'content-type,x-wbwp-token');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      if (!allowed) { res.writeHead(403); return res.end(); }
      res.writeHead(204); return res.end();
    }

    // 受保护路径：Origin 挡"浏览器里的任意网页"，令牌挡"本机任意进程"（Origin 可伪造/可缺失）
    if (isProtectedPath(p)) {
      if (!allowed) return json(res, 403, { ok: false, error: 'forbidden origin', origin: String(origin) });
      const got = String(req.headers['x-wbwp-token'] || '');
      if (!tokenMatches(got, apiToken)) {
        return json(res, 401, {
          ok: false,
          error: 'missing or invalid token',
          hint: '受保护接口需带 X-WBWP-Token；令牌见数据目录的 ' + TOKEN_FILE,
        });
      }
    }

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
      resolve({ server, port: address.port, host: address.host, dataDir, apiToken, url: `http://${args.host}:${address.port}/` });
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
