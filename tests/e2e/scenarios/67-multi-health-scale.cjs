'use strict';
/* 健康检查的「每条连接都要覆盖全部代理」：早期版本对整份配置只检查前 16 条，
 * 多连接改造后又多了「每条连接各自 16 条」的风险。这里两条连接各 18 条代理，
 * 要求两条连接的 unchecked 都归零、且每条都在线。 */
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

const PER_CONN = 18;

module.exports = {
  id: 'multi-health-scale',
  title: '两条连接各 18 条代理：健康检查全部覆盖，不留未检测',
  needs: ['app', 'frps', 'local'],
  async run(ctx) {
    const localPort = ctx.local && ctx.local.port;
    if (!localPort) { ctx.check('runner 起了本地服务', false, '没有本地服务'); return; }

    const mkFrps = async (tag) => {
      const bindPort = await freePort(18200);
      const dashPort = await freePort(18600);
      if (!bindPort || !dashPort) return null;
      const dir = path.join(ctx.dataRoot, `frps-scale-${tag}`);
      const inst = await frpsHelper.startFrps({ dir, bindPort, dashPort, token: `sc-token-${tag}-1234567890` });
      return inst ? { tag, bindPort, dashPort, token: `sc-token-${tag}-1234567890`, dir, inst } : null;
    };
    const A = await mkFrps('a');
    const B = await mkFrps('b');
    if (!A || !B) { ctx.skip('两台 frps 起不来'); return; }

    const cfgFor = (conn, adminPort) => {
      const lines = [
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
        'password = "scale-admin-123456"',
        '',
      ];
      for (let i = 1; i <= PER_CONN; i += 1) {
        lines.push(
          '[[proxies]]',
          `name = "${conn.tag}-p${i}"`,
          'type = "tcp"',
          'localIP = "127.0.0.1"',
          `localPort = ${localPort}`,
          /* 两台 frps 的 bindPort 只差几号，+5000 后两边的远端端口会重叠；B 再偏 100 避开。 */
          `remotePort = ${conn.bindPort + 5000 + i + (conn.tag === 'b' ? 100 : 0)}`,
          '',
        );
      }
      return lines.join('\n');
    };

    const inst = await ctx.startApp({
      cdpOffset: 21,
      seed: (dir) => {
        const ud = path.join(dir, 'frp-console-data');
        fs.mkdirSync(ud, { recursive: true });
        const aToml = path.join(dir, 'a.toml');
        const bToml = path.join(dir, 'b.toml');
        fs.writeFileSync(aToml, cfgFor(A, 7501), 'utf8');
        fs.writeFileSync(bToml, cfgFor(B, 7502), 'utf8');
        fs.writeFileSync(
          path.join(ud, 'settings.json'),
          JSON.stringify(
            {
              version: 2,
              runMode: 'managed',
              adminPort: 7501,
              adminUser: 'admin',
              adminPassword: 'scale-admin-123456',
              configPath: aToml,
              logPath: path.join(ud, 'frpc.log'),
              connections: [
                { id: 'c-sc1', name: 'A 机', configPath: aToml, logPath: path.join(dir, 'a.log'), adminPort: 7501, enabled: true },
                { id: 'c-sc2', name: 'B 机', configPath: bToml, logPath: path.join(dir, 'b.log'), adminPort: 7502, enabled: true },
              ],
              activeConnectionId: 'c-sc1',
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
      const list = (d.connections || []).map((c) => ({ name: c.name, counts: c.counts || {} }));
      return { list, agg: d.connectionsAgg || {} };
    })()`);
    const pick = (r, re) => (r.list || []).find((c) => re.test(c.name)) || { counts: {} };

    try {
      const started = await inst.eval(`(async () => {
        const r = await FRP.connections(); const d = r.data || r; const arr = d.connections || d || [];
        const out = [];
        for (const c of arr) { const s = await FRP.connectionStart(c.id); out.push({ name: c.name, ok: !!(s && s.ok), err: (s && s.error) || '' }); }
        return out;
      })()`);
      ctx.check('两条连接都启动', started.every((s) => s.ok), JSON.stringify(started));

      const covered = await ctx.waitFor(
        async () => {
          const r = await read();
          const a = pick(r, /A 机/).counts || {};
          const b = pick(r, /B 机/).counts || {};
          const done = Number(a.total) === PER_CONN && Number(b.total) === PER_CONN && Number(a.unchecked) === 0 && Number(b.unchecked) === 0;
          return done ? r : null;
        },
        (v) => !!v,
        { timeout: 120000, label: '两条连接的 18 条代理都检查完' },
      );
      const a = pick(covered, /A 机/).counts;
      const b = pick(covered, /B 机/).counts;
      ctx.check('A 机的 18 条全部检查过', Number(a.total) === PER_CONN && Number(a.unchecked) === 0, JSON.stringify(a));
      ctx.check('B 机的 18 条全部检查过', Number(b.total) === PER_CONN && Number(b.unchecked) === 0, JSON.stringify(b));
      ctx.check('A 机 18 条全部在线', Number(a.online) === PER_CONN, JSON.stringify(a));
      ctx.check('B 机 18 条全部在线', Number(b.online) === PER_CONN, JSON.stringify(b));
      ctx.check('没有任何异常项', Number(a.unhealthy) === 0 && Number(b.unhealthy) === 0, JSON.stringify({ a, b }));
    } finally {
      try { await inst.eval(`(async () => { const r = await FRP.connections(); const d = r.data || r; const arr = d.connections || d || []; for (const c of arr) { try { await FRP.connectionStop(c.id); } catch (e) {} } return 1; })()`); } catch { /* 忽略 */ }
      inst.stop();
      try { A.inst.stop(); } catch { /* 忽略 */ }
      try { B.inst.stop(); } catch { /* 忽略 */ }
    }
  },
};
