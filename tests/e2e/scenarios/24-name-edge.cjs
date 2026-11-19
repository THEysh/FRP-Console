'use strict';
/* 边界输入：代理名的字符与长度。界面不拦（frp 本身也接受），
 * 但必须保证「能保存的就能真正跑起来」——不能出现永远 start error 的代理。 */
module.exports = {
  id: 'name-edge',
  title: '代理名用长名字/表情/斜杠时能保存也能跑起来',
  needs: ['app', 'frps', 'local'],
  async run(ctx) {
    const local = ctx.local.port;
    const names = [
      ['长名字（200 字符）', 'n'.repeat(200)],
      ['表情与中文', '代理-🚀-测试'],
      ['带斜杠', 'a/b'],
      ['带点', 'a.b'],
    ];
    const created = [];
    try {
      await ctx.eval(`(async () => {
        await FRP.saveConfig({ serverAddr: '127.0.0.1', serverPort: ${ctx.frps.bindPort}, auth: { method: 'token', token: ${JSON.stringify(ctx.frps.token)} } });
        return 1;
      })()`);

      for (let i = 0; i < names.length; i += 1) {
        const [label, name] = names[i];
        const res = await ctx.eval(`(async () => {
          const r = await FRP.saveProxy('add', '', { name: ${JSON.stringify(name)}, type: 'tcp', localIP: '127.0.0.1', localPort: ${local}, remotePort: ${46301 + i} });
          return { ok: r.ok, err: String(r.error || '').slice(0, 120) };
        })()`);
        if (res.ok) created.push(name);
        ctx.check(`${label} 可以保存`, res.ok === true, res.err);
      }

      const started = await ctx.eval(`(async () => { const r = await FRP.startTunnel(); return { ok: r.ok, err: String(r.error || '').slice(0, 140) }; })()`);
      ctx.check('隧道能起来（frpc 接受这些名字）', started.ok === true, started.err);

      const running = await ctx.waitFor(
        () => ctx.eval(`(async () => { const r = await FRP.refresh(); return (r.data.proxies || []).filter((p) => p.status === 'running').length; })()`),
        (v) => v >= names.length,
        { timeout: 25000, label: '代理全部进入 running' },
      ).catch(() => 0);
      ctx.check('四条代理都 running（没有谁永远 start error）', running >= names.length, `running=${running}`);
    } finally {
      await ctx.eval(`(async () => { await FRP.stopTunnel(); return 1; })()`).catch(() => {});
      for (const name of created) {
        await ctx.eval(`(async () => { await FRP.deleteProxy(${JSON.stringify(name)}); return 1; })()`).catch(() => {});
      }
    }
  },
};
