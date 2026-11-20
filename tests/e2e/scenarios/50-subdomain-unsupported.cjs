'use strict';
/* 边界输入：只填 subdomain 而服务器没配 subDomainHost 时，
 * frpc 只回一句英文 "subdomain is not supported because this feature is not enabled in server"，
 * 我们要把它翻译成「服务器没有开启 subdomain」并给出两条出路。 */
module.exports = {
  id: 'subdomain-unsupported',
  title: '服务器没开 subdomain 时，说清原因和两种解法',
  needs: ['app', 'frps', 'local', 'frpc'],
  async run(ctx) {
    const { check, waitFor, eval: ev } = ctx;

    await ev(`(async () => {
      const res = await FRP.saveConfig({ serverAddr: '127.0.0.1', serverPort: ${ctx.frps.bindPort}, auth: { method: 'token', token: '${ctx.frps.token}' } });
      return { ok: !!(res && res.ok) };
    })()`);

    const saved = await ev(`(async () => {
      const r = await FRP.saveProxy('add', '', { name: 'e2e-sub', type: 'http', localIP: '127.0.0.1', localPort: ${ctx.local.port}, subdomain: 'demo' });
      return { ok: !!(r && r.ok), err: (r && r.error) || '', warnings: ((r.data && r.data.warnings) || []).map((w) => String(w.message || w)) };
    })()`);
    check('只填 subdomain 能保存', saved.ok === true, saved.err);

    const both = await ev(`(async () => {
      const r = await FRP.saveProxy('add', '', { name: 'e2e-sub-both', type: 'http', localIP: '127.0.0.1', localPort: ${ctx.local.port}, subdomain: 'demo2', customDomains: ['both.example.com'] });
      return { ok: !!(r && r.ok), warnings: ((r.data && r.data.warnings) || []).map((w) => String(w.message || w)) };
    })()`);
    check('同时填域名与 subdomain 时给出 subDomainHost 警告', both.warnings.some((w) => /subDomainHost/.test(w)), JSON.stringify(both.warnings).slice(0, 200));

    const started = await ev(`(async () => { const r = await FRP.startTunnel(); return { ok: !!(r && r.ok), err: (r && r.error) || '' }; })()`);
    check('隧道能起来（只是这几条代理起不来）', started.ok === true, started.err);

    const health = await waitFor(
      () => ev(`(async () => {
        const r = await FRP.refresh();
        const p = (r.data.proxies || []).find((x) => x.name === 'e2e-sub');
        return p && p.health ? { ok: p.health.ok, reason: p.health.reason, error: p.health.error, hint: p.health.layers && p.health.layers.tunnel && p.health.layers.tunnel.hint } : null;
      })()`),
      (h) => h && h.ok === false && /subdomain/.test(String(h.reason || '')),
      { timeout: 45000, label: '归因到 subdomain 未启用' },
    );
    check('失败原因翻译成「服务器没有开启 subdomain」', String(health.reason) === '服务器没有开启 subdomain', String(health.reason));
    check('提示里给出两条出路（配 subDomainHost / 改用自定义域名）', /subDomainHost/.test(String(health.hint)) && /自定义域名/.test(String(health.hint)), String(health.hint).slice(0, 200));
    check('底层仍保留 frps 的原话', /subdomain is not supported/i.test(String(health.error)), String(health.error).slice(0, 160));

    await ev(`(async () => { await FRP.stopTunnel(); const r = await FRP.refresh(); const d = r.data || r; for (const p of (d.proxies || [])) if (/^e2e-sub/.test(p.name)) await FRP.deleteProxy(p.name); return 1; })()`);
  },
};
