'use strict';
/* 非当前连接「正在跑」时，外部改了它的 frpc.toml：frpc 不会自己重读。
 * 只让界面跟着变（counts.total=2）而隧道还是旧的（frpc 里 proxyCount=1）是最难自查的不一致 ——
 * 这个场景钉住「界面与实际两边都变」。
 *
 * 要一台真 frps：frpc 只有在登录成功后才把代理反映到 /api/status 里，
 * 连不上时 proxyCount 恒为 0（诊断过，见 .e2e/lab/diag-1162.cjs）。 */
const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  id: 'parked-config-reload',
  title: '外部改了正在跑的非当前连接配置，frpc 也会重新加载',
  needs: ['app', 'frps'],
  async run(ctx) {
    const frps = ctx.frps;
    if (!frps) {
      ctx.check('runner 起了 frps', false, '没有 frps');
      return;
    }
    const bindPort = Number(frps.bindPort);
    const token = frps.token;
    /* 远端端口避开 frps 的 bindPort 与 vhost 端口（bindPort+1000 / +2000）。 */
    const remote = (n) => bindPort + 5000 + n;

    let bToml = '';
    const inst = await ctx.startApp({
      cdpOffset: 16,
      seed: (dir) => {
        const ud = path.join(dir, 'frp-console-data');
        fs.mkdirSync(ud, { recursive: true });
        const aToml = path.join(dir, 'a.toml');
        bToml = path.join(dir, 'b.toml');
        const cfg = (name, remotePort, adminPort) => [
          'serverAddr = "127.0.0.1"',
          `serverPort = ${bindPort}`,
          'loginFailExit = false',
          '',
          '[auth]',
          'method = "token"',
          `token = "${token}"`,
          '',
          '[webServer]',
          'addr = "127.0.0.1"',
          `port = ${adminPort}`,
          'user = "admin"',
          'password = "reload-test-123456"',
          '',
          '[[proxies]]',
          `name = "${name}"`,
          'type = "tcp"',
          'localIP = "127.0.0.1"',
          'localPort = 18080',
          `remotePort = ${remotePort}`,
          '',
        ].join('\n');
        fs.writeFileSync(aToml, cfg('a-one', remote(1), 7441), 'utf8');
        fs.writeFileSync(bToml, cfg('b-one', remote(2), 7442), 'utf8');
        fs.writeFileSync(
          path.join(ud, 'settings.json'),
          JSON.stringify(
            {
              version: 2,
              runMode: 'managed',
              adminPort: 7441,
              adminUser: 'admin',
              adminPassword: 'reload-test-123456',
              configPath: aToml,
              logPath: path.join(ud, 'frpc.log'),
              connections: [
                { id: 'c-rel1', name: 'A 机', configPath: aToml, logPath: path.join(dir, 'a.log'), adminPort: 7441, enabled: true },
                { id: 'c-rel2', name: 'B 机', configPath: bToml, logPath: path.join(dir, 'b.log'), adminPort: 7442, enabled: true },
              ],
              activeConnectionId: 'c-rel1',
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
      const c = (d.connections || []).find((x) => /B 机/.test(x.name)) || {};
      return { mode: c.runtime && c.runtime.mode, proxyCount: (c.runtime && c.runtime.proxyCount) || 0, total: (c.counts && c.counts.total) || 0 };
    })()`);

    try {
      const started = await inst.eval(`(async () => { const r = await FRP.connectionStart('c-rel2'); return { ok: !!(r && r.ok), err: (r && r.error) || '' }; })()`);
      ctx.check('B 机（非活动连接）能启动', started.ok === true, JSON.stringify(started));

      const ready = await ctx.waitFor(
        async () => {
          const s = await read();
          return s.mode === 'managed' && Number(s.proxyCount) >= 1 ? s : null;
        },
        (v) => !!v,
        { timeout: 45000, label: 'B 机的 frpc 登录成功并列出 1 条代理' },
      );
      ctx.check('B 机的 frpc 里有 1 条代理', Number(ready.proxyCount) === 1, JSON.stringify(ready));

      fs.appendFileSync(
        bToml,
        '\n[[proxies]]\nname = "b-two"\ntype = "tcp"\nlocalIP = "127.0.0.1"\nlocalPort = 18081\nremotePort = ' + remote(3) + '\n',
        'utf8',
      );

      const after = await ctx.waitFor(
        async () => {
          const s = await read();
          return Number(s.proxyCount) >= 2 && Number(s.total) >= 2 ? s : null;
        },
        (v) => !!v,
        { timeout: 45000, label: 'B 机的 frpc 重新加载出新代理' },
      );
      ctx.check('外部改动后 frpc 里也是 2 条（界面与实际一致）', Number(after.proxyCount) === 2, `proxyCount=${after.proxyCount} total=${after.total}`);
    } finally {
      try { await inst.eval(`(async () => { try { await FRP.connectionStop('c-rel2'); } catch (e) {} return 1; })()`); } catch { /* 忽略 */ }
      inst.stop();
    }
  },
};
