const path = require('path');

/* 用 Electron 的 Chromium 网络栈做一次 GET，专门当「node 的 https 探测被重置」时的兜底。
 *
 * 为什么需要它：有些云厂商会对未备案的域名在 443 上做 TLS 层拦截——不是返回备案页，
 * 而是直接 RST。实测同一台机器、同一个域名：Chrome（Chromium 的 ClientHello）能正常打开，
 * 而 node 的 https（BoringSSL）、PowerShell 的 schannel 都在握手阶段被 reset。
 * 健康检查如果只认 node 这一条路，就会出现「浏览器明明能开，面板却说公网不可达」。
 *
 * 只做兜底：node 探测成功时不走这里，避免无谓地启用 Chromium 的网络栈。
 */
let cachedNet;
function chromiumNet() {
  if (cachedNet !== undefined) return cachedNet;
  try {
    // 只在 Electron 主进程里有；纯 node 环境（单测、脚本）下返回 null。
    const electron = require('electron');
    cachedNet = electron && electron.net ? electron.net : null;
  } catch {
    cachedNet = null;
  }
  return cachedNet;
}

function isAvailable() {
  return !!chromiumNet();
}

/* 返回结构与 util.httpProbe 对齐，另加 via:'browser' 便于上层标注来源。 */
function probeWithChromium(url, timeout = 6000, extraHeaders = null) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return Promise.resolve({ ok: false, status: 0, ms: 0, error: 'URL 无效', via: 'browser' });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return Promise.resolve({ ok: false, status: 0, ms: 0, error: '仅支持 HTTP/HTTPS', via: 'browser' });
  }
  const net = chromiumNet();
  if (!net) {
    return Promise.resolve({ ok: false, status: 0, ms: 0, error: 'Chromium 网络栈不可用', unavailable: true, via: 'browser' });
  }
  const started = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve({ url, ms: Date.now() - started, via: 'browser', ...value });
    };
    let req;
    try {
      /* redirect 必须用 follow：Chromium 的 net.request 在 'manual' 模式下不会发
       * 'redirect' 事件给调用方，请求会直接以 "Redirect was cancelled" 失败——
       * 而这类站点（Jellyfin 等）根路径就是 302 到 /web/，用 manual 等于永远判不通。 */
      req = net.request({ method: 'GET', url, redirect: 'follow' });
    } catch (err) {
      done({ ok: false, status: 0, error: String((err && err.message) || err) });
      return;
    }
    const timer = setTimeout(() => {
      try { req.abort(); } catch { /* ignore */ }
      done({ ok: false, status: 0, error: 'TIMEOUT' });
    }, timeout);
    req.on('response', (res) => {
      let body = '';
      res.on('data', (chunk) => { if (body.length < 64 * 1024) body += chunk.toString('utf8'); });
      res.on('end', () => {
        clearTimeout(timer);
        const status = res.statusCode || 0;
        const titleMatch = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        const serverHeader = String(res.headers.server || '');
        const frpsMiss = status === 404 && /<?!?DOCTYPE html/i.test(body) && /<title>Not Found<\/title>/i.test(body);
        const icpBlocked = status === 403 && (/Non-compliance ICP Filing/i.test(body) || /beaver/i.test(serverHeader));
        done({
          ok: status > 0 && status < 500 && !frpsMiss && !icpBlocked,
          status,
          title: titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim().slice(0, 120) : '',
          location: String(res.headers.location || ''),
          blocked: icpBlocked ? 'icp' : null,
          error: frpsMiss
            ? 'frps 上没有匹配到该域名（代理未注册或域名不一致）'
            : (icpBlocked ? '域名未备案，被云厂商在 HTTP 端口上拦截（返回的是备案提示页）' : null),
        });
      });
      res.on('error', (err) => {
        clearTimeout(timer);
        done({ ok: false, status: 0, error: String((err && err.message) || err) });
      });
    });
    req.on('error', (err) => {
      clearTimeout(timer);
      done({ ok: false, status: 0, error: String((err && err.message) || err) });
    });
    if (extraHeaders) {
      for (const [k, v] of Object.entries(extraHeaders)) {
        try { req.setHeader(k, v); } catch { /* ignore */ }
      }
    }
    req.end();
  });
}

module.exports = { probeWithChromium, isAvailable, chromiumNet };
