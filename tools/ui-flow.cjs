'use strict';
/*
 * 交互流程测试：通过 CDP 真正点击界面控件，收集 toast / 弹窗 / 控制台异常。
 * 用法：node tools/ui-flow.cjs [流程名]
 * 依赖应用以 --remote-debugging-port=9333 启动。
 */
const http = require('node:http');

const PORT = Number(process.env.CDP_PORT || 9333);

const getJson = (p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 3000 }, (res) => {
    let b = '';
    res.setEncoding('utf8');
    res.on('data', (c) => (b += c));
    res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
  }).on('error', reject);
});

async function connect() {
  const list = await getJson('/json/list');
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('没有找到页面目标');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  const events = [];
  let seq = 0;
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      events.push({ kind: 'exception', text: (d.exception && d.exception.description) || d.text });
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      events.push({ kind: 'console.error', text: msg.params.args.map((a) => a.value || a.description || a.type).join(' ') });
    } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      events.push({ kind: 'log.error', text: msg.params.entry.text });
    }
  });
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.enable', {});
  await send('Log.enable', {});
  return { ws, send, events };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 在页面里执行一段 async 函数体，返回可序列化结果 */
async function run(send, body) {
  const expression = `(async () => { ${body} })()`;
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, awaitPromiseRejection: false });
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new Error((d.exception && d.exception.description) || d.text);
  }
  return res.result ? res.result.value : undefined;
}

/* 页面内公共工具，挂在 window.__t 上 */
const HELPERS = `
window.__t = {
  waitReady(ms = 15000) {
    const t0 = Date.now();
    return new Promise((resolve) => {
      const tick = () => {
        if (document.querySelectorAll('#nav .nav-item').length) return resolve(true);
        if (Date.now() - t0 > ms) return resolve(false);
        setTimeout(tick, 100);
      };
      tick();
    });
  },
  q: (sel) => document.querySelector(sel),
  act: (name) => [...document.querySelectorAll('[data-act]')].find((e) => e.dataset.act === name),
  acts: (name) => [...document.querySelectorAll('[data-act]')].filter((e) => e.dataset.act === name),
  click(el) { if (!el) return false; el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); return true; },
  nav(view) { const b = [...document.querySelectorAll('[data-act=nav]')].find((e) => e.dataset.view === view); if (!b) return false; b.click(); return true; },
  toasts() { return [...document.querySelectorAll('.toast, .toast-item, #toasts > *')].map((e) => e.textContent.replace(/\\s+/g, ' ').trim()); },
  modal() { const m = document.querySelector('.modal, .dialog, #modal'); return m && !m.hidden ? m.textContent.replace(/\\s+/g, ' ').trim().slice(0, 200) : ''; },
  text() { const v = document.querySelector('#view'); return v ? v.textContent.replace(/\\s+/g, ' ').trim() : ''; }
};
`;

