'use strict';
/* 边界输入：http 代理的 customDomains 直接写 IP（frp 按 Host 匹配，浏览器也能用 http://IP 访问）。
 * IP 不需要域名解析——之前会一直红着「域名没有解析」，第三层探测永远不跑。 */
module.exports = {
  id: 'ip-domain',
  title: 'customDomains 填 IP 的 http 代理能正常判绿',
  needs: ['app', 'frps', 'local', 'frpc'],
  async run(ctx) {
    const { check, waitFor, eval: ev } = ctx;
    const vhostHttp = ctx.frps.bindPort + 1000;

    await ev(`(async () => {
      await FRP.saveSettings({ vhostHttpPort: ${vhostHttp}, vhostHttpsPort: ${ctx.frps.bindPort + 2000} });
      const res = await FRP.saveConfig({ serverAddr: '127.0.0.1', serverPort: ${ctx.frps.bindPort}, auth: { method: 'token', token: '${ctx.frps.token}' } });
      return { ok: !!(res && res.ok) };
    })()`);

    const saved = await ev(`(async () => {
      const res = await FRP.saveProxy('add', '', { name: 'e2e-ip-http', type: 'http', localIP: '127.0.0.1', localPort: ${ctx.local.port}, customDomains: ['127.0.0.1'] });
      return { ok: !!(res && res.ok), err: (res && res.error) || '' };
    })()`);
    check('customDomains 填 IP 能保存', saved.ok === true, saved.err);

    const started = await ev(`(async () => { const res = await FRP.startTunnel(); return { ok: !!(res && res.ok), err: (res && res.error) || '' }; })()`);
    check('隧道能起来', started.ok === true, started.err);

    const health = await waitFor(
      () => ev(`(async () => {
        const r = await FRP.refresh();
        const p = (r.data.proxies || []).find((x) => x.name === 'e2e-ip-http');
        return p && p.health ? { ok: p.health.ok, reason: p.health.reason, dns: p.health.layers && p.health.layers.dns, pub: p.health.layers && p.health.layers.public } : null;
      })()`),
      (h) => h && h.ok === true,
      { timeout: 60000, label: 'IP 域名的 http 代理三层全通' },
    );
    check('健康检查判绿（而不是「域名没有解析」）', health.ok === true, health.reason);
    check('DNS 层不再报错（IP 不需要解析）', !health.dns || health.dns.ok !== false, JSON.stringify(health.dns || null).slice(0, 200));
    check('公网层拿到 200', Number(health.pub && health.pub.status) === 200, JSON.stringify(health.pub || null).slice(0, 200));

    await ev(`(async () => { await FRP.stopTunnel(); const r = await FRP.refresh(); const d = r.data || r; for (const p of (d.proxies || [])) if (p.name === 'e2e-ip-http') await FRP.deleteProxy(p.name); return 1; })()`);
  },
};
