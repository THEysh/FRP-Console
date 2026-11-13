'use strict';
/*
 * 回归测试：删掉「本机隧道目标」档案之后，控制台不能再报绿。
 *
 * 为什么用假管理 API 而不是真起 frpc：
 *   frpc 的 /api/status 由 frpc 自己提供，跟有没有登上 frps 无关。控制台判断
 *   "隧道在跑"看的正是它。起一个同形状的假服务，就能精确复现用户看到的那一幕
 *   —— 界面上一路绿，实际档案已经没了 —— 而且不需要真实服务器、不碰系统服务。
 *   （自动化环境禁止 spawn frpc / sc.exe，真进程路径请人工复核。）
 *
 * 用法：node tools/e2e-orphan.cjs
 */
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SANDBOX = path.join(ROOT, '.e2e', 'orphan');
const DATA_DIR = path.join(SANDBOX, 'frp-console-data');
const CDP_PORT = Number(process.env.CDP_PORT || 9345);
const ADMIN_PORT = 7400;
const FRPS_PORT = 7999;
const TOKEN = 'ORPHANtok1234567';
/* orphan  ：档案被删，frpc 还在跑 —— 主用例
 * unbound ：档案还在、只是没绑到隧道 —— 反向用例，不该报警 */
const CASE = process.argv[2] === 'unbound' ? 'unbound' : 'orphan';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findFrpc() {
  for (const rel of ['vendor/frpc/frpc.exe', 'runtime/frpc.exe']) {
    const p = path.join(ROOT, rel);
    if (fs.existsSync(p)) return p;
  }
  return path.join(ROOT, 'vendor', 'frpc', 'frpc.exe');
}

function seed() {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const frpcPath = findFrpc();
  const configPath = path.join(SANDBOX, 'frpc.toml');
  fs.writeFileSync(configPath, [
    'serverAddr = "127.0.0.1"',
    `serverPort = ${FRPS_PORT}`,
    'loginFailExit = false',
    '',
    '[auth]',
    'method = "token"',
    `token = "${TOKEN}"`,
    '',
    '[[proxies]]',
    'name = "orphan-tcp"',
    'type = "tcp"',
    'localIP = "127.0.0.1"',
    'localPort = 9100',
    'remotePort = 29100',
    '',
  ].join('\n'), 'utf8');

  const servers = [{
    id: 'srv-orphan-1',
    name: '孤儿服务器',
    host: '127.0.0.1',
    port: 22,
    username: 'root',
    clientPort: FRPS_PORT,
    clientToken: TOKEN,
    configPath,
    serviceName: 'frps',
    dashboardUrl: '',
    createdAt: Date.now(),
    lastConnectedAt: 0,
  }];
  /* CASE=unbound：同一台服务器有两份档案。删掉被绑定的那份之后，本机配置
   * 仍然能按地址找到另一份 —— 这时候说"档案已经没了"就是撒谎，只能说
   * "没有归属到档案"。 */
  if (CASE === 'unbound') {
    servers.push({
      id: 'srv-orphan-2',
      name: '备用档案',
      host: '127.0.0.1',
      port: 22,
      username: 'root',
      clientPort: FRPS_PORT,
      clientToken: TOKEN,
      configPath,
      serviceName: 'frps',
      dashboardUrl: '',
      createdAt: Date.now() + 1,
      lastConnectedAt: 0,
    });
  }

  const settings = {
    version: 2,
    frpcPath,
    configPath,
    runMode: 'auto',
    adminPort: ADMIN_PORT,
    adminUser: 'admin',
    adminPassword: 'admin',
    autoReload: true,
    pollIntervalMs: 1200,
    stripProxyEnv: true,
    closeToTray: false,
    launchTunnelOnStart: false,
    launchAtLogin: false,
    confirmStopService: false,
    logBuffer: 600,
    starterConfigCreated: true,
    servers,
    activeServerId: 'srv-orphan-1',
    clientServerId: 'srv-orphan-1',
  };
  fs.writeFileSync(path.join(DATA_DIR, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8');
  return { frpcPath, configPath };
}

/* 假的 frpc 管理 API：形状和真的一样，够 refresh() 解析 */
function startFakeAdmin() {
  const server = http.createServer((req, res) => {
    if (req.url && req.url.startsWith('/api/status')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        tcp: [{ name: 'orphan-tcp', status: 'running', type: 'tcp', conf: { local_port: 9100, remote_port: 29100 } }],
      }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(ADMIN_PORT, '127.0.0.1', () => resolve(server));
  });
}

function getJson(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: CDP_PORT, path: p, timeout: 2000 }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (b += c));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function waitForPage(timeoutMs = 30000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const list = await getJson('/json/list');
      const page = list.find((t) => t.type === 'page');
      if (page) return page;
    } catch { /* 还没起来 */ }
    if (Date.now() - t0 > timeoutMs) throw new Error('CDP 页面超时');
    await sleep(400);
  }
}

