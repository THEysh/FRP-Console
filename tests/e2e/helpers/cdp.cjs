/* 通用 CDP 求值（可被其它脚本 require）：返回 { ok, value } 或抛错。 */
const http = require('http');

function httpJson(port, p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port, path: p }, (r) => {
      let b = '';
      r.on('data', (c) => { b += c; });
      r.on('end', () => res(JSON.parse(b)));
    }).on('error', rej);
  });
}

/* 主窗口优先：托盘面板 / devtools 也会出现在 /json/list 里，但它们随时会被关掉。 */
function pickPage(list) {
  const pages = (list || []).filter((x) => x.type === 'page' && x.webSocketDebuggerUrl);
  return pages.find((p) => /index\.html/.test(p.url || '')) || pages[0] || null;
}

async function evalOnce(port, expr, timeoutMs) {
  const list = await httpJson(port, '/json/list');
  const page = pickPage(list);
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const msg = await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('cdp timeout')), timeoutMs);
    ws.onmessage = (e) => {
      const d = JSON.parse(e.data);
      if (d.id === 1) { clearTimeout(timer); res(d); }
    };
    ws.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression: expr, awaitPromise: true, returnByValue: true },
    }));
  });
  try { ws.close(); } catch { /* 已经关了 */ }
  if (msg.error) throw new Error(`CDP eval 失败：${(msg.error && msg.error.message) || JSON.stringify(msg.error)}`);
  if (!msg.result) throw new Error('CDP eval 没有拿到结果（页面可能已关闭或导航中）');
  if (msg.result.exceptionDetails) {
    const ex = msg.result.exceptionDetails;
    throw new Error((ex.exception && (ex.exception.description || ex.exception.value)) || JSON.stringify(ex));
  }
  return msg.result.result.value;
}

function retryable(err) {
  return /Execution context was destroyed|Target closed|no page target|Session closed/i.test(String((err && err.message) || err));
}

async function evalIn(port, expr, timeoutMs = 120000) {
  let last = null;
  for (let i = 0; i < 3; i += 1) {
    try {
      return await evalOnce(port, expr, timeoutMs);
    } catch (e) {
      last = e;
      if (!retryable(e)) throw e;
      await new Promise((r) => setTimeout(r, 700));
    }
  }
  throw last;
}

async function waitReady(port, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try {
      await httpJson(port, '/json/list');
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 700));
    }
  }
  return false;
}

/* 重载渲染进程（改了 app.js / styles.css 之后不用重启 electron） */
async function reloadPage(port) {
  const list = await httpJson(port, '/json/list');
  const page = pickPage(list);
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.send(JSON.stringify({ id: 1, method: 'Page.reload', params: { ignoreCache: true } }));
  await new Promise((r) => setTimeout(r, 1500));
  ws.close();
  return true;
}

/* 把渲染进程的视口模拟成指定尺寸（用来测最小窗口下的布局，不改真实窗口）。 */
async function emulateViewport(port, width, height) {
  const list = await httpJson(port, '/json/list');
  const page = pickPage(list);
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const send = (id, method, params) => new Promise((res) => {
    const onMsg = (e) => { const d = JSON.parse(e.data); if (d.id === id) { ws.removeEventListener('message', onMsg); res(d); } };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
  if (width && height) await send(1, 'Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  else await send(1, 'Emulation.clearDeviceMetricsOverride', {});
  await new Promise((r) => setTimeout(r, 400));
  ws.close();
  return true;
}

module.exports = { evalIn, waitReady, httpJson, reloadPage, emulateViewport };
