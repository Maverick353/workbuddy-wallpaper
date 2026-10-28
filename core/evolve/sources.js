'use strict';
/**
 * 自我进化 · 采集层
 *
 * 职责：把「配置里声明的源」变成统一的条目数组。**只读，不写远端**。
 * 统一条目形状：{ id, title, url, text, ts, source, sourceKind }
 *
 * 三条硬约束（都是踩过的坑）：
 *   1. 零依赖 —— 只用 node 内置 https/http，不引 undici/axios。
 *   2. 本机 `curl`/`git` 都走本地代理，Node 的 https 不认 HTTPS_PROXY
 *      ⇒ 自动读 HTTPS_PROXY 并手写 CONNECT 隧道，否则本机永远采不到 GitHub。
 *   3. 单源失败**不得**拖垮整轮：失败写 cache 兜底 + 记进 sourceStatus，
 *      由上层在提案里明说「本轮 N 个源不可达」。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const tls = require('tls');
const journal = require('./journal');

const UA = 'workbuddy-wallpaper-evolve/1.0 (+https://github.com/Maverick353/workbuddy-wallpaper)';

function proxyUrl() {
  return process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '';
}

/** 通过 HTTP 代理建 CONNECT 隧道，返回一条已握手的 TLS socket。 */
function tunnel(proxy, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(proxy); } catch (e) { return reject(new Error('代理地址非法: ' + proxy)); }
    const req = http.request({
      host: u.hostname,
      port: Number(u.port) || 80,
      method: 'CONNECT',
      path: host + ':' + port,
      headers: { host: host + ':' + port, 'user-agent': UA },
      timeout: timeoutMs,
      ...(u.username ? { auth: decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password || '') } : {}),
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); return reject(new Error('代理 CONNECT 返回 ' + res.statusCode)); }
      resolve(tls.connect({ socket, servername: host }));
    });
    req.on('timeout', () => req.destroy(new Error('代理连接超时')));
    req.on('error', reject);
    req.end();
  });
}

/** GET 文本。返回 { status, text }；超过 maxBytes 直接中止（防 OOM）。 */
async function httpGet(url, opt) {
  const o = Object.assign({ timeoutMs: 8000, maxBytes: 2 * 1024 * 1024, useProxy: true, redirects: 1 }, opt || {});
  const u = new URL(url);
  const isHttps = u.protocol === 'https:';
  const proxy = o.useProxy ? proxyUrl() : '';
  let socket = null;
  if (isHttps && proxy) socket = await tunnel(proxy, u.hostname, Number(u.port) || 443, o.timeoutMs);

  return new Promise((resolve, reject) => {
    const mod = isHttps ? https : http;
    const req = mod.request({
      host: u.hostname,
      port: Number(u.port) || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'user-agent': UA, accept: 'application/json, text/xml, text/html;q=0.8, */*;q=0.5' },
      timeout: o.timeoutMs,
      agent: false,
      ...(socket ? { createConnection: () => socket } : {}),
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && o.redirects > 0) {
        res.resume();
        socket && socket.destroy();
        const next = new URL(res.headers.location, url).toString();
        return resolve(httpGet(next, Object.assign({}, o, { redirects: o.redirects - 1 })));
      }
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        text += c;
        if (text.length > o.maxBytes) { req.destroy(new Error('响应超过 ' + o.maxBytes + ' 字节')); }
      });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('timeout', () => req.destroy(new Error('请求超时 ' + o.timeoutMs + 'ms')));
    req.on('error', reject);
    req.end();
  });
}

async function getJson(url, opt) {
  const r = await httpGet(url, opt);
  if (r.status >= 400) throw new Error('HTTP ' + r.status + ' ' + url.replace(/\?.*/, ''));
  try { return JSON.parse(r.text); } catch (_) { throw new Error('响应不是 JSON: ' + url.replace(/\?.*/, '')); }
}

const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n || 1200);

