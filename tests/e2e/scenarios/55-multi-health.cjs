'use strict';
/* 多连接阶段 3：健康检查按连接隔离 + 非当前连接能自己重连。
 *
 * 这条场景钉住两件容易被「按名字做键」搞坏的事：
 *   ① 两条连接里各有一条**同名**代理（`same-name`）。老代码 healthCache 按裸名字做键，
 *      A 的三层全通会直接贴到 B 的同名代理上 —— 这里用「把 B 的本地服务关掉」验证
 *      B 会自己变成异常、而 A 仍然在线。
 *   ② 非当前连接的 frpc 被外面杀掉时，它自己的重连守护要能把它拉回来（pid 变化），
 *      期间当前连接完全不受影响。
 *
 * 端口都避开 37-config-switch（17200/17201）、54-multi-connection（17800/17900）与 runner 那台 frps。
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const frpsHelper = require('../helpers/frps.cjs');

/* 端口在 run() 里现找：全量跑时前面几十条场景可能还留着监听进程，写死端口必然偶发变红。 */
const A = { key: 'A', bindPort: 0, dashPort: 0, token: 'mh-token-A-1234567890', adminPort: 0, conn: 'c-default', remotePort: 0, localPort: 0 };
const B = { key: 'B', bindPort: 0, dashPort: 0, token: 'mh-token-B-1234567890', adminPort: 0, conn: 'c-two', remotePort: 0, localPort: 0 };
const PROXY = 'same-name';

/* 从 start 开始找一个能真正 listen 的端口（bind 成功即释放，紧接着给 frpc/frps 用）。 */
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
  'bindAddr = "127.0.0.1"',
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
  'serverAddr = "127.0.0.1"',
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
  id: '55-multi-health',
  title: '多连接：健康检查与自动重连按连接隔离',
  needs: ['frpc'],
  async run(ctx) {
    const { check, sleep } = ctx;
    const frpsBin = frpsHelper.findFrps();
    if (!frpsBin) { check('找到 frps 二进制（否则本场景无意义）', false, '需要 frps.exe'); return; }

    /* 两两成对的空闲端口：frps bindPort / dashPort、frpc adminPort、本地服务、公网 remotePort。 */
    A.bindPort = await freePort(17400);
    A.dashPort = await freePort(A.bindPort + 500);
    A.adminPort = await freePort(7442);
    A.localPort = await freePort(18393);
    A.remotePort = await freePort(25801);
    B.bindPort = await freePort(A.bindPort + 100);
    B.dashPort = await freePort(B.bindPort + 500);
    B.adminPort = await freePort(A.adminPort + 1);
    B.localPort = await freePort(A.localPort + 1);
    B.remotePort = await freePort(A.remotePort + 100);
    check('找到两组空闲端口', !!(A.bindPort && B.bindPort && A.adminPort && B.adminPort && A.localPort && B.localPort), JSON.stringify({ A, B }));
    if (!A.bindPort || !B.bindPort) return;
    const work = path.join(ctx.dataDir, 'mh');
    fs.mkdirSync(work, { recursive: true });
    const cfgA = path.join(work, 'a.toml');
    const cfgB = path.join(work, 'b.toml');
    fs.writeFileSync(cfgA, frpcToml(A), 'utf8');
    fs.writeFileSync(cfgB, frpcToml(B), 'utf8');

    const srvA = http.createServer((q, r) => { r.writeHead(200); r.end('mh-a'); });
    const srvB = http.createServer((q, r) => { r.writeHead(200); r.end('mh-b'); });
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
            adminPassword: 'mh-admin-pass-123456',
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
            ],
            activeConnectionId: 'c-default',
          }, null, 2), 'utf8');
        },
      });
      check('实例启动', !!inst && inst.ready === true);
      if (!inst || !inst.ready) return;
      const ev = inst.eval;

      const startB = await ev(`(async () => { const r = await FRP.connectionStart('c-two'); return { ok: r.ok, err: (r.error || '').slice(0, 120) }; })()`);
      const startA = await ev(`(async () => { const r = await FRP.startTunnel(); return { ok: r.ok, err: (r.error || '').slice(0, 120) }; })()`);
      check('两条连接都能启动', !!(startA && startA.ok && startB && startB.ok), JSON.stringify({ a: startA, b: startB }));

      const conns = () => ev(`(async () => { const r = await FRP.connections(); return r.data.connections.map((c) => ({ id: c.id, mode: c.runtime.mode, pid: c.runtime.pid, counts: c.counts })); })()`);
      let rows = [];
      for (let i = 0; i < 45; i += 1) {
        rows = await conns();
        if (rows.length === 2 && rows.every((c) => c.counts && c.counts.online === 1 && c.counts.unchecked === 0)) break;
        await sleep(1000);
      }
      check('同名代理在两条连接里都判在线（不串）', rows.length === 2 && rows.every((c) => c.counts && c.counts.online === 1), JSON.stringify(rows.map((c) => `${c.id}:${JSON.stringify(c.counts)}`)));

      /* 关掉 B 的本地服务：B 的在线应归 0，A 不受影响 */
      await new Promise((r) => srvB.close(r));
      let rows2 = [];
      for (let i = 0; i < 45; i += 1) {
        rows2 = await conns();
        const a = rows2.find((c) => c.id === 'c-default');
        const b = rows2.find((c) => c.id === 'c-two');
        if (a && b && b.counts && b.counts.online === 0 && a.counts && a.counts.online === 1) break;
        await sleep(1000);
      }
      const a2 = rows2.find((c) => c.id === 'c-default');
      const b2 = rows2.find((c) => c.id === 'c-two');
      check('B 的本地服务停掉后 B 变异常', !!(b2 && b2.counts && b2.counts.online === 0), JSON.stringify(b2 && b2.counts));
      check('A 的同名代理不受影响', !!(a2 && a2.counts && a2.counts.online === 1), JSON.stringify(a2 && a2.counts));

      /* 杀掉 B 的 frpc，看它自己的守护能否拉回来 */
      const pidB = b2 && b2.pid;
      check('杀之前 B 确实在跑', !!pidB, String(pidB));
      if (!pidB) return;
      try { execFileSync('taskkill', ['/F', '/PID', String(pidB)], { stdio: 'ignore' }); } catch { /* 可能已退出 */ }
      let revived = null;
      for (let i = 0; i < 45; i += 1) {
        await sleep(1000);
        const now = (await conns()).find((c) => c.id === 'c-two');
        if (now && now.mode === 'managed' && now.pid && now.pid !== pidB) { revived = now; break; }
      }
      check('B 被外面杀掉后由它自己的守护拉回来', !!revived, revived ? `pid ${pidB} → ${revived.pid}` : '45 秒内没回来');
      const aAfter = (await conns()).find((c) => c.id === 'c-default');
      check('B 重连期间 A 一直正常', !!(aAfter && aAfter.mode === 'managed' && aAfter.pid), JSON.stringify(aAfter));

      await ev(`(async () => { await FRP.connectionStop('c-two'); await FRP.stopTunnel(); return 1; })()`);
    } finally {
      try { if (inst) await inst.stop(); } catch { /* ignore */ }
      for (const p of frpsProcs) { try { execFileSync('taskkill', ['/F', '/PID', String(p.pid)], { stdio: 'ignore' }); } catch { /* ignore */ } }
      try { srvA.close(); } catch { /* ignore */ }
      try { srvB.close(); } catch { /* ignore */ }
    }
  },
};
