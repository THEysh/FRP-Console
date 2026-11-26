'use strict';
/* C2：切换连接只换视图，不碰任何 frpc 进程。
 *
 * 钉住四件事（全部用 pid 断言，不看文案）：
 *   ① 两条连接都启动后，来回切换 activeConnectionId，两个 frpc 的 pid 都不变；
 *   ② 切到一条**从未启动**的连接时，别人的 pid 不变、它自己也不会被自动拉起；
 *   ③ 切换结果里不再有 stopped 字段（老契约是「切换时停掉了哪些连接」）；
 *   ④ 停止 A 之后 B 仍在跑（启动/停止只作用于目标连接）。
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const frpsHelper = require('../helpers/frps.cjs');

const A = { key: 'A', host: '127.0.0.1', bindPort: 0, dashPort: 0, token: 'sw-token-A-1234567890', adminPort: 0, conn: 'c-default', remotePort: 0, localPort: 0 };
const B = { key: 'B', host: '127.0.0.2', bindPort: 0, dashPort: 0, token: 'sw-token-B-1234567890', adminPort: 0, conn: 'c-two', remotePort: 0, localPort: 0 };
const PROXY = 'sw-proxy';

function freePort(start) {
  return new Promise((resolve) => {
    let port = start;
    const tryPort = () => {
      if (port > start + 200) { resolve(0); return; }
      const srv = net.createServer();
      srv.once('error', () => { port += 1; tryPort(); });
      srv.listen(port, '127.0.0.1', () => {
        const picked = port;
        srv.close(() => resolve(picked));
      });
    };
    tryPort();
  });
}

const frpsToml = (s) => [
  `bindAddr = "${s.host}"`,
  `bindPort = ${s.bindPort}`,
  `vhostHTTPPort = ${s.bindPort + 1000}`,
  `vhostHTTPSPort = ${s.bindPort + 2000}`,
  '',
  '[auth]',
  'method = "token"',
  `token = "${s.token}"`,
  '',
  '[webServer]',
  'addr = "127.0.0.1"',
  `port = ${s.dashPort}`,
  'user = "admin"',
  'password = "admin"',
  '',
].join('\n');

const frpcToml = (s) => [
  `serverAddr = "${s.host}"`,
  `serverPort = ${s.bindPort}`,
  'loginFailExit = false',
  '',
  '[auth]',
  'method = "token"',
  `token = "${s.token}"`,
  '',
  '[webServer]',
  'addr = "127.0.0.1"',
  `port = ${s.adminPort}`,
  'user = "admin"',
  'password = "admin"',
  '',
  '[[proxies]]',
  `name = "${PROXY}"`,
  'type = "tcp"',
  'localIP = "127.0.0.1"',
  `localPort = ${s.localPort}`,
  `remotePort = ${s.remotePort}`,
  '',
].join('\n');

module.exports = {
  id: 'switch-no-stop',
  title: '切换连接只换视图：两条隧道同时在线、来回切 pid 不变',
  needs: ['frpc'],
  async run(ctx) {
    const { check, sleep } = ctx;
    const frpsBin = frpsHelper.findFrps();
    if (!frpsBin) { check('找到 frps 二进制（否则本场景无意义）', false, '需要 frps.exe'); return; }

    A.bindPort = await freePort(18600);
    A.dashPort = await freePort(A.bindPort + 500);
    A.adminPort = await freePort(7452);
    A.localPort = await freePort(18470);
    A.remotePort = await freePort(25901);
    B.bindPort = await freePort(A.bindPort + 120);
    B.dashPort = await freePort(B.bindPort + 500);
    B.adminPort = await freePort(A.adminPort + 1);
    B.localPort = await freePort(A.localPort + 1);
    B.remotePort = await freePort(A.remotePort + 120);
    check('找到两组空闲端口', !!(A.bindPort && B.bindPort && A.adminPort && B.adminPort), JSON.stringify({ A, B }));
    if (!A.bindPort || !B.bindPort) return;

    const work = path.join(ctx.dataDir, 'sw');
    fs.mkdirSync(work, { recursive: true });
    const cfgA = path.join(work, 'a.toml');
    const cfgB = path.join(work, 'b.toml');
    const cfgC = path.join(work, 'c.toml');
    fs.writeFileSync(cfgA, frpcToml(A), 'utf8');
    fs.writeFileSync(cfgB, frpcToml(B), 'utf8');
    /* C 只是一条「没填地址、也没启动」的连接，用来验证切换不会顺手拉起别人。 */
    fs.writeFileSync(cfgC, ['serverAddr = ""', 'serverPort = 7000', ''].join('\n'), 'utf8');

    const srvA = http.createServer((q, r) => { r.writeHead(200); r.end('sw-a'); });
    const srvB = http.createServer((q, r) => { r.writeHead(200); r.end('sw-b'); });
    await new Promise((r) => srvA.listen(A.localPort, '127.0.0.1', r));
    await new Promise((r) => srvB.listen(B.localPort, '127.0.0.1', r));

    const frpsProcs = [];
    for (const s of [A, B]) {
      const dir = path.join(work, `frps-${s.key}`);
      fs.mkdirSync(dir, { recursive: true });
      const cfg = path.join(dir, 'frps.toml');
      fs.writeFileSync(cfg, frpsToml(s), 'utf8');
      frpsProcs.push(spawn(frpsBin, ['-c', cfg], { cwd: dir, stdio: 'ignore', windowsHide: true }));
    }
    await sleep(1200);

    let inst = null;
    try {
      inst = await ctx.startApp({
        seed: (dir) => {
          const data = path.join(dir, 'frp-console-data');
          fs.mkdirSync(data, { recursive: true });
          fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({
            version: 2,
            frpcPath: path.join(__dirname, '..', '..', '..', 'vendor', 'frpc', 'frpc.exe'),
            configPath: cfgA,
            logPath: '',
            runMode: 'managed',
            adminPort: A.adminPort,
            adminUser: 'admin',
            adminPassword: 'sw-admin-pass-123456',
            autoReload: true,
            autoReconnect: true,
            pollIntervalMs: 3000,
            stripProxyEnv: true,
            closeToTray: true,
            launchAtLogin: false,
            logBuffer: 600,
            starterConfigCreated: true,
            servers: [],
            proxyOpenPaths: {},
            connections: [
              { id: 'c-default', name: 'A', serverId: '', configPath: cfgA, logPath: '', adminPort: A.adminPort, enabled: true, autoReconnect: true },
              { id: 'c-two', name: 'B', serverId: '', configPath: cfgB, logPath: '', adminPort: B.adminPort, enabled: true, autoReconnect: true },
              { id: 'c-idle', name: 'C', serverId: '', configPath: cfgC, logPath: '', adminPort: 0, enabled: true, autoReconnect: true },
            ],
            activeConnectionId: 'c-default',
          }, null, 2), 'utf8');
        },
      });
      check('实例启动', !!inst && inst.ready === true);
      if (!inst || !inst.ready) return;
      const ev = inst.eval;

      /* 两条都启动 */
      const startA = await ev(`(async () => { const r = await FRP.startTunnel(); return { ok: r.ok, err: (r.error || '').slice(0, 120) }; })()`);
      const startB = await ev(`(async () => { const r = await FRP.connectionStart('c-two'); return { ok: r.ok, err: (r.error || '').slice(0, 120) }; })()`);
      check('两条连接都能启动', !!(startA && startA.ok && startB && startB.ok), JSON.stringify({ a: startA, b: startB }));

      const rows = () => ev(`(async () => { const r = await FRP.connections(); return r.data.connections.map((c) => ({ id: c.id, mode: c.runtime.mode, pid: c.runtime.pid })); })()`);
      let before = [];
      for (let i = 0; i < 40; i += 1) {
        before = await rows();
        const a = before.find((c) => c.id === 'c-default');
        const b = before.find((c) => c.id === 'c-two');
        if (a && b && a.pid && b.pid && a.mode === 'managed' && b.mode === 'managed') break;
        await sleep(1000);
      }
      const pidA = (before.find((c) => c.id === 'c-default') || {}).pid;
      const pidB = (before.find((c) => c.id === 'c-two') || {}).pid;
      check('两条隧道同时在线（各有自己的 pid）', !!pidA && !!pidB && pidA !== pidB, JSON.stringify(before));

      /* 来回切换三次 */
      const switches = [];
      for (const target of ['c-two', 'c-default', 'c-two', 'c-idle', 'c-default']) {
        const res = await ev(`(async () => { const r = await FRP.connectionActive('${target}'); return { ok: r.ok, changed: !!(r.data && r.data.changed), hasStopped: !!(r.data && 'stopped' in r.data) }; })()`);
        switches.push({ target, res });
        await sleep(700);
      }
      check('五次切换都成功', switches.every((s) => s.res && s.res.ok && s.res.changed), JSON.stringify(switches));
      check('切换结果里不再有 stopped 字段（老契约已删）', switches.every((s) => s.res && s.res.hasStopped === false), JSON.stringify(switches.map((s) => s.res)));

      const after = await rows();
      const afterA = (after.find((c) => c.id === 'c-default') || {}).pid;
      const afterB = (after.find((c) => c.id === 'c-two') || {}).pid;
      check('切换之后 A 的 frpc pid 没变', afterA === pidA, `${pidA} -> ${afterA}`);
      check('切换之后 B 的 frpc pid 没变', afterB === pidB, `${pidB} -> ${afterB}`);
      const afterC = after.find((c) => c.id === 'c-idle') || {};
      check('切到尚未启动的连接不会把它自动拉起', !afterC.pid && afterC.mode !== 'managed', JSON.stringify(afterC));

      /* 停止 A（当前连接），B 必须仍在跑 */
      const stopA = await ev(`(async () => { const r = await FRP.stopTunnel(); return { ok: r.ok, err: (r.error || '').slice(0, 120) }; })()`);
      await sleep(1500);
      const afterStop = await rows();
      const sA = afterStop.find((c) => c.id === 'c-default') || {};
      const sB = afterStop.find((c) => c.id === 'c-two') || {};
      check('停止当前连接成功', !!(stopA && stopA.ok), JSON.stringify(stopA));
      check('停止 A 之后 B 仍在跑（pid 不变）', sB.pid === pidB && sB.mode === 'managed', JSON.stringify({ sA, sB }));
      check('A 确实停了', !sA.pid || sA.mode === 'stopped', JSON.stringify(sA));
    } finally {
      try { if (inst) inst.stop(); } catch { /* ignore */ }
      for (const p of frpsProcs) { try { p.kill(); } catch { /* ignore */ } }
      try { await new Promise((r) => srvA.close(r)); } catch { /* ignore */ }
      try { await new Promise((r) => srvB.close(r)); } catch { /* ignore */ }
    }
  },
};
