'use strict';
/* 在渲染层执行一段表达式：node tools/cdp-eval.cjs "取到的表达式" */
const http = require('node:http');

const PORT = Number(process.env.CDP_PORT || 9333);
const expression = process.argv.slice(2).join(' ');
if (!expression) {
  console.error('用法: node tools/cdp-eval.cjs "<js 表达式>"');
  process.exit(2);
}

const getJson = (p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 2000 }, (res) => {
    let b = '';
    res.setEncoding('utf8');
    res.on('data', (c) => (b += c));
    res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
  }).on('error', reject);
});

(async () => {
  const list = await getJson('/json/list');
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let seq = 0;
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  });
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  const result = await new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, { resolve });
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });
  if (result.result && result.result.exceptionDetails) {
    const d = result.result.exceptionDetails;
    const desc = (d.exception && d.exception.description) || d.text;
    console.error('[异常]', desc);
    process.exitCode = 1;
  } else {
    const value = result.result && result.result.result ? result.result.result.value : undefined;
    console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  }
  ws.close();
  process.exit(0);
})().catch((e) => { console.error('[fail]', e.message); process.exit(1); });
