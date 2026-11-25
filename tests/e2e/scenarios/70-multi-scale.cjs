'use strict';
/* 规模：两条连接各 120 条代理（共 240）。看三件事：
 * ① 状态构建/往返不因代理多而变慢（refresh < 2500ms）；
 * ② 两条连接的代理数都对得上（不会只算当前连接）；
 * ③ 健康检查在两条连接上都把 120 条检查完（unchecked → 0），不再有「只查前 16 条」。 */
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const frpsHelper = require('../helpers/frps.cjs');

const PER = 120;

function freePort(start) {
  return new Promise((resolve) => {
    let port = start;
    const t = () => {
      if (port > start + 200) { resolve(0); return; }
      const srv = net.createServer();
      srv.once('error', () => { port += 1; t(); });
      srv.listen(port, '127.0.0.1', () => { const p = port; srv.close(() => resolve(p)); });
    };
    t();
  });
}

module.exports = {
  id: 'multi-scale',
  title: '两条连接各 120 条代理：状态构建不慢、健康检查全部覆盖',
  needs: ['app', 'frps', 'local'],
  async run(ctx) {
    const localPort = ctx.local && ctx.local.port;
    if (!localPort) { ctx.check('runner 起了本地服务', false, '没有本地服务'); return; }

    const mk = async (tag) => {
      const bindPort = await freePort(18400);
      const dashPort = await freePort(18800);
      if (!bindPort || !dashPort) return null;
      const dir = path.join(ctx.dataRoot, `frps-scale2-${tag}`);
      const inst = await frpsHelper.startFrps({ dir, bindPort, dashPort, token: `s2-token-${tag}-1234567890` });
      return inst ? { tag, bindPort, dashPort, token: `s2-token-${tag}-1234567890`, dir, inst } : null;
    };
    const A = await mk('a');
    const B = await mk('b');
    if (!A || !B) { ctx.skip('两台 frps 起不来'); return; }

    const cfg = (conn, adminPort) => {
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
        'password = "s2-admin-123456"',
        '',
      ];
      for (let i = 1; i <= PER; i += 1) {
        lines.push(
          '[[proxies]]',
          `name = "${conn.tag}-n${String(i).padStart(3, '0')}"`,
          'type = "tcp"',
          'localIP = "127.0.0.1"',
          `localPort = ${localPort}`,
          `remotePort = ${conn.bindPort + 5000 + i + (conn.tag === 'b' ? 200 : 0)}`,
          '',
        );
      }
      return lines.join('\n');
    };

    const inst = await ctx.startApp({
      cdpOffset: 24,
      seed: (dir) => {
        const ud = path.join(dir, 'frp-console-data');
        fs.mkdirSync(ud, { recursive: true });
        const aToml = path.join(dir, 'a.toml');
        const bToml = path.join(dir, 'b.toml');
        fs.writeFileSync(aToml, cfg(A, 7521), 'utf8');
        fs.writeFileSync(bToml, cfg(B, 7522), 'utf8');
        fs.writeFileSync(
          path.join(ud, 'settings.json'),
          JSON.stringify(
            {
              version: 2,
              runMode: 'managed',
              adminPort: 7521,
              adminUser: 'admin',
              adminPassword: 's2-admin-123456',
              configPath: aToml,
              logPath: path.join(ud, 'frpc.log'),
              connections: [
                { id: 'c-s21', name: 'A 机', configPath: aToml, logPath: path.join(dir, 'a.log'), adminPort: 7521, enabled: true },
                { id: 'c-s22', name: 'B 机', configPath: bToml, logPath: path.join(dir, 'b.log'), adminPort: 7522, enabled: true },
              ],
              activeConnectionId: 'c-s21',
            },
            null,
            2,
          ),
          'utf8',
        );
      },
    });

    try {
      /* ① refresh 耗时（取三次的中位数） */
      const times = [];
      let snapshot = null;
      for (let i = 0; i < 3; i += 1) {
        const res = await inst.eval(`(async () => {
          const t0 = performance.now();
          const r = await FRP.refresh();
          const ms = performance.now() - t0;
          const d = r.data || r;
          return { ms, active: (d.config && d.config.proxies || []).length, list: (d.connections || []).map((c) => ({ name: c.name, total: (c.counts && c.counts.total) || 0 })) };
        })()`);
        times.push(res.ms);
        snapshot = res;
      }
      times.sort((a, b) => a - b);
      const median = times[1];
      ctx.check('refresh 中位耗时 < 2500ms', median < 2500, `${times.map((t) => Math.round(t)).join('/')} ms`);
      ctx.check('当前连接的 120 条代理都在', snapshot.active === PER, String(snapshot.active));
      const aTotal = (snapshot.list.find((c) => /A 机/.test(c.name)) || {}).total;
      const bTotal = (snapshot.list.find((c) => /B 机/.test(c.name)) || {}).total;
      ctx.check('两条连接各 120 条都统计到', Number(aTotal) === PER && Number(bTotal) === PER, `A=${aTotal} B=${bTotal}`);

      /* ② 启动两条隧道 */
      const started = await inst.eval(`(async () => {
        const r = await FRP.connections(); const d = r.data || r; const arr = d.connections || d || [];
        const out = [];
        for (const c of arr) { const s = await FRP.connectionStart(c.id); out.push({ name: c.name, ok: !!(s && s.ok), err: (s && s.error) || '' }); }
        return out;
      })()`);
      ctx.check('两条连接都启动', started.every((s) => s.ok), JSON.stringify(started));

      /* ③ 健康检查把两侧都检查完（给足 150 秒：每轮有预算，240 条要跑几轮） */
      const covered = await ctx.waitFor(
        async () => {
          const r = await inst.eval(`(async () => { const x = await FRP.refresh(); const d = x.data || x; const list = (d.connections || []).map((c) => ({ name: c.name, counts: c.counts || {} })); return { list }; })()`);
          const a = (r.list.find((c) => /A 机/.test(c.name)) || { counts: {} }).counts;
          const b = (r.list.find((c) => /B 机/.test(c.name)) || { counts: {} }).counts;
          return Number(a.total) === PER && Number(b.total) === PER && Number(a.unchecked) === 0 && Number(b.unchecked) === 0 ? { a, b } : null;
        },
        (v) => !!v,
        { timeout: 150000, label: '两条连接的 120 条都检查完' },
      );
      ctx.check('A 机 120 条全部检查过', Number(covered.a.unchecked) === 0, JSON.stringify(covered.a));
      ctx.check('B 机 120 条全部检查过', Number(covered.b.unchecked) === 0, JSON.stringify(covered.b));
      // eslint-disable-next-line no-console
      console.log('    · 规模数据：refresh ' + Math.round(median) + 'ms（' + times.map((t) => Math.round(t)).join('/') + '），A=' + JSON.stringify(covered.a) + ' B=' + JSON.stringify(covered.b));
      ctx.check('两侧都没有因为规模而超时（unhealthy 为 0）', Number(covered.a.unhealthy) === 0 && Number(covered.b.unhealthy) === 0, JSON.stringify({ a: covered.a, b: covered.b }));
    } finally {
      try { await inst.eval(`(async () => { const r = await FRP.connections(); const d = r.data || r; const arr = d.connections || d || []; for (const c of arr) { try { await FRP.connectionStop(c.id); } catch (e) {} } return 1; })()`); } catch { /* 忽略 */ }
      inst.stop();
      try { A.inst.stop(); } catch { /* 忽略 */ }
      try { B.inst.stop(); } catch { /* 忽略 */ }
    }
  },
};
