'use strict';
/*
 * 元素截图：把某个选择器对应的区域单独截下来（先滚到可视区再截）。
 * 用法：node tools/cdp-shot.cjs "<css选择器>" [输出路径]
 *      node tools/cdp-shot.cjs --full [输出路径]      整页
 */
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const PORT = Number(process.env.CDP_PORT || 9333);
const SHOTS = path.join(__dirname, '..', '.shots');
const target = process.argv[2];
const out = process.argv[3] || path.join(SHOTS, 'shot.png');

if (!target) {
  console.error('用法: node tools/cdp-shot.cjs "<selector>" [out.png] | --full [out.png]');
  process.exit(2);
}

const getJson = (p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 3000 }, (res) => {
    let b = '';
    res.setEncoding('utf8');
    res.on('data', (c) => (b += c));
    res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
  }).on('error', reject);
});

(async () => {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const list = await getJson('/json/list');
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('没有可调试页面');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let seq = 0;
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send('Page.enable');
  await send('Runtime.enable');

  let clip;
  if (target !== '--full') {
    const expr = `(() => {
      const el = document.querySelector(${JSON.stringify(target)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: Math.max(0, r.x - 8), y: Math.max(0, r.y - 8), width: Math.min(r.width + 16, window.innerWidth), height: Math.min(r.height + 16, window.innerHeight), scale: 2 };
    })()`;
    const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    clip = res.result && res.result.value;
    if (!clip) throw new Error(`找不到元素：${target}`);
    await new Promise((r) => setTimeout(r, 250));
    // scrollIntoView 后重新取一次位置
    const res2 = await send('Runtime.evaluate', { expression: expr.replace('el.scrollIntoView({ block: \'center\' });', ''), returnByValue: true });
    if (res2.result && res2.result.value) clip = res2.result.value;
  }

  const shot = await send('Page.captureScreenshot', clip ? { format: 'png', clip, captureBeyondViewport: false } : { format: 'png' });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('[shot]', out, clip ? JSON.stringify(clip) : 'full');
  ws.close();
  process.exit(0);
})().catch((e) => { console.error('[fail]', e.message); process.exit(1); });
