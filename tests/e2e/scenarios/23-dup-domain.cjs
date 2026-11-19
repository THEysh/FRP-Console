'use strict';
/* 边界输入：两条 http 代理抢同一个 customDomains。
 * 界面/校验层必须当场拒绝，而不是等 frpc 起来后报 router config conflict。 */
module.exports = {
  id: 'dup-domain',
  title: '两条代理抢同一个域名时会被挡住',
  needs: ['app'],
  async run(ctx) {
    /* 先给出隧道目标：没有 serverAddr 时保存代理会被「服务器地址不能为空」挡住，
     * 那样测的就不是域名冲突了。 */
    await ctx.eval(`(async () => { await FRP.saveConfig({ serverAddr: '127.0.0.1', serverPort: 7000, auth: { method: 'token', token: 'dup-token-1234567890' } }); return 1; })()`);
    const DOMAIN = 'dup-e2e.example.com';
    const created = [];
    const add = async (name, domain) => {
      const res = await ctx.eval(`(async () => {
        const r = await FRP.saveProxy('add', '', { name: ${JSON.stringify(name)}, type: 'http', localIP: '127.0.0.1', localPort: 18080, customDomains: [${JSON.stringify(domain)}] });
        return { ok: r.ok, err: String(r.error || '') };
      })()`);
      if (res.ok) created.push(name);
      return res;
    };

    try {
      const first = await add('dup-e2e-a', DOMAIN);
      ctx.check('第一条 http 代理可以创建', first.ok === true, first.err);

      const second = await add('dup-e2e-b', DOMAIN);
      ctx.check('第二条同域名代理被拒绝', second.ok === false, `ok=${second.ok}`);
      ctx.check('拒绝理由点名冲突域名', /域名/.test(second.err) && second.err.includes(DOMAIN), second.err);
      ctx.check('拒绝理由指出被谁占用', second.err.includes('dup-e2e-a'), second.err);

      /* 反向确认：换个域名就能建，说明不是把 http 代理整体挡死了 */
      const other = await add('dup-e2e-c', 'dup-e2e-other.example.com');
      ctx.check('换一个域名可以正常创建', other.ok === true, other.err);

      /* 大小写不同也算同一个域名（DNS 不区分大小写） */
      const upper = await add('dup-e2e-d', DOMAIN.toUpperCase());
      ctx.check('大小写不同仍算冲突', upper.ok === false, `ok=${upper.ok} ${upper.err}`);

      const total = await ctx.eval(`(async () => { const r = await FRP.refresh(); return (r.data.proxies || []).filter((p) => p.name.startsWith('dup-e2e-')).length; })()`);
      ctx.check('只落地了 2 条代理（a 与 c）', total === 2, String(total));
    } finally {
      for (const name of created) {
        await ctx.eval(`(async () => { await FRP.deleteProxy(${JSON.stringify(name)}); return 1; })()`).catch(() => {});
      }
    }
  },
};
