'use strict';
/* 边界输入：同一个域名同时配 http 和 https 两条代理（同一站点 http+https 很常见）。
 * 1.2.109 的「域名只能给一条代理用」会把它误判成冲突（frps 其实按 vhost 端口分开路由）。 */
module.exports = {
  id: 'dual-domain',
  title: '同一域名可以各配一条 http 和 https 代理',
  needs: ['app', 'frps', 'local', 'frpc'],
  async run(ctx) {
    const { check, waitFor, eval: ev } = ctx;

    const saved = await ev(`(async () => {
      const res = await FRP.saveConfig({ serverAddr: '127.0.0.1', serverPort: ${ctx.frps.bindPort}, auth: { method: 'token', token: '${ctx.frps.token}' } });
      return { ok: !!(res && res.ok), err: (res && res.error) || '' };
    })()`);
    check('写入 frpc 配置', saved.ok, saved.err);

    const http = await ev(`(async () => {
      const res = await FRP.saveProxy('add', '', { name: 'e2e-dual-http', type: 'http', localIP: '127.0.0.1', localPort: ${ctx.local.port}, customDomains: ['dual.example.com'] });
      return { ok: !!(res && res.ok), err: (res && res.error) || '' };
    })()`);
    check('http 代理保存成功', http.ok === true, http.err);

    const https = await ev(`(async () => {
      const res = await FRP.saveProxy('add', '', { name: 'e2e-dual-https', type: 'https', localIP: '127.0.0.1', localPort: ${ctx.local.port}, customDomains: ['dual.example.com'] });
      return { ok: !!(res && res.ok), err: (res && res.error) || '' };
    })()`);
    check('同域名的 https 代理也能保存（不同 vhost 端口）', https.ok === true, https.err);

    const started = await ev(`(async () => { const res = await FRP.startTunnel(); return { ok: !!(res && res.ok), err: (res && res.error) || '' }; })()`);
    check('隧道能起来', started.ok === true, started.err);

    const both = await waitFor(
      () => ev(`(async () => {
        const r = await FRP.refresh();
        const list = (r.data.proxies || []).filter((p) => /^e2e-dual-/.test(p.name));
        return list.map((p) => ({ name: p.name, status: p.status }));
      })()`),
      (v) => Array.isArray(v) && v.length === 2 && v.every((x) => x.status === 'running'),
      { timeout: 45000, label: '两条代理都进 running' },
    );
    check('两条代理都注册进 frpc（running）', Array.isArray(both) && both.length === 2 && both.every((x) => x.status === 'running'), JSON.stringify(both));

    await ev(`(async () => { await FRP.stopTunnel(); const st = await FRP.refresh(); const d = st.data || st; for (const p of (d.proxies || [])) if (/^e2e-dual-/.test(p.name)) await FRP.deleteProxy(p.name); return 1; })()`);
  },
};
