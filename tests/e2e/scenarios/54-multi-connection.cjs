'use strict';
/* 多连接：同一个控制台里同时托管两条隧道（阶段 2 回归）。
 *
 * 1.2.165 起数据层有 connections[]，1.2.166 起进程层能按 id 单独启停。
 * 这条场景钉住四件事：两条连接各自的 frpc 是不同进程、能同时在线、
 * 单独停一条不影响另一条、列表里 active 标记正确。
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const frpsHelper = require('../helpers/frps.cjs');

const SERVER_A = { key: 'A', bindPort: 17800, dashPort: 17810, token: 'mc-token-A-1234567890', adminPort: 7422, conn: 'c-default', proxy: 'mc-a', remotePort: 23801 };
const SERVER_B = { key: 'B', bindPort: 17900, dashPort: 17910, token: 'mc-token-B-1234567890', adminPort: 7423, conn: 'c-two', proxy: 'mc-b', remotePort: 23901 };
const LOCAL_PORT = 18395;

function frpcToml(s) {
  return [
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
    `name = "${s.proxy}"`,
    'type = "tcp"',
    'localIP = "127.0.0.1"',
    `localPort = ${LOCAL_PORT}`,
    `remotePort = ${s.remotePort}`,
    '',
  ].join('\n');
}

module.exports = {
  id: '54-multi-connection',
  title: '多连接：两条隧道同时在线，互不干扰',
  needs: ['app', 'frpc'],
  async run(ctx) {
    const { check, sleep } = ctx;
    /* 这条场景自己起两台 frps（端口与 runner 那台不同），所以直接找二进制，不依赖 ctx.frps。 */
    const frpsBin = frpsHelper.findFrps();
    if (!frpsBin) { check('找到 frps 二进制（否则本场景无意义）', false, 'tools/fetch-frpc.cjs 只下 frpc，需要手动放 frps'); return; }
    const work = path.join(ctx.dataDir, 'mc');
    fs.mkdirSync(work, { recursive: true });

    const frpsProcs = [];
    const local = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('mc-ok');
    });
    await new Promise((r) => local.listen(LOCAL_PORT, '127.0.0.1', r));
    let own = null;
    try {
      for (const s of [SERVER_A, SERVER_B]) {
        const dir = path.join(work, `frps-${s.key}`);
        fs.mkdirSync(dir, { recursive: true });
        const cfg = path.join(dir, 'frps.toml');
        fs.writeFileSync(cfg, frpsHelper.frpsToml ? frpsHelper.frpsToml(s) : [
          'bindAddr = "127.0.0.1"', `bindPort = ${s.bindPort}`, `vhostHTTPPort = ${s.bindPort + 1000}`,
          `vhostHTTPSPort = ${s.bindPort + 2000}`, '', '[auth]', 'method = "token"', `token = "${s.token}"`,
          '', '[webServer]', 'addr = "127.0.0.1"', `port = ${s.dashPort}`, 'user = "admin"', 'password = "admin"', '',
        ].join('\n'), 'utf8');
        frpsProcs.push(spawn(frpsBin, ['-c', cfg], { cwd: dir, stdio: 'ignore', windowsHide: true }));
      }
      await sleep(1500);

      own = await ctx.startApp({
        cdpOffset: 3,
        seed: (dir) => {
          const data = path.join(dir, 'frp-console-data');
          fs.mkdirSync(data, { recursive: true });
          const cfgA = path.join(data, 'frpc-a.toml');
          const cfgB = path.join(data, 'frpc-b.toml');
          fs.writeFileSync(cfgA, frpcToml(SERVER_A), 'utf8');
          fs.writeFileSync(cfgB, frpcToml(SERVER_B), 'utf8');
          fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({
            version: 2,
            frpcPath: path.join(ctx.dataDir, '..', '..', 'vendor', 'frpc', 'frpc.exe'),
            configPath: cfgA,
            logPath: '',
            runMode: 'managed',
            adminPort: 7422,
            adminUser: 'admin',
            adminPassword: 'scenario-admin-pass-123',
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
              { id: 'c-default', name: 'A 服务器', serverId: '', configPath: cfgA, logPath: '', adminPort: 7422, enabled: true, autoReconnect: true },
              { id: 'c-two', name: 'B 服务器', serverId: '', configPath: cfgB, logPath: '', adminPort: 7423, enabled: true, autoReconnect: true },
            ],
            activeConnectionId: 'c-default',
          }, null, 2), 'utf8');
        },
      });
      check('独立实例起来了', own.ready === true);
      if (!own.ready) return;
      /* cdp 的 Runtime.evaluate 不会替我们包 async 外壳，带 await 的表达式必须自己包。 */
      const ev = (body) => own.eval(`(async () => { ${body} })()`);

      const list1 = await ev('const r = await FRP.connections(); return r.data;');
      check('看到两条连接', !!list1 && Array.isArray(list1.connections) && list1.connections.length === 2, JSON.stringify(list1 && list1.connections && list1.connections.map((c) => c.id)));
      check('当前连接是 c-default', !!list1 && list1.activeConnectionId === 'c-default', list1 && list1.activeConnectionId);

      const startedB = await ev("const r = await FRP.connectionStart('c-two'); return { ok: r.ok, error: (r.error || '').slice(0, 120) };");
      check('能单独启动非当前连接', !!startedB && startedB.ok === true, startedB && startedB.error);

      const bothUp = await ctx.waitFor(async () => {
        const r = await ev('const r = await FRP.connections(); return r.data.connections.map((c) => ({ id: c.id, mode: c.runtime.mode, pid: c.runtime.pid }));');
        return r;
      }, (rows) => Array.isArray(rows) && rows.some((c) => c.id === 'c-two' && c.mode === 'managed'), { timeout: 25000, label: 'c-two 进入 managed' });
      check('c-two 进入 managed（自己那个 frpc）', !!bothUp, JSON.stringify(bothUp));

      const startedA = await ev('const r = await FRP.startTunnel(); return { ok: r.ok, error: (r.error || "").slice(0, 120) };');
      check('当前连接也能启动', !!startedA && startedA.ok === true, startedA && startedA.error);

      const rows = await ctx.waitFor(async () => ev('const r = await FRP.connections(); return r.data.connections.map((c) => ({ id: c.id, mode: c.runtime.mode, pid: c.runtime.pid }));'),
        (v) => Array.isArray(v) && v.length === 2 && v.every((c) => c.mode === 'managed' && c.pid),
        { timeout: 25000, label: '两条都 managed' });
      check('两条连接同时 managed', Array.isArray(rows) && rows.length === 2, JSON.stringify(rows));
      const pids = new Set((rows || []).map((c) => c.pid));
      check('两条连接是两个不同的 frpc 进程', pids.size === 2, JSON.stringify([...pids]));

      for (const s of [SERVER_A, SERVER_B]) {
        const body = await fetch(`http://127.0.0.1:${s.remotePort}/`, { signal: AbortSignal.timeout(5000) }).then((r) => r.text()).catch((e) => `ERR ${e.message}`);
        check(`公网 ${s.remotePort} 指向本机服务`, body.includes('mc-ok'), body.slice(0, 30));
      }

      const stoppedB = await ev("const r = await FRP.connectionStop('c-two'); return { ok: r.ok, error: (r.error || '').slice(0, 120) };");
      check('能单独停止非当前连接', !!stoppedB && stoppedB.ok === true, stoppedB && stoppedB.error);
      const afterStop = await ctx.waitFor(async () => ev('const r = await FRP.connections(); return r.data.connections.map((c) => ({ id: c.id, mode: c.runtime.mode }));'),
        (v) => Array.isArray(v) && v.some((c) => c.id === 'c-two' && c.mode === 'stopped'), { timeout: 20000, label: 'c-two 停止' });
      const a = (afterStop || []).find((c) => c.id === 'c-default');
      check('停 c-two 之后当前连接仍在运行', !!a && a.mode === 'managed', JSON.stringify(afterStop));
      const bodyA = await fetch(`http://127.0.0.1:${SERVER_A.remotePort}/`, { signal: AbortSignal.timeout(5000) }).then((r) => r.text()).catch((e) => `ERR ${e.message}`);
      check('当前连接的公网端口仍可访问', bodyA.includes('mc-ok'), bodyA.slice(0, 30));

      await ev('await FRP.stopTunnel(); return 1;');
    } finally {
      if (own) { try { own.stop(); } catch { /* ignore */ } }
      for (const p of frpsProcs) { try { process.kill(p.pid, 'SIGKILL'); } catch { /* ignore */ } }
      local.close();
    }
  },
};
