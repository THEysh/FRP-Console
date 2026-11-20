'use strict';
/* 边界输入：插件代理的证书文件存在但内容不是 PEM（选错文件/空文件/被截断）。
 * frpc 会因为解析失败拒绝整份配置，所以启动前必须拦住并说清是哪个文件。 */
const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  id: 'plugin-cert',
  title: '插件代理的证书不是 PEM 时启动前就被拦住',
  needs: ['app'],
  async run(ctx) {
    const dir = path.join(ctx.dataDir, 'badcert');
    fs.mkdirSync(dir, { recursive: true });
    const crt = path.join(dir, 'bad.pem');
    const key = path.join(dir, 'bad.key');
    fs.writeFileSync(crt, 'this is not a certificate\n', 'utf8');
    fs.writeFileSync(key, 'this is not a key\n', 'utf8');

    let created = false;
    try {
      await ctx.eval(`(async () => {
        await FRP.saveConfig({ serverAddr: '127.0.0.1', serverPort: 7000, auth: { method: 'token', token: 'pem-token-1234567890' } });
        return 1;
      })()`);

      const saved = await ctx.eval(`(async () => {
        const r = await FRP.saveProxy('add', '', {
          name: 'bad-pem', type: 'https', localIP: '127.0.0.1', localPort: 18080,
          customDomains: ['bad-pem.example.com'],
          plugin: { type: 'https2http', crtPath: ${JSON.stringify(crt)}, keyPath: ${JSON.stringify(key)} },
        });
        return { ok: r.ok, err: String(r.error || '').slice(0, 200) };
      })()`);
      created = saved.ok === true;

      /* localAddr 兜底：插件对象里没有 localAddr，也应当按 localIP:localPort 写进配置 */
      const confPath = await ctx.eval(`(async () => { const r = await FRP.init(); return String(r.data.state.paths.configPath || ''); })()`);
      const toml = fs.readFileSync(confPath, 'utf8');
      ctx.check('配置里补上了 localAddr', /localAddr = "127\.0\.0\.1:18080"/.test(toml), toml.split('\n').filter((l) => l.includes('localAddr')).join(' | '));

      const started = await ctx.eval(`(async () => { const r = await FRP.startTunnel(); return { ok: r.ok, err: String(r.error || '').slice(0, 240) }; })()`);
      ctx.check('启动被拦下', started.ok === false, `ok=${started.ok}`);
      ctx.check('理由点名 PEM 格式', /不是 PEM 格式/.test(started.err), started.err);
      ctx.check('两个文件都点名了', started.err.includes('bad.pem') && started.err.includes('bad.key'), started.err);
    } finally {
      await ctx.eval(`(async () => { await FRP.stopTunnel(); return 1; })()`).catch(() => {});
      if (created) await ctx.eval(`(async () => { await FRP.deleteProxy('bad-pem'); return 1; })()`).catch(() => {});
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
};