const FLOWS = {
  async settings({ send }) {
    const out = [];
    out.push(['导航到设置', await run(send, `return window.__t.nav('settings')`)]);
    await sleep(400);
    out.push(['设置页字段数', await run(send, `return { inputs: document.querySelectorAll('#view input, #view select').length, sections: document.querySelectorAll('#view section.card').length }`)]);

    // 保存连接配置（未改动 → 应成功且不报错）
    await run(send, `window.__t.click(window.__t.act('settings.save.conn')); return true`);
    await sleep(1800);
    out.push(['保存连接配置', await run(send, `return { toasts: window.__t.toasts(), modal: window.__t.modal() }`)]);

    // 测试连通性
    await run(send, `window.__t.click(window.__t.act('settings.test.conn')); return true`);
    await sleep(2500);
    out.push(['测试连通性', await run(send, `return { toasts: window.__t.toasts() }`)]);

    // 保存行为设置
    await run(send, `window.__t.click(window.__t.act('settings.save.behavior')); return true`);
    await sleep(1800);
    out.push(['保存行为设置', await run(send, `return { toasts: window.__t.toasts() }`)]);

    // 切换开关再切回（不应残留脏状态）
    out.push(['切换 autoReload 两次', await run(send, `
      const sw = [...document.querySelectorAll('[data-act=toggle]')].find((e) => e.dataset.field === 'autoReload');
      if (!sw) return '没找到开关';
      const before = sw.classList.contains('on');
      sw.click(); const mid = sw.classList.contains('on');
      sw.click(); const after = sw.classList.contains('on');
      return { before, mid, after, same: before === after };
    `)]);

    return out;
  },

  async logs({ send }) {
    const out = [];
    out.push(['导航到日志', await run(send, `return window.__t.nav('logs')`)]);
    await sleep(900);
    out.push(['日志页概况', await run(send, `return { rows: document.querySelectorAll('#view .log-line, #view .ltx').length, levels: window.__t.acts('logs.level').length }`)]);

    for (const lv of ['error', 'warn', 'info', '']) {
      await run(send, `
        const b = [...document.querySelectorAll('[data-act="logs.level"]')].find((e) => (e.dataset.level || '') === ${JSON.stringify(lv)});
        if (b) b.click(); return true;
      `);
      await sleep(350);
      out.push([`筛选 ${lv || '全部'}`, await run(send, `return { active: (document.querySelector('[data-act="logs.level"].active') || {}).textContent, rows: document.querySelectorAll('#view .log-line').length }`)]);
    }

    await run(send, `window.__t.click(window.__t.act('logs.refresh')); return true`);
    await sleep(800);
    out.push(['刷新日志', await run(send, `return { rows: document.querySelectorAll('#view .log-line').length, toasts: window.__t.toasts() }`)]);

    await run(send, `window.__t.click(window.__t.act('logs.clear')); return true`);
    await sleep(700);
    out.push(['清空视图', await run(send, `return { rows: document.querySelectorAll('#view .log-line').length, toasts: window.__t.toasts() }`)]);
    return out;
  },

  async tunnel({ send }) {
    const out = [];
    // 关掉 loginFailExit，让 frpc 连不上时留在原地重试（否则立刻退出、连日志都不写）
    await run(send, `window.__t.nav('settings'); return true`);
    await sleep(1200);
    out.push(['loginFailExit → false', await run(send, `
      const sw = [...document.querySelectorAll('[data-act=toggle]')].find((e) => e.dataset.field === 'loginFailExit');
      if (!sw) return '没找到开关';
      if (sw.classList.contains('on')) sw.click();
      return { on: sw.classList.contains('on') };
    `)]);
    await run(send, `window.__t.click(window.__t.act('settings.save.conn')); return true`);
    await sleep(1500);

    await run(send, `window.__t.nav('overview'); return true`);
    await sleep(600);
    out.push(['启动隧道', await run(send, `window.__t.click(window.__t.act('tunnel.start')); return true`)]);
    await sleep(6000);
    out.push(['启动后 6s 概览', await run(send, `
      return { pill: (document.querySelector('#status-pill') || {}).textContent,
               hero: window.__t.text().slice(0, 220), toasts: window.__t.toasts() };
    `)]);

    await sleep(6000);
    out.push(['启动后 12s 概览', await run(send, `
      return { pill: (document.querySelector('#status-pill') || {}).textContent,
               hero: window.__t.text().slice(0, 220) };
    `)]);

    await run(send, `window.__t.nav('logs'); return true`);
    await sleep(1200);
    out.push(['日志行数', await run(send, `return { rows: document.querySelectorAll('#view .log-line').length, text: window.__t.text().slice(0, 300) }`)]);

    await run(send, `window.__t.nav('overview'); return true`);
    await sleep(500);
    out.push(['停止隧道', await run(send, `window.__t.click(window.__t.act('tunnel.stop')); return true`)]);
    await sleep(3000);
    out.push(['停止后概览', await run(send, `return { hero: window.__t.text().slice(0, 200), toasts: window.__t.toasts() }`)]);
    return out;
  },

  async proxies({ send }) {
    const out = [];
    out.push(['导航到代理', await run(send, `return window.__t.nav('proxies')`)]);
    await sleep(700);
    out.push(['代理列表', await run(send, `return { rows: document.querySelectorAll('#view tbody tr').length, editBtns: window.__t.acts('proxy.edit').length }`)]);

    // 打开编辑弹窗，检查字段是否回填
    await run(send, `window.__t.click(window.__t.acts('proxy.edit')[0]); return true`);
    await sleep(500);
    out.push(['编辑弹窗回填', await run(send, `
      const inputs = [...document.querySelectorAll('.modal input, .modal select, dialog input')];
      return { count: inputs.length, values: inputs.slice(0, 6).map((e) => e.value), modal: window.__t.modal() };
    `)]);

    // 关闭弹窗
    await run(send, `const c = window.__t.act('modal.close'); if (c) c.click(); return !!c`);
    await sleep(400);
    out.push(['关闭弹窗', await run(send, `return { modal: window.__t.modal() }`)]);

    // 搜索框过滤
    out.push(['搜索过滤', await run(send, `
      const box = document.querySelector('#view input[type=search], #view .toolbar input');
      if (!box) return '没有搜索框';
      box.value = 'zzz-not-exist';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      return { value: box.value };
    `)]);
    await sleep(500);
    out.push(['过滤后行数', await run(send, `return document.querySelectorAll('#view tbody tr').length`)]);
    await run(send, `
      const box = document.querySelector('#view input[type=search], #view .toolbar input');
      if (box) { box.value = ''; box.dispatchEvent(new Event('input', { bubbles: true })); }
      return true;
    `);
    await sleep(400);
    return out;
  },

  async server({ send }) {
    const out = [];
    out.push(['导航到服务器', await run(send, `return window.__t.nav('server')`)]);
    await sleep(800);
    out.push(['服务器页概况', await run(send, `return { cards: document.querySelectorAll('#view section.card').length, text: window.__t.text().slice(0, 160) }`)]);

    // 打开“新建档案”弹窗
    await run(send, `window.__t.click(window.__t.act('server.profile.new')); return true`);
    await sleep(500);
    out.push(['新建档案弹窗', await run(send, `return { modal: window.__t.modal() }`)]);
    await run(send, `const c = window.__t.act('modal.close'); if (c) c.click(); return !!c`);
    await sleep(300);
    return out;
  },

  async misc({ send }) {
    const out = [];
    // 服务发现 → 发布代理：预设值应带出端口
    await run(send, `window.__t.nav('discovery'); return true`);
    await sleep(2500);
    out.push(['本机端口数', await run(send, `return document.querySelectorAll('#view .listener-table tbody tr').length`)]);
    out.push(['点第一个“添加代理”', await run(send, `
      const b = window.__t.acts('listener.publish')[0];
      if (!b) return '没有可发布的端口';
      const port = b.dataset.port;
      b.click();
      return { port };
    `)]);
    await sleep(600);
    out.push(['预设是否带出', await run(send, `
      const inputs = [...document.querySelectorAll('.modal input')];
      const get = (n) => (document.querySelector('.modal [name="' + n + '"]') || {}).value;
      return { name: get('name'), localPort: get('localPort'), type: get('type'), count: inputs.length };
    `)]);
    await run(send, `const c = window.__t.act('modal.close'); if (c) c.click(); return !!c`);
    await sleep(400);

    // 设置页 → 启用/校验管理 API
    await run(send, `window.__t.nav('settings'); return true`);
    await sleep(900);
    await run(send, `window.__t.click(window.__t.act('admin.enable')); return true`);
    await sleep(2500);
    out.push(['校验管理 API', await run(send, `return { toasts: window.__t.toasts(), modal: window.__t.modal() }`)]);

    // 概览页工具按钮是否都在
    await run(send, `window.__t.nav('overview'); return true`);
    await sleep(700);
    out.push(['概览工具按钮', await run(send, `
      return ['tunnel.start','tunnel.restart','tunnel.reload'].map((n) => [n, !!window.__t.act(n)]);
    `)]);
    return out;
  },

  async winctl({ send }) {
    const out = [];
    out.push(['初始窗口状态', await run(send, `
      const b = document.querySelector('#win-max');
      return { isMax: b && b.classList.contains('is-max'), title: b && b.getAttribute('title'),
               visible: [...document.querySelectorAll('.win-btn svg')].filter((s) => getComputedStyle(s).display !== 'none').length };
    `)]);
    return out;
  },
};

(async () => {
  const name = process.argv[2] || 'settings';
  const flow = FLOWS[name];
  if (!flow) {
    console.error(`未知流程：${name}，可选：${Object.keys(FLOWS).join(' / ')}`);
    process.exit(2);
  }
  const { ws, send, events } = await connect();
  await run(send, HELPERS + '; return await window.__t.waitReady()');
  let out;
  try {
    out = await flow({ send });
  } finally {
    console.log(`\n=== ${name} ===`);
    for (const [step, value] of out || []) {
      console.log(`\n· ${step}\n  ${typeof value === 'string' ? value : JSON.stringify(value)}`);
    }
    if (events.length) {
      console.log('\n⚠️ 页面异常：');
      for (const e of events) console.log(`  [${e.kind}] ${String(e.text).split('\n')[0].slice(0, 220)}`);
    } else {
      console.log('\n✅ 无 console.error / 未捕获异常');
    }
    ws.close();
  }
})().catch((e) => { console.error('[fail]', e.message); process.exit(1); });
