// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
/**
 * cdp.js · 零依赖 CDP 客户端
 * ------------------------------------------------------------------
 * 端口自探测（9222 起依次试探 /json/version），目标发现，Runtime.evaluate。
 * **不读任何宿主应用的配置文件** —— 保持技能自身的独立性。
 *
 * 断线语义（2026-10 修复「服务进程死掉/自愈失效」的关键）：
 *   ws 的 close / error 一律视为连接终结：pend 里挂起的请求全部以错误结束
 *   （调用方 session.ev 会立刻 catch → 走重连），而不是永远悬挂。
 *   同时通过 hooks.onClose/onError 通知调用方「立即重连」，不必等轮询。
 */
const http = require('http');

const CDP_CANDIDATES = [9222, 9223, 9224, 9225, 9226, 9230, 9333];

const httpGetJson = (url) => new Promise((resolve, reject) => {
  const req = http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); });
  req.on('error', reject);
  req.setTimeout(1500, () => req.destroy(new Error('timeout')));
});

/** 找到第一个可用的 CDP 端口（找不到返回 null）。 */
async function findCdp() {
  for (const port of CDP_CANDIDATES) {
    try {
      const v = await httpGetJson('http://127.0.0.1:' + port + '/json/version');
      if (v && v.webSocketDebuggerUrl) return port;
    } catch (_) { /* 试下一个 */ }
  }
  return null;
}

/**
 * 连接一个 CDP WebSocket，返回 { ev(expr), call(method, params), close(), alive }。
 * @param {string} wsUrl 页面 target 的 webSocketDebuggerUrl
 * @param {{ onClose?: Function, onError?: Function }} [hooks]
 *   onClose / onError：ws 断开/出错时同步回调（宿主页面 reload、target 销毁等），
 *   供调用方立即触发重连补注入。回调抛错被吞掉，不影响连接清理。
 */
function connect(wsUrl, hooks) {
  const h = hooks || {};
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0; const pend = new Map();
    let alive = true;   // false = 连接已终结：挂起请求全部失败、新请求直接拒绝

    /** 连接终结（幂等）：pend 全部以错误结束，调用方立刻 catch 走重连，不悬挂。 */
    const failAll = (err) => {
      if (!alive) return;
      alive = false;
      const e = err instanceof Error ? err : new Error('CDP 连接已断开');
      pend.forEach((settle) => { try { settle({ fail: e }); } catch (_) {} });
      pend.clear();
    };

    ws.addEventListener('message', (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (_) { return; }   // 非 JSON 帧忽略（防未捕获异常打死进程）
      if (m && m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    });

    /** 统一出口：断线/页面异常 → reject；成功 → 按 ev/call 语义取值。
     *  CDP 应答形状：{ id, result: { result: { value }, exceptionDetails? } }
     *  ⇒ ev 取 m.result.result.value；call 回完整 m.result。 */
    const settle = (m, isCall, res, rej) => {
      if (m && m.fail) return rej(m.fail);
      const r = m && m.result;
      if (!isCall && r && r.exceptionDetails) {
        const d = r.exceptionDetails;
        return rej(new Error('页面求值异常: ' + ((((d.exception || {}).description) || d.text) || '').slice(0, 160)));
      }
      res(isCall ? r : (r && r.result ? r.result.value : undefined));
    };

    ws.addEventListener('open', () => resolve({
      /** 页面求值：exceptionDetails → reject；连接已断 → 立刻 reject（不发送、不悬挂）。 */
      ev: (expression) => new Promise((res, rej) => {
        if (!alive) return rej(new Error('CDP 连接已断开（未发送）'));
        const i = ++id;
        pend.set(i, (m) => settle(m, false, res, rej));
        try { ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, returnByValue: true } })); }
        catch (e) { pend.delete(i); rej(e); }
      }),
      /** 任意 CDP 方法（Page.reload 等）：语义同 ev，异常/断线同样 reject。 */
      call: (method, params) => new Promise((res, rej) => {
        if (!alive) return rej(new Error('CDP 连接已断开（未发送）'));
        const i = ++id;
        pend.set(i, (m) => settle(m, true, res, rej));
        try { ws.send(JSON.stringify({ id: i, method, params: params || {} })); }
        catch (e) { pend.delete(i); rej(e); }
      }),
      close: () => { try { ws.close(); } catch (_) {} },
      get alive() { return alive; },
    }));

    // open 前：连接失败 → reject（hostSession 抛出，启动方按启动失败处理）；
    // open 后：传输错误 → failAll 断掉挂起请求 + 回调调用方（reject 此时是已 settle 的 no-op）。
    ws.addEventListener('error', () => {
      failAll(new Error('CDP WebSocket 错误'));
      if (h.onError) { try { h.onError(); } catch (_) {} }
      reject(new Error('WebSocket 连接失败'));
    });

    // 页面 reload / target 销毁 → ws 关闭：同上（error 与 close 常成对出现，failAll 幂等）。
    ws.addEventListener('close', () => {
      failAll(new Error('CDP 连接已关闭'));
      if (h.onClose) { try { h.onClose(); } catch (_) {} }
    });
  });
}

/** 找宿主页面（优先 app.asar/renderer 那个渲染进程）并连上。
 *  hooks 透传给 connect（见其注释）；stop-ui.js 不传，行为与旧版一致。 */
async function hostSession(port, hooks) {
  const list = await httpGetJson('http://127.0.0.1:' + port + '/json/list');
  const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  const host = pages.find((t) => /app\.asar\/renderer|index\.html/.test(String(t.url))) || pages[0];
  if (!host) throw new Error('没找到可注入的页面');
  return { session: await connect(host.webSocketDebuggerUrl, hooks), target: host };
}

module.exports = { CDP_CANDIDATES, findCdp, connect, hostSession, httpGetJson };