// ── 各源适配器：统一返回 items[] ─────────────────────────────────────────────
const ADAPTERS = {
  async 'github-releases'(src, o) {
    const d = await getJson('https://api.github.com/repos/' + src.repo + '/releases?per_page=' + (src.perPage || 5), o);
    return (Array.isArray(d) ? d : []).map((r) => ({
      id: 'gh-rel-' + (r.id || r.tag_name),
      title: clip((r.tag_name || '') + ' ' + (r.name || ''), 160),
      url: r.html_url || '',
      text: clip(r.body, 1500),
      ts: Date.parse(r.published_at || r.created_at) || 0,
      sourceKind: 'repo-release',
    }));
  },

  async 'github-issues'(src, o) {
    const since = new Date(Date.now() - (src.windowDays || 30) * 86400000).toISOString();
    const d = await getJson('https://api.github.com/repos/' + src.repo + '/issues?state=all&sort=updated&per_page=' +
      (src.perPage || 20) + '&since=' + encodeURIComponent(since), o);
    return (Array.isArray(d) ? d : []).filter((i) => !i.pull_request).map((i) => ({
      id: 'gh-iss-' + i.number,
      title: clip(i.title, 160),
      url: i.html_url || '',
      text: clip(i.body, 1500),
      ts: Date.parse(i.updated_at || i.created_at) || 0,
      sourceKind: 'repo-issue',
      labels: (i.labels || []).map((l) => (typeof l === 'string' ? l : l.name)),
      comments: i.comments || 0,
    }));
  },

  async hn(src, o) {
    const d = await getJson('https://hn.algolia.com/api/v1/search?query=' + encodeURIComponent(src.query || '') +
      '&tags=story&hitsPerPage=' + (src.perPage || 10), o);
    return ((d && d.hits) || []).map((h) => ({
      id: 'hn-' + h.objectID,
      title: clip(h.title || h.story_title, 160),
      url: h.url || ('https://news.ycombinator.com/item?id=' + h.objectID),
      text: clip((h.title || '') + ' ' + (h.story_text || ''), 800),
      ts: (h.created_at_i || 0) * 1000,
      sourceKind: 'hn',
      points: h.points || 0,
    }));
  },

  async rss(src, o) {
    const r = await httpGet(src.url, o);
    if (r.status >= 400) throw new Error('HTTP ' + r.status);
    const out = [];
    const items = r.text.match(/<item[\s\S]*?<\/item>/gi) || r.text.match(/<entry[\s\S]*?<\/entry>/gi) || [];
    for (const it of items.slice(0, src.perPage || 10)) {
      const pick = (tag) => {
        const m = it.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'i'));
        return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, ' ').trim() : '';
      };
      const link = (it.match(/<link[^>]*href="([^"]+)"/i) || it.match(/<link>([\s\S]*?)<\/link>/i) || [])[1] || src.url;
      const title = pick('title');
      out.push({
        id: 'rss-' + Buffer.from(title + link).toString('base64').slice(0, 24),
        title: clip(title, 160),
        url: clip(link, 400),
        text: clip(pick('description') || pick('summary') || pick('content'), 1200),
        ts: Date.parse(pick('pubDate') || pick('updated')) || 0,
        sourceKind: 'rss',
      });
    }
    return out;
  },

  /** 本地文件源：给 verify.js 与离线演练用（不联网 ⇒ CI 可断言） */
  async file(src, o) {
    const p = path.isAbsolute(src.path) ? src.path : path.join(o.root, src.path);
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    return (Array.isArray(d) ? d : d.items || []).map((it, i) => ({
      id: it.id || 'file-' + i,
      title: clip(it.title, 160),
      url: it.url || '',
      text: clip(it.text || it.body, 1500),
      ts: it.ts || Date.parse(it.date || '') || 0,
      sourceKind: it.sourceKind || 'file',
      labels: it.labels || [],
    }));
  },
};

function cacheFile(root, id) { return path.join(journal.dir(root), 'cache', id + '.json'); }

function readCache(root, id) {
  try { return JSON.parse(fs.readFileSync(cacheFile(root, id), 'utf8')); } catch (_) { return null; }
}

function writeCache(root, id, items) {
  journal.ensure(root);
  fs.writeFileSync(cacheFile(root, id), JSON.stringify({ at: Date.now(), items: items }, null, 0));
}

/**
 * 采集一轮。
 * @returns {{ items:Array, status:Array<{id,ok,count,ms,error,cached}> }}
 * 任何单源异常都被吞进 status，绝不 throw。
 */
async function collect(cfg, opt) {
  const o = Object.assign({ root: process.cwd(), timeoutMs: 8000, proxy: true, offline: false, tier: 'all' }, opt || {});
  const items = [];
  const status = [];
  for (const src of cfg.sources || []) {
    if (o.tier === 'cheap' && src.tier === 'deep') continue;
    const t0 = Date.now();
    try {
      if (o.offline) throw new Error('--offline：跳过联网');
      const fn = ADAPTERS[src.type];
      if (!fn) throw new Error('未知源类型 ' + src.type);
      const got = await fn(src, { root: o.root, timeoutMs: o.timeoutMs, useProxy: o.proxy, maxBytes: 2 * 1024 * 1024 });
      for (const it of got) {
        it.source = src.id;
        // 标记"自己的仓库"：自家发版记录不是外部情报，rank() 会据此剔除（安全公告除外）
        if (cfg.self && src.repo && src.repo === cfg.self) it.own = true;
        items.push(it);
      }
      if (src.type !== 'file') writeCache(o.root, src.id, got);
      status.push({ id: src.id, ok: true, count: got.length, ms: Date.now() - t0 });
    } catch (e) {
      const cache = src.type === 'file' ? null : readCache(o.root, src.id);
      if (cache && cache.items && cache.items.length) {
        for (const it of cache.items) { it.source = src.id; it.fromCache = true; items.push(it); }
        status.push({ id: src.id, ok: false, cached: true, count: cache.items.length, ms: Date.now() - t0, error: e.message, cacheAgeH: Math.round((Date.now() - cache.at) / 3600000) });
      } else {
        status.push({ id: src.id, ok: false, cached: false, count: 0, ms: Date.now() - t0, error: e.message });
      }
    }
  }
  return { items, status };
}

module.exports = { collect, httpGet, getJson, ADAPTERS, readCache, writeCache };
