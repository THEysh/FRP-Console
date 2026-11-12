'use strict';
/*
 * 逐页 UI 自检：
 *  1) 收集控制台报错 / 未捕获异常 / CSP 拦截
 *  2) 依次切到每个页面，检查横向溢出、元素越界、关键节点是否存在
 *  3) 每页截一张图，便于肉眼复核
 * 只读：不会点保存、不会启停隧道。
 */
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const PORT = Number(process.env.CDP_PORT || 9333);
// 默认落在项目内的 .shots/（已 gitignore）。别用 /tmp：Windows 上 Node 会把它
// 解析成当前盘符根目录，截图会散落到 F://tmp。
const OUT_DIR = process.env.OUT_DIR || path.join(__dirname, '..', '.shots');
const VIEWS = ['overview', 'proxies', 'discovery', 'server', 'logs', 'settings'];

function getJson(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 2000 }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (b += c));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const list = await getJson('/json/list');
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('没有可调试页面');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  const problems = [];

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`${method} timeout`)); } }, 20000);
  });

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      problems.push(`console.error: ${msg.params.args.map((a) => a.value || a.description || a.type).join(' ')}`);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      problems.push(`未捕获异常: ${d.text} ${d.exception && d.exception.description ? d.exception.description.split('\n')[0] : ''}`);
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      problems.push(`日志错误(${msg.params.entry.source}): ${msg.params.entry.text}`);
    }
  });

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`求值失败: ${r.exceptionDetails.text}`);
    return r.result.value;
  };

  // 等首页完成渲染
  for (let i = 0; i < 40; i += 1) {
    if ((await evaluate('document.querySelectorAll(".nav-item").length')) >= 6) break;
    await sleep(500);
  }

  for (const view of VIEWS) {
    await evaluate(`(() => {
      const btn = document.querySelector('.nav-item[data-view="${view}"]');
      if (btn) btn.click();
      return true;
    })()`);
    await sleep(900);

    const info = await evaluate(`(() => {
      const v = document.querySelector('#view .view');
      const doc = document.documentElement;
      const overflowX = doc.scrollWidth - doc.clientWidth;
      const out = [];
      if (v) {
        const vw = window.innerWidth;
        for (const el of v.querySelectorAll('*')) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          if (r.right > vw + 1) {
            out.push((el.className && String(el.className).slice(0, 40)) || el.tagName);
            if (out.length >= 5) break;
          }
        }
      }
      const visible = (sel) => { const e = document.querySelector(sel); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      return JSON.stringify({
        view: ${JSON.stringify(view)},
        nodes: v ? v.querySelectorAll('*').length : 0,
        overflowX,
        beyondViewport: out,
        topbar: visible('.titlebar'),
        sidebar: visible('.sidebar'),
        winBtns: visible('#win-min') && visible('#win-max') && visible('#win-close'),
        modal: !!document.querySelector('.modal-root .modal'),
        toasts: document.querySelectorAll('.toast').length,
      });
    })()`);
    console.log('[view]', info);

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT_DIR, `${view}.png`), Buffer.from(shot.data, 'base64'));
  }

  console.log('[problems]', problems.length ? JSON.stringify(problems, null, 2) : '无');
  ws.close();
  process.exit(0);
}

main().catch((e) => { console.error('[fail]', e.message); process.exit(1); });
