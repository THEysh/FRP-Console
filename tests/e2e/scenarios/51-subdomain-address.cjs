'use strict';
/* 边界输入 / 回归：服务器配了 subDomainHost 时，只填 subdomain 的代理
 * 必须显示成完整域名（publicAddress 与探测同源），且拿不到后缀时不生成 http://subdomain:xxx。
 * 1.2.158 只改了探测侧参数，显示侧漏传 subDomainHost —— 真机才暴露（1.2.160 修）。
 * 本场景自己起假 sshd（façade 的 frps.toml 带 subDomainHost），端口 22428。 */
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..', '..');
const PORT = 22428;
const SUFFIX = 'frp.example.com';

module.exports = {
  id: 'subdomain-address',
  title: '服务器配了 subDomainHost 时，subdomain 代理显示完整域名',
  needs: ['app'],
  async run(ctx) {
    const { check, sleep } = ctx;
    const sshd = spawn(
      process.execPath,
      [path.join(ROOT, 'tests', 'e2e', 'fixtures', 'fake-sshd.cjs'), String(PORT), 'mixed', 'sub-server', 'token-sub', '', '', '17000', '', '7000', '0.61.0'],
      { stdio: 'ignore', env: { ...process.env, FAKE_SUB_DOMAIN_HOST: SUFFIX } },
    );

    try {
      await sleep(1200);
      const connect = async () => {
        let last = null;
        for (let i = 0; i < 4; i++) {
          last = await ctx.eval(`(async () => {
            await FRP.serverDisconnect().catch(() => {});
            await FRP.serverForgetHost({ host: '127.0.0.1', port: ${PORT} }).catch(() => {});
            let r = await FRP.serverConnect({ host: '127.0.0.1', port: ${PORT}, username: 'root', password: 'labpass', adoptProfile: true });
            if (!r.ok && r.needsTrustHost) {
              await FRP.serverTrustHost({ host: '127.0.0.1', port: ${PORT}, fingerprint: r.needsTrustHost.fingerprint });
              r = await FRP.serverConnect({ host: '127.0.0.1', port: ${PORT}, username: 'root', password: 'labpass', adoptProfile: true });
            }
            const st = await FRP.serverState().catch(() => ({ data: {} }));
            const d = (st && st.data) || {};
            return { ok: !!r.ok, err: String(r.error || ''), connected: !!d.connected, subHost: (d.summary && d.summary.subDomainHost) || '' };
          })()`);
          if (last && last.ok && last.connected) return last;
          await sleep(700);
        }
        return last;
      };

      const c = await connect();
      check('连上假服务器', c && c.ok === true && c.connected === true, c && c.err);
      check('读到服务器的 subDomainHost', String((c && c.subHost) || '') === SUFFIX, String((c && c.subHost) || ''));

      const made = await ctx.eval(`(async () => {
        const r = await FRP.saveProxy('add', '', { name: 'e2e-sub-addr', type: 'http', localIP: '127.0.0.1', localPort: 18080, subdomain: 'demo' });
        const s = await FRP.refresh(); const d = s.data || s;
        const p = (d.proxies || []).find((x) => x.name === 'e2e-sub-addr');
        const out = { ok: !!r.ok, err: String(r.error || ''), publicAddress: p && p.publicAddress, openUrl: p && p.openUrl };
        if (p) await FRP.deleteProxy('e2e-sub-addr').catch(() => {});
        return out;
      })()`);
      check('代理能保存', made.ok === true, made.err);
      check('公网地址补上服务器后缀', /demo\.frp\.example\.com/.test(String(made.publicAddress)), String(made.publicAddress));
      check('不含协议时不会被拼成 subdomain: 前缀', !/^http:\/\/subdomain/.test(String(made.openUrl)), String(made.openUrl));

      await ctx.eval(`(async () => { await FRP.serverDisconnect().catch(() => {}); return 1; })()`);
    } finally {
      try { sshd.kill(); } catch {}
    }
  },
};