async function main() {
  const seeded = seed();
  console.log(`[seed] config=${seeded.configPath}`);
  console.log(`[seed] data=${DATA_DIR}`);
  const fake = await startFakeAdmin();
  console.log(`[seed] 假管理 API 127.0.0.1:${ADMIN_PORT}/api/status`);

  const electron = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  const env = { ...process.env, PORTABLE_EXECUTABLE_DIR: SANDBOX };
  delete env.ELECTRON_RUN_AS_NODE;   // 否则 electron 会变成纯 node 跑不起来
  delete env.NODE_OPTIONS;
  const child = spawn(electron, ['.', `--remote-debugging-port=${CDP_PORT}`], {
    cwd: ROOT,
    env,
    stdio: 'ignore',
  });
  const appExited = new Promise((r) => child.on('exit', (code) => r(code)));

  const results = [];
  const check = (name, pass, detail) => {
    results.push({ name, pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`);
  };

  let ws;
  try {
    const page = await waitForPage();
    ws = new WebSocket(page.webSocketDebuggerUrl);
    const pending = new Map();
    let seq = 0;
    const errors = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        errors.push((msg.params.exceptionDetails.exception || {}).description || msg.params.exceptionDetails.text);
      }
    });
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    const send = (method, params = {}, timeout = 20000) => new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`${method} timeout`)); } }, timeout);
    });
    await send('Runtime.enable', {});

    const run = async (body) => {
      const res = await send('Runtime.evaluate', {
        expression: `(async () => { ${body} })()`,
        returnByValue: true,
        awaitPromise: true,
      });
      if (res.exceptionDetails) {
        const d = res.exceptionDetails;
        throw new Error((d.exception && d.exception.description) || d.text);
      }
      return res.result ? res.result.value : undefined;
    };

    for (let i = 0; i < 80; i += 1) {
      const ready = await run(`return !!(window.FRP && document.querySelectorAll('#nav .nav-item').length)`).catch(() => false);
      if (ready) break;
      await sleep(300);
    }

    const state = () => run(`const r = await window.FRP.init(); return r.data.state;`);
    const pillText = () => run(`return ((document.querySelector('#tb-status') || {}).textContent || '').replace(/\\s+/g, ' ').trim();`);
    const viewText = async (view) => run(`
      const nav = [...document.querySelectorAll('[data-act=nav]')].find((e) => e.dataset.view === ${JSON.stringify(view)});
      if (nav) nav.click();
      await new Promise((r) => setTimeout(r, 900));
      const v = document.querySelector('#view');
      return v ? v.textContent.replace(/\\s+/g, ' ').trim() : '';
    `);

    // 等控制台真正认为"隧道在跑"
    let s1 = null;
    for (let i = 0; i < 30; i += 1) {
      s1 = await state();
      if (s1 && s1.runtime && (s1.runtime.running || s1.runtime.connected)) break;
      await sleep(500);
    }

    // ---- 阶段 1：档案在、绑定完整（两种用例的共同起点）----
    check('删档前：binding 指向该档案', (s1.binding && s1.binding.profileId) === 'srv-orphan-1', s1.binding && s1.binding.profileId);
    check('删档前：有对应档案名', (s1.binding.matchProfileName || '') === '孤儿服务器', s1.binding.matchProfileName);
    check('删档前：不算无档案', s1.binding.unarchived === false, s1.binding.unarchived);
    check('删档前：控制台认为隧道在跑', !!(s1.runtime && (s1.runtime.running || s1.runtime.connected)), {
      mode: s1.runtime && s1.runtime.mode, connected: s1.runtime && s1.runtime.connected,
    });

    const beforePill = await pillText();
    console.log(`[info] 删档前胶囊：${beforePill}`);
    check('删档前：胶囊是绿色「隧道在线」', beforePill === '隧道在线', beforePill);

    // ---- 阶段 2：删除档案（勾选同时解除绑定）----
    const del = await run(`
      const res = await window.FRP.serverProfileDelete('srv-orphan-1', true);
      return { ok: !!res.ok, message: res.message || '', stoppedTunnel: res.data && res.data.stoppedTunnel,
               stopSkipped: res.data && res.data.stopSkipped, stopError: res.data && res.data.stopError };
    `);
    check('删除档案成功', del.ok === true, del.message);
    check('不是自家进程 → 不乱杀，报告跳过原因', del.stoppedTunnel === false && del.stopSkipped === 'external', del);

    await sleep(2200);

    // ---- 阶段 3：删档后的真实状态 ----
    const s2 = await state();
    check('删档后：binding 已解绑', (s2.binding.profileId || '') === '', s2.binding.profileId);
    check('删档后：进入无档案状态', s2.binding.unarchived === true, { unarchived: s2.binding.unarchived, addr: s2.binding.addr });

    if (CASE === 'unbound') {
      /* 同一台服务器还有另一份档案：不能谎称"档案没了"，也不该把胶囊弄黄 */
      check('同址有备份档案：能找到「备用档案」', (s2.binding.matchProfileName || '') === '备用档案', s2.binding.matchProfileName);
      const p = await pillText();
      console.log(`[info] 删档后胶囊：${p}`);
      check('同址有备份档案：胶囊仍是绿色「隧道在线」', p === '隧道在线', p);

      const ov = await viewText('overview');
      check('概览：提示「没有归属到档案」', /没有归属到档案/.test(ov), ov.slice(0, 160));
      check('概览：不谎称档案已经没了', !/已经没有对应的服务器档案/.test(ov), '');
      check('概览：给了去绑定的出口', /去服务器页绑定/.test(ov), '');
    } else {
      check('删档后：查不到对应档案', (s2.binding.matchProfileName || '') === '', s2.binding.matchProfileName);
      check('删档后：档案列表为空', (s2.servers || []).length === 0, (s2.servers || []).length);

      /* 关键：frpc 仍在跑（假 API 还在应答），连通性是真的 —— 但界面不能再报绿 */
      const afterPill = await pillText();
      console.log(`[info] 删档后胶囊：${afterPill}`);
      check('删档后：胶囊不再是纯绿「隧道在线」', afterPill !== '隧道在线', afterPill);
      check('删档后：胶囊标注「无档案」', /无档案/.test(afterPill), afterPill);

      const overview = await viewText('overview');
      check('概览：出现「已经没有对应的服务器档案」警示', /已经没有对应的服务器档案/.test(overview), overview.slice(0, 160));
      check('概览：警示里给了停止隧道的出口', /停止隧道/.test(overview), '');

      // 留一张图给人复核：胶囊是不是黄的、警示条位置对不对
      try {
        const shot = await send('Page.captureScreenshot', { format: 'png' }, 20000);
        const outDir = path.join(ROOT, '.shots');
        fs.mkdirSync(outDir, { recursive: true });
        const file = path.join(outDir, 'orphan-overview.png');
        fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
        console.log(`[shot] ${file}`);
      } catch (e) {
        console.log(`[shot] 截图失败：${e.message}`);
      }

      const proxies = await viewText('proxies');
      check('代理映射：同样出现警示', /已经没有对应的服务器档案/.test(proxies), proxies.slice(0, 120));
    }

    check('渲染层无未捕获异常', errors.length === 0, errors.slice(0, 3));

    const failed = results.filter((r) => !r.pass);
    console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
    if (failed.length) {
      console.log('失败项：');
      for (const f of failed) console.log(`  - ${f.name}  ${JSON.stringify(f.detail)}`);
      process.exitCode = 1;
    }
  } finally {
    try { if (ws) ws.close(); } catch { /* ignore */ }
    try { child.kill(); } catch { /* ignore */ }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 4000);
    await Promise.race([appExited, sleep(5000)]);
    clearTimeout(timer);
    try { fake.close(); } catch { /* ignore */ }
  }
}

main().catch((e) => {
  console.error('E2E 崩了：', e && e.message);
  process.exitCode = 1;
});
