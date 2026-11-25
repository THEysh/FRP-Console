'use strict';
/* 「部署证书到服务器 nginx」的成功路径。
 * 加它的原因：1.2.183 里 syncCertToServerNginx 调用了不存在的 activeConnection()，
 * 一进函数就抛 ReferenceError —— 而当时的场景只覆盖了「跨连接被拦」那条 early-return，
 * 成功路径没有任何自动化覆盖，所以这个回归一直发到了线上。 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const TLS = path.join(ROOT, 'tests', 'e2e', 'fixtures', 'tls');
const DOMAIN = 'e2e-cert.lab';

module.exports = {
  id: 'cert-deploy',
  title: '证书部署到服务器 nginx（成功路径 + 部署记录）',
  needs: ['app'],
  async run(ctx) {
    const { check } = ctx;

    /* 自己起一台「已经开了 vhost 端口」的假服务器：部署证书时不需要改写 frps.toml */
    const SSH_PORT = 22456;
    const sshd = spawn(process.execPath, [path.join(ROOT, 'tests', 'e2e', 'fixtures', 'fake-sshd.cjs'), String(SSH_PORT), 'mixed', 'cert-deploy-srv', 'labpass', '1.26.3', 'none', '7000'], { env: { ...process.env, FAKE_VHOST_PORTS: '8080,8443' }, stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 1500));

    const inst = await ctx.startApp({
      cdpOffset: 6,
      seed: (dir) => {
        const ud = path.join(dir, 'frp-console-data');
        fs.mkdirSync(ud, { recursive: true });
        const toml = path.join(ud, 'frpc.toml');
        fs.writeFileSync(
          toml,
          [
            'serverAddr = "127.0.0.1"',
            'serverPort = 7000',
            'webServer.addr = "127.0.0.1"',
            'webServer.port = 7472',
            'webServer.user = "admin"',
            'webServer.password = "cert-deploy-pass-123"',
            '',
            '[[proxies]]',
            'name = "deploy-site"',
            'type = "http"',
            'localIP = "127.0.0.1"',
            'localPort = 18080',
            `customDomains = ["${DOMAIN}"]`,
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
              configPath: toml,
              logPath: path.join(ud, 'frpc.log'),
              runMode: 'managed',
              adminPort: 7472,
              adminUser: 'admin',
              adminPassword: 'cert-deploy-pass-123',
              pollIntervalMs: 2000,
            },
            null,
            2,
          ),
          'utf8',
        );
        /* 一张「本机已有」的证书：acme.list() 只认 metadata.json + fullchain.pem + key.pem */
        const certDir = path.join(ud, 'certs', DOMAIN);
        fs.mkdirSync(certDir, { recursive: true });
        fs.writeFileSync(
          path.join(certDir, 'metadata.json'),
          JSON.stringify({ domains: [DOMAIN], email: 'e2e@example.com', issuedAt: Date.now() }, null, 2),
          'utf8',
        );
        fs.copyFileSync(path.join(TLS, 'fullchain.pem'), path.join(certDir, 'fullchain.pem'));
        fs.copyFileSync(path.join(TLS, 'key.pem'), path.join(certDir, 'key.pem'));
      },
    });

    try {
      const connected = await inst.eval(`(async () => {
        for (let i = 0; i < 40 && !document.querySelector('.nav-item[data-view="server"]'); i += 1) await new Promise((r) => setTimeout(r, 250));
        const res = await FRP.serverConnect({ host: '127.0.0.1', port: ${SSH_PORT}, username: 'root', password: 'labpass', adoptProfile: false });
        return !!(res && res.ok);
      })()`);
      check('连上（假）服务器', connected === true);

      const listed = await inst.eval(`(async () => { const r = await FRP.certList(); const l = ((r && r.data && r.data.certs) || []); const me = l.find((c) => c.domain === '${DOMAIN}'); return { ok: !!(r && r.ok), found: !!me, exists: !!(me && me.exists) }; })()`);
      check('证书列表能看到这张证书且文件齐全', listed.found && listed.exists, JSON.stringify(listed));

      /* 关键断言：成功路径不能抛异常（1.2.183 就是在这里炸） */
      const deployed = await inst.eval(`(async () => {
        try {
          const r = await FRP.certNginxSync({ domain: '${DOMAIN}' });
          return { ok: !!(r && r.ok), error: (r && r.error) || '', names: ((r && r.data && r.data.serverNames) || []), threw: '' };
        } catch (e) { return { ok: false, error: '', names: [], threw: String((e && e.message) || e) }; }
      })()`);
      check('部署没有抛异常', !deployed.threw, deployed.threw);
      check('部署返回 ok', deployed.ok === true, JSON.stringify(deployed).slice(0, 240));
      check('serverNames 里带上了这个域名', JSON.stringify(deployed.names).includes(DOMAIN), JSON.stringify(deployed.names));

      /* 部署记录要回写到本机 metadata（1.2.184 起带 notAfter，用于「续期后自动补部署」） */
      const rec = await inst.eval(`(async () => { const r = await FRP.certList(); const me = ((r && r.data && r.data.certs) || []).find((c) => c.domain === '${DOMAIN}'); return { nginx: (me && me.nginx) || null }; })()`);
      check('部署记录里有 serverHost', !!(rec.nginx && rec.nginx.serverHost === '127.0.0.1'), JSON.stringify(rec.nginx).slice(0, 200));
      check('部署记录里有 notAfter（补部署靠它判断新旧）', !!(rec.nginx && rec.nginx.notAfter), JSON.stringify(rec.nginx).slice(0, 200));
    } finally {
      await inst.eval(`(async () => { try { await FRP.serverDisconnect(); } catch (e) { /* 忽略 */ } return true; })()`).catch(() => {});
      try { sshd.kill(); } catch (e) { /* 忽略 */ }
      await inst.stop();
    }
  },
};
