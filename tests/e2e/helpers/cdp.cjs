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

async function evalIn(port, expr, timeoutMs = 120000) {
  const list = await httpJson(port, '/json/list');
  const page = list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
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
  ws.close();
  if (msg.result && msg.result.exceptionDetails) {
    const ex = msg.result.exceptionDetails;
    throw new Error((ex.exception && (ex.exception.description || ex.exception.value)) || JSON.stringify(ex));
  }
  return msg.result.result.value;
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
  const page = list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.send(JSON.stringify({ id: 1, method: 'Page.reload', params: { ignoreCache: true } }));
  await new Promise((r) => setTimeout(r, 1500));
  ws.close();
  return true;
}

module.exports = { evalIn, waitReady, httpJson, reloadPage };
