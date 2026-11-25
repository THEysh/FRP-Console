'use strict';
/* 异常网络：两条连接的 frps **同时**挂掉，再同时恢复。
 * 这一条比 63（只挂一台）更容易暴露「两条守护互相打架」：
 * 两个 supervisor 同时排重连、同时 restart，容易撞管理端口或让某条永远停在「重连中」。
 */
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const frpsHelper = require('../helpers/frps.cjs');

function freePort(start) {
  return new Promise((resolve) => {
    let port = start;
    const tryPort = () => {
      if (port > start + 200) { resolve(0); return; }
      const srv = net.createServer();
      srv.once('error', () => { port += 1; tryPort(); });
      srv.listen(port, '127.0.0.1', () => { const picked = port; srv.close(() => resolve(picked)); });
    };
    tryPort();
  });
}

function reachable(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    sock.setTimeout(800);
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => resolve(false));
    sock.once('timeout', () => { sock.destroy(); resolve(false); });
  });
}

module.exports = {
  id: 'multi-reconnect-both',
  title: '两台 frps 同时挂掉再同时恢复：两条连接都能自己回来',
  needs: ['app', 'frps', 'local'],
  async run(ctx) {
    const localPort = ctx.local && ctx.local.port;
    if (!localPort) { ctx.check('runner 起了本地服务', false, '没有本地服务'); return; }

    const mk = async (tag) => {
      const bindPort = await freePort(18300);
      const dashPort = await freePort(18700);
      if (!bindPort || !dashPort) return null;
      const dir = path.join(ctx.dataRoot, `frps-both-${tag}`);
      const inst = await frpsHelper.startFrps({ dir, bindPort, dashPort, token: `both-token-${tag}-1234567890` });
      return inst ? { tag, bindPort, dashPort, token: `both-token-${tag}-1234567890`, dir, inst } : null;
    };
    const A = await mk('a');
    const B = await mk('b');
    if (!A || !B) { ctx.skip('两台 frps 起不来'); return; }

    const cfg = (conn, adminPort, tag) => [
      'serverAddr = "127.0.0.1"',
      `serverPort = ${conn.bindPort}`,
      'loginFailExit = false',
      '',
      '[auth]',
      'method = "token"',
      `token = "${conn.token}"`,
      '',
      '[webServer]',
      'addr = "127.0.0.1"',
      `port = ${adminPort}`,
      'user = "admin"',
      'password = "both-admin-123456"',
      '',
      '[[proxies]]',
      `name = "${tag}-one"`,
      'type = "tcp"',
      'localIP = "127.0.0.1"',
      `localPort = ${localPort}`,
      `remotePort = ${conn.bindPort + 5200 + (tag === 'b' ? 100 : 0)}`,
      '',
    ].join('\n');

    const inst = await ctx.startApp({
      cdpOffset: 22,
      seed: (dir) => {
        const ud = path.join(dir, 'frp-console-data');
        fs.mkdirSync(ud, { recursive: true });
        const aToml = path.join(dir, 'a.toml');
        const bToml = path.join(dir, 'b.toml');
        fs.writeFileSync(aToml, cfg(A, 7511, 'a'), 'utf8');
        fs.writeFileSync(bToml, cfg(B, 7512, 'b'), 'utf8');
        fs.writeFileSync(
          path.join(ud, 'settings.json'),
          JSON.stringify(
            {
              version: 2,
              runMode: 'managed',
              adminPort: 7511,
              adminUser: 'admin',
              adminPassword: 'both-admin-123456',
              configPath: aToml,
              logPath: path.join(ud, 'frpc.log'),
              connections: [
                { id: 'c-bt1', name: 'A 机', configPath: aToml, logPath: path.join(dir, 'a.log'), adminPort: 7511, enabled: true },
                { id: 'c-bt2', name: 'B 机', configPath: bToml, logPath: path.join(dir, 'b.log'), adminPort: 7512, enabled: true },
              ],
              activeConnectionId: 'c-bt1',
            },
            null,
            2,
          ),
          'utf8',
        );
      },
    });

    const read = () => inst.eval(`(async () => {
      const r = await FRP.refresh(); const d = r.data || r;
      const list = (d.connections || []).map((c) => ({ name: c.name, mode: c.runtime && c.runtime.mode, connected: !!(c.runtime && c.runtime.connected), tunnelDown: !!(c.runtime && c.runtime.tunnelDown), online: (c.counts && c.counts.online) || 0, declared: c.runtime && c.runtime.declared, runningProxies: c.runtime && c.runtime.runningProxies }));
      return { list, agg: d.connectionsAgg || {} };
    })()`);
    const pick = (r, re) => (r.list || []).find((c) => re.test(c.name)) || {};
    const bothOnline = (r) => Number(pick(r, /A 机/).online) >= 1 && Number(pick(r, /B 机/).online) >= 1;
    const bothDown = (r) => pick(r, /A 机/).connected === false && pick(r, /B 机/).connected === false;

    let frpsA = A.inst;
    let frpsB = B.inst;
    try {
      const started = await inst.eval(`(async () => {
        const r = await FRP.connections(); const d = r.data || r; const arr = d.connections || d || [];
        const out = [];
        for (const c of arr) { const s = await FRP.connectionStart(c.id); out.push({ name: c.name, ok: !!(s && s.ok), err: (s && s.error) || '' }); }
        return out;
      })()`);
      ctx.check('两条连接都启动', started.every((s) => s.ok), JSON.stringify(started));

      const up = await ctx.waitFor(async () => { const r = await read(); return bothOnline(r) ? r : null; }, (v) => !!v, { timeout: 90000, label: '两条都三层全通' });
      ctx.check('两条连接都三层全通', bothOnline(up), JSON.stringify(up.agg));

      /* 同时挂掉两台 frps */
      frpsA.stop();
      frpsB.stop();
      frpsA = null;
      frpsB = null;
      await ctx.sleep(2000);
      const still = { a: await reachable(A.bindPort), b: await reachable(B.bindPort) };
      ctx.check('两台 frps 确实都停了（端口连不上）', !still.a && !still.b, JSON.stringify(still));
      /* 自己轮询而不是用 waitFor：超时的时候要能看到两条连接各自的状态。 */
      let down = null;
      for (let i = 0; i < 30; i += 1) {
        down = await read();
        if (bothDown(down)) break;
        await ctx.sleep(2000);
      }
      ctx.check('两台 frps 挂掉后两条连接都如实变未连接', bothDown(down), JSON.stringify(down.list));
      ctx.check('两条都不再报在线', Number(pick(down, /A 机/).online) === 0 && Number(pick(down, /B 机/).online) === 0, JSON.stringify(down.agg));

      /* 同时恢复 */
      frpsA = await frpsHelper.startFrps({ dir: A.dir, bindPort: A.bindPort, dashPort: A.dashPort, token: A.token });
      frpsB = await frpsHelper.startFrps({ dir: B.dir, bindPort: B.bindPort, dashPort: B.dashPort, token: B.token });
      ctx.check('两台 frps 都重新起来', !!frpsA && !!frpsB, `${!!frpsA}/${!!frpsB}`);

      const back = await ctx.waitFor(async () => { const r = await read(); return bothOnline(r) ? r : null; }, (v) => !!v, { timeout: 120000, label: '两条都自己连回来' });
      ctx.check('两条连接都自己连回来（无需手动）', bothOnline(back), JSON.stringify(back.list));
      ctx.check('恢复后没有连接卡在重连中', (back.list || []).every((c) => c.mode !== 'starting'), JSON.stringify(back.list.map((c) => c.mode)));

      /* 恢复后再等一会儿，确认不会又被守护反复重启（pid 应该稳定下来） */
      const first = await inst.eval(`(async () => { const r = await FRP.refresh(); const d = r.data || r; return (d.connections || []).map((c) => ({ name: c.name, pid: c.runtime && c.runtime.pid })); })()`);
      await ctx.sleep(12000);
      const second = await inst.eval(`(async () => { const r = await FRP.refresh(); const d = r.data || r; return (d.connections || []).map((c) => ({ name: c.name, pid: c.runtime && c.runtime.pid })); })()`);
      ctx.check('12 秒内两条的 frpc 进程没有再变（没被反复重启）', JSON.stringify(first) === JSON.stringify(second), `${JSON.stringify(first)} → ${JSON.stringify(second)}`);
    } finally {
      try { await inst.eval(`(async () => { const r = await FRP.connections(); const d = r.data || r; const arr = d.connections || d || []; for (const c of arr) { try { await FRP.connectionStop(c.id); } catch (e) {} } return 1; })()`); } catch { /* 忽略 */ }
      inst.stop();
      try { if (frpsA) frpsA.stop(); } catch { /* 忽略 */ }
      try { if (frpsB) frpsB.stop(); } catch { /* 忽略 */ }
    }
  },
};
