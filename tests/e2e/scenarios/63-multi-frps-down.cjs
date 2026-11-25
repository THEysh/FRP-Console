'use strict';
/* 多连接下的「一台 frps 挂了」：另一条连接必须完全不受影响，
 * 挂掉的那条在 frps 回来后要能自己重连（不靠用户点）。
 *
 * 两台 frps 故意分处 127.0.0.1 / 127.0.0.2（Windows 上 127.0.0.0/8 全是回环）：
 * 如果实现里某处拿错了 serverAddr，探到另一台就会「假绿」，这条场景就钉不住了。 */
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
      srv.listen(port, '127.0.0.1', () => {
        const picked = port;
        srv.close(() => resolve(picked));
      });
    };
    tryPort();
  });
}

module.exports = {
  id: 'multi-frps-down',
  title: '一台 frps 挂掉：另一条连接不受影响，恢复后自己能连回',
  needs: ['app', 'frps', 'local'],
  async run(ctx) {
    const localPort = ctx.local && ctx.local.port;
    if (!localPort) { ctx.check('runner 起了本地服务', false, '没有本地服务'); return; }

    const spec = async (host, tag) => {
      const bindPort = await freePort(18100);
      const dashPort = await freePort(18500);
      if (!bindPort || !dashPort) return null;
      const dir = path.join(ctx.dataRoot, `frps-${tag}`);
      const inst = await frpsHelper.startFrps({ dir, bindPort, dashPort, token: `mf-token-${tag}-1234567890` });
      return inst ? { host, tag, bindPort, dashPort, token: `mf-token-${tag}-1234567890`, dir, inst } : null;
    };

    const A = await spec('127.0.0.1', 'a');
    const B = await spec('127.0.0.1', 'b');
    if (!A || !B) {
      ctx.skip('两台 frps 起不来（缺二进制或端口被占）');
      return;
    }

    let frpsA = A.inst;
    const writeCfg = (dir, conn, adminPort, remotePort) => [
      `serverAddr = "${conn.host}"`,
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
      'password = "mf-admin-123456"',
      '',
      '[[proxies]]',
      `name = "${conn.tag === 'a' ? 'a-one' : 'b-one'}"`,
      'type = "tcp"',
      'localIP = "127.0.0.1"',
      `localPort = ${localPort}`,
      `remotePort = ${remotePort}`,
      '',
    ].join('\n');

    const inst = await ctx.startApp({
      cdpOffset: 17,
      seed: (dir) => {
        const ud = path.join(dir, 'frp-console-data');
        fs.mkdirSync(ud, { recursive: true });
        const aToml = path.join(dir, 'a.toml');
        const bToml = path.join(dir, 'b.toml');
        fs.writeFileSync(aToml, writeCfg(dir, A, 7451, A.bindPort + 5100), 'utf8');
        fs.writeFileSync(bToml, writeCfg(dir, B, 7452, B.bindPort + 5100), 'utf8');
        fs.writeFileSync(
          path.join(ud, 'settings.json'),
          JSON.stringify(
            {
              version: 2,
              runMode: 'managed',
              adminPort: 7451,
              adminUser: 'admin',
              adminPassword: 'mf-admin-123456',
              configPath: aToml,
              logPath: path.join(ud, 'frpc.log'),
              connections: [
                { id: 'c-mf1', name: 'A 机', configPath: aToml, logPath: path.join(dir, 'a.log'), adminPort: 7451, enabled: true },
                { id: 'c-mf2', name: 'B 机', configPath: bToml, logPath: path.join(dir, 'b.log'), adminPort: 7452, enabled: true },
              ],
              activeConnectionId: 'c-mf1',
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
      const list = (d.connections || []).map((c) => ({ name: c.name, mode: c.runtime && c.runtime.mode, connected: !!(c.runtime && c.runtime.connected), online: (c.counts && c.counts.online) || 0 }));
      const a = d.connectionsAgg || {};
      return { list, agg: { running: a.running, online: a.online } };
    })()`);
    const pick = (r, re) => (r.list || []).find((c) => re.test(c.name)) || {};

    try {
      const started = await inst.eval(`(async () => {
        const r = await FRP.connections(); const d = r.data || r; const arr = d.connections || d || [];
        const out = [];
        for (const c of arr) { const s = await FRP.connectionStart(c.id); out.push({ name: c.name, ok: !!(s && s.ok) }); }
        return out;
      })()`);
      ctx.check('两条连接都启动', started.every((s) => s.ok), JSON.stringify(started));

      const up = await ctx.waitFor(
        async () => {
          const r = await read();
          return Number(pick(r, /A 机/).online) >= 1 && Number(pick(r, /B 机/).online) >= 1 ? r : null;
        },
        (v) => !!v,
        { timeout: 60000, label: '两条连接都三层全通' },
      );
      ctx.check('A 机在线', Number(pick(up, /A 机/).online) === 1, JSON.stringify(up.agg));
      ctx.check('B 机在线', Number(pick(up, /B 机/).online) === 1, JSON.stringify(up.agg));

      /* 把 A 那台 frps 杀掉 */
      frpsA.stop();
      /* 先只等 A 变未连接（挂掉的是 A 那台 frps）；B 的状态单独断言，
       * 这样失败时能一眼看出是「A 没变」还是「B 被带下水」。 */
      const down = await ctx.waitFor(
        async () => {
          const r = await read();
          return pick(r, /A 机/).connected === false ? r : null;
        },
        (v) => !!v,
        { timeout: 60000, label: 'A 机变成未连接' },
      );
      ctx.check('frps 挂掉后 A 机如实变成未连接', pick(down, /A 机/).connected === false, JSON.stringify({ a: pick(down, /A 机/), b: pick(down, /B 机/) }));
      ctx.check('B 机完全不受影响', Number(pick(down, /B 机/).online) === 1, JSON.stringify({ a: pick(down, /A 机/), b: pick(down, /B 机/) }));

      /* 把 A 那台 frps 拉回来，A 机应该自己重连（不需要用户点） */
      frpsA = await frpsHelper.startFrps({ dir: A.dir, bindPort: A.bindPort, dashPort: A.dashPort, token: A.token });
      ctx.check('A 那台 frps 重新起来', !!frpsA, `bindPort=${A.bindPort}`);
      const back = await ctx.waitFor(
        async () => {
          const r = await read();
          const a = pick(r, /A 机/);
          return a.connected === true && Number(a.online) === 1 ? r : null;
        },
        (v) => !!v,
        { timeout: 90000, label: 'A 机自动重连并恢复在线' },
      );
      ctx.check('A 机自己连回来了（无需手动点）', pick(back, /A 机/).connected === true, JSON.stringify(pick(back, /A 机/)));
      ctx.check('恢复后两条都在线', Number(pick(back, /A 机/).online) + Number(pick(back, /B 机/).online) === 2, JSON.stringify(back.agg));
    } finally {
      try { await inst.eval(`(async () => { const r = await FRP.connections(); const d = r.data || r; const arr = d.connections || d || []; for (const c of arr) { try { await FRP.connectionStop(c.id); } catch (e) {} } return 1; })()`); } catch { /* 忽略 */ }
      inst.stop();
      try { frpsA.stop(); } catch { /* 忽略 */ }
      try { B.inst.stop(); } catch { /* 忽略 */ }
    }
  },
};
