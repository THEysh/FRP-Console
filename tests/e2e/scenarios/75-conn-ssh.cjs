'use strict';
/* 1.2.192：连接自带 SSH 事实 + 连上后回写 + 上限 16。
 *
 * 1) 老数据：连接只有 serverId → 启动时按档案补 host/port/username（本场景用 seed 造）；
 * 2) connections:update 能改 SSH 三件套；
 * 3) 只给 connectionId 不传 host 也能连上（用连接自己的地址），连上后回写 settings；
 * 4) 第 17 条连接被拒。
 */
const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  id: '75-conn-ssh',
  title: '连接自带 SSH 事实：老数据迁移 / 只凭连接连接 / 上限 16',
  needs: ['app', 'sshd'],
  async run(ctx) {
    const { check } = ctx;
    let inst = null;
    try {
      inst = await ctx.startApp({
        cdpOffset: 5,
        seed: (dir) => {
          const work = path.join(dir, 'cs');
          fs.mkdirSync(work, { recursive: true });
          const cfg = path.join(work, 'a.toml');
          fs.writeFileSync(cfg, [
            'serverAddr = "127.0.0.1"',
            'serverPort = 18600',
            'loginFailExit = false',
            '',
            '[auth]',
            'method = "token"',
            'token = "cs-token-1234567890"',
            '',
            '[webServer]',
            'addr = "127.0.0.1"',
            'port = 7454',
            'user = "admin"',
            'password = "admin"',
            '',
          ].join('\n'), 'utf8');
          const ud = path.join(dir, 'frp-console-data');
          fs.mkdirSync(ud, { recursive: true });
          fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({
            version: 2,
            runMode: 'managed',
            adminPort: 7454,
            adminUser: 'admin',
            adminPassword: 'cs-admin-pass-1234',
            configPath: cfg,
            logPath: path.join(work, 'a.log'),
            /* 老形态：连接只有 serverId，SSH 地址在 servers[] 里。 */
            servers: [{ id: 'srv-legacy', name: '老档案', host: '127.0.0.1', port: 2299, username: 'root', clientPort: 18600 }],
            connections: [{ id: 'c-default', serverId: 'srv-legacy', name: '老连接', configPath: cfg, logPath: path.join(work, 'a.log'), adminPort: 7454, enabled: true }],
            activeConnectionId: 'c-default',
          }, null, 2), 'utf8');
        },
      });

      const state = JSON.parse(await inst.eval(`(async()=>{
        const s = await FRP.refresh(); const st = s && s.data ? s.data : s;
        const c = (st.connections||[])[0] || {};
        return JSON.stringify({ host: c.host, port: c.port, username: c.username });
      })()`));
      check('老数据的连接从档案补上了 SSH 地址', state.host === '127.0.0.1' && state.port === 2299 && state.username === 'root', JSON.stringify(state));

      /* 改成真正能连的 fake sshd 端口，然后只凭 connectionId 连接 */
      const upd = JSON.parse(await inst.eval(`(async()=>JSON.stringify(await FRP.connectionUpdate({ id: 'c-default', host: '127.0.0.1', port: ${ctx.sshPort}, username: 'root' })))()`));
      check('connections:update 可以改 SSH 端口', upd.ok === true && upd.data && upd.data.connection && upd.data.connection.port === ctx.sshPort, JSON.stringify(upd).slice(0, 200));

      const conn = JSON.parse(await inst.eval(`(async()=>{
        const r = await FRP.serverConnect({ connectionId: 'c-default', password: 'labpass', adoptProfile: false, remember: false });
        return JSON.stringify({ ok: r.ok, hostname: r.ok && r.data && r.data.info ? r.data.info.hostname : '', error: String(r.error || '').slice(0, 120) });
      })()`));
      check('只给 connectionId 也能连上（地址来自连接自己）', conn.ok === true, JSON.stringify(conn));

      const back = JSON.parse(await inst.eval(`(async()=>{
        const s = await FRP.refresh(); const st = s && s.data ? s.data : s;
        const c = (st.connections||[])[0] || {};
        return JSON.stringify({ host: c.host, port: c.port });
      })()`));
      check('连上后连接记住了这台机器', back.host === '127.0.0.1' && Number(back.port) === ctx.sshPort, JSON.stringify(back));

      /* 上限 16 */
      const grow = JSON.parse(await inst.eval(`(async()=>{
        let added = 0; let lastErr = '';
        for (let i = 0; i < 20; i += 1) {
          const r = await FRP.connectionAdd({ name: '多连接' + i });
          if (r && r.ok) added += 1; else { lastErr = String(r && r.error || ''); break; }
        }
        const s = await FRP.refresh(); const st = s && s.data ? s.data : s;
        return JSON.stringify({ added, lastErr, total: (st.connections||[]).length });
      })()`));
      check('上限是 16 条', grow.total === 16, JSON.stringify(grow));
      check('第 17 条被拒并说明原因', /16/.test(grow.lastErr), grow.lastErr);
    } finally {
      if (inst) { try { await inst.stop(); } catch {} }
    }
  },
};
