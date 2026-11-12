'use strict';
/* 用 CDP 截取窗口右上角，确认三个窗口按钮的图标真的画出来了。 */
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const PORT = Number(process.env.CDP_PORT || 9333);
// 默认落在项目内的 .shots/（已 gitignore）。别用 /tmp：在 Windows 上 Node 会把它
// 解析成当前盘符根目录，截图会散落到 F:\tmp。
const SHOTS = path.join(__dirname, '..', '.shots');
const OUT = process.env.OUT || path.join(SHOTS, 'win-buttons.png');

function getJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path, timeout: 2000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitTarget() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await getJson('/json/list');
      const page = (list || []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* 还没起来 */ }
    await sleep(500);
  }
  throw new Error('等不到可调试的页面');
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const page = await waitTarget();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`${method} 超时`)); }
    }, 15000);
  });

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (!msg.id || !pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  });

  await send('Page.enable');
  await send('Runtime.enable');

  // 等 UI 完成初始化
  for (let i = 0; i < 40; i += 1) {
    const probe = await send('Runtime.evaluate', {
      expression: 'document.querySelectorAll(".nav-item").length',
      returnByValue: true,
    });
    if (probe.result && probe.result.value >= 6) break;
    await sleep(500);
  }

  const report = await send('Runtime.evaluate', {
    expression: `(() => {
      const out = {};
      out.visibility = document.visibilityState;
      for (const id of ['win-min', 'win-max', 'win-close']) {
        const btn = document.getElementById(id);
        if (!btn) { out[id] = 'missing'; continue; }
        const r = btn.getBoundingClientRect();
        const svg = btn.querySelector('svg:not([style*="display: none"])');
        const box = svg ? svg.getBoundingClientRect() : null;
        const cs = svg ? getComputedStyle(svg) : null;
        out[id] = {
          btn: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
          svgBox: box ? [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)] : null,
          opacity: cs ? cs.opacity : null,
          visible: btn.offsetParent !== null && (cs ? cs.visibility !== 'hidden' && cs.display !== 'none' : false),
          isMax: btn.classList.contains('is-max'),
          title: btn.title,
        };
      }
      const anySvg = document.querySelector('#win-close svg path');
      out.strokeColor = anySvg ? getComputedStyle(anySvg).stroke : null;
      out.viewport = [window.innerWidth, window.innerHeight];
      return JSON.stringify(out);
    })()`,
    returnByValue: true,
  });
  console.log('[probe]', report.result.value);

  const size = JSON.parse(report.result.value).viewport;
  const clip = { x: Math.max(0, size[0] - 240), y: 0, width: 240, height: 52, scale: 3 };
  const shot = await send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: false });
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('[shot]', OUT);

  if (process.env.CLICK_MAX === '1') {
    await send('Runtime.evaluate', { expression: 'document.getElementById("win-max").click()' });
    await sleep(1500);
    const after = await send('Runtime.evaluate', {
      expression: `(() => {
        const btn = document.getElementById('win-max');
        const shown = [...btn.querySelectorAll('svg')].filter((s) => getComputedStyle(s).display !== 'none').length;
        return JSON.stringify({ isMax: btn.classList.contains('is-max'), title: btn.title, 显示的字形数: shown, 窗口宽: window.innerWidth });
      })()`,
      returnByValue: true,
    });
    console.log('[after-max]', after.result.value);
    const size2 = JSON.parse(after.result.value);
    const shot2 = await send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: Math.max(0, size2.窗口宽 - 240), y: 0, width: 240, height: 52, scale: 3 },
      captureBeyondViewport: false,
    });
    const out2 = process.env.OUT2 || path.join(SHOTS, 'win-buttons-max.png');
    fs.writeFileSync(out2, Buffer.from(shot2.data, 'base64'));
    console.log('[shot2]', out2);
  }

  ws.close();
  process.exit(0);
}

main().catch((e) => {
  console.error('[fail]', e.message);
  process.exit(1);
});
