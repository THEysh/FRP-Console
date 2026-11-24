'use strict';
/* 多连接下的「证书部署到哪台服务器」：域名属于连接 A（frpc 连 10.9.9.9），
 * 现在 SSH 连的却是 127.0.0.1 —— 部署上去没有意义（frps 不在这台机器上）。
 * 1.2.172 之前会照样写进当前服务器并报成功。 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const TLS = path.join(ROOT, '.e2e', 'lab', 'tls');
const DOMAIN = 'cert-owner.lab';

module.exports = {
  id: 'cert-owner',
  title: '证书只能部署到发布该域名的那条连接所在的服务器',
  needs: ['app', 'sshd'],
  async run(ctx) {
    const { check } = ctx;

    const inst = await ctx.startApp({
      cdpOffset: 5,
      seed: (dir) => {
        const ud = path.join(dir, 'frp-console-data');
        fs.mkdirSync(ud, { recursive: true });
        const activeToml = path.join(ud, 'frpc.toml');
        fs.writeFileSync(
          activeToml,
          [
            'serverAddr = "10.9.9.9"',
            'serverPort = 7000',
            'webServer.addr = "127.0.0.1"',
            'webServer.port = 7470',
            'webServer.user = "admin"',
            'webServer.password = "cert-owner-pass-123"',
            '',
            '[[proxies]]',
            'name = "owner-site"',
            'type = "http"',
            'localIP = "127.0.0.1"',
            'localPort = 18080',
            'customDomains = ["cert-owner.lab"]',
            '',
          ].join('\n'),
          'utf8',
        );
        fs.writeFileSync(
          path.join(ud, 'settings.json'),
          JSON.stringify(
            {
              version: 2,
              frpcPath: path.join(dir, 'frpc.exe'),
              configPath: activeToml,
              logPath: path.join(ud, 'frpc.log'),
              runMode: 'managed',
              adminPort: 7470,
              adminUser: 'admin',
              adminPassword: 'cert-owner-pass-123',
              pollIntervalMs: 2000,
              connections: [
                { id: 'c-default', name: '甲机（10.9.9.9）', configPath: activeToml, adminPort: 7470, enabled: true },
                { id: 'c-two', name: '乙机', configPath: path.join(ud, 'other.toml'), adminPort: 7471, enabled: false },
              ],
              activeConnectionId: 'c-default',
            },
            null,
            2,
          ),
          'utf8',
        );
        /* 一张「本机已有」的证书：acme.list() 只认 metadata.json + fullchain.pem + key.pem */
        const certDir = path.join(ud, 'certs', DOMAIN);
        fs.mkdirSync(certDir, { recursive: true });
        fs.writeFileSync(path.join(certDir, 'metadata.json'), JSON.stringify({ domains: [DOMAIN], email: 't@example.com', issuedAt: Date.now() }, null, 2), 'utf8');
        fs.copyFileSync(path.join(TLS, 'cert.pem'), path.join(certDir, 'fullchain.pem'));
        fs.copyFileSync(path.join(TLS, 'key.pem'), path.join(certDir, 'key.pem'));
      },
    });

    try {
      const connected = await inst.eval(`(async () => {
        for (let i = 0; i < 40 && !document.querySelector('.nav-item[data-view="server"]'); i += 1) await new Promise((r) => setTimeout(r, 250));
        const res = await FRP.serverConnect({ host: '127.0.0.1', port: ${ctx.sshPort}, username: 'root', password: 'labpass', adoptProfile: false });
        return !!(res && res.ok);
      })()`);
      check('先连上（假）服务器', connected === true);

      const certs = await inst.eval(`(async () => { const r = await FRP.certList(); return { ok: !!(r && r.ok), n: ((r && r.data && r.data.certs) || []).length }; })()`);
      check('本机证书列表里能看到这张证书', certs.n >= 1, JSON.stringify(certs));

      /* ① 域名属于 10.9.9.9 那条连接，SSH 连的是 127.0.0.1 → 必须被拦下 */
      const blocked = await inst.eval(`(async () => {
        const r = await FRP.certNginxSync({ domain: '${DOMAIN}' });
        return { ok: !!(r && r.ok), error: (r && r.error) || '', needsForce: !!(r && r.needsForce), owner: (r && r.owner) || null };
      })()`);
      check('跨服务器部署被拦下', blocked.ok === false, JSON.stringify(blocked).slice(0, 240));
      check('拦下时带 needsForce', blocked.needsForce === true, JSON.stringify(blocked.needsForce));
      check('错误里点名了两台服务器', /10\.9\.9\.9/.test(blocked.error) && /127\.0\.0\.1/.test(blocked.error), blocked.error);
      check('带上归属连接的名字', !!(blocked.owner && /甲机/.test(blocked.owner.name || '')), JSON.stringify(blocked.owner));

      /* ② force 之后不该再被同一条守卫拦住（后续失败只能来自 nginx/证书本身） */
      const forced = await inst.eval(`(async () => {
        const r = await FRP.certNginxSync({ domain: '${DOMAIN}', force: true });
        return { ok: !!(r && r.ok), error: (r && r.error) || '', needsForce: !!(r && r.needsForce) };
      })()`);
      check('force 后不再被跨连接守卫拦住', forced.needsForce !== true && !/属于连接/.test(forced.error), JSON.stringify(forced).slice(0, 240));
    } finally {
      await inst.eval(`(async () => { try { await FRP.serverDisconnect(); } catch (e) { /* 忽略 */ } return true; })()`).catch(() => {});
      await inst.stop();
    }
  },
};
