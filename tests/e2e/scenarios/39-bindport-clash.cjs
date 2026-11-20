'use strict';
/* 边界输入：把公网端口填成 frps 自己的监听端口（bindPort）。
 * frps 只会回一句 port unavailable（不带端口号），1.2.142 之前界面说「frps 拒绝启动这个代理」，
 * 用户根本看不出是哪一步错了；现在要点名「这个端口就是 frps 的监听端口」。 */
module.exports = {
  id: 'bindport-clash',
  title: '公网端口撞上 frps 自己的端口时，说清是哪个端口',
  needs: ['app', 'frps', 'local', 'frpc'],
  async run(ctx) {
    const { check, waitFor } = ctx;

    const saved = await ctx.eval(`(async () => {
      const res = await FRP.saveConfig({
        serverAddr: '127.0.0.1',
        serverPort: ${ctx.frps.bindPort},
        auth: { method: 'token', token: '${ctx.frps.token}' },
      });
      return { ok: !!(res && res.ok), err: (res && res.error) || '' };
    })()`);
    check('写入 frpc 配置', saved.ok, saved.err);

    /* 保存阶段就该给警告（不是错误）：用户可能只是想先存着。 */
    const proxy = await ctx.eval(`(async () => {
      const res = await FRP.saveProxy('add', '', { name: 'e2e-bindclash', type: 'tcp', localIP: '127.0.0.1', localPort: ${ctx.local.port}, remotePort: ${ctx.frps.bindPort} });
      return { ok: !!(res && res.ok), err: (res && res.error) || '', warnings: (res.data && res.data.warnings) || [] };
    })()`);
    check('保存时允许但给出警告', proxy.ok === true, proxy.err);
    check('警告点名「与服务器端口相同」', proxy.warnings.some((w) => /服务器端口/.test(String(w))), JSON.stringify(proxy.warnings).slice(0, 240));

    const started = await ctx.eval(`(async () => { const res = await FRP.startTunnel(); return { ok: !!(res && res.ok), err: (res && res.error) || '' }; })()`);
    check('隧道能起来（只是这条代理起不来）', started.ok === true, started.err);

    const health = await waitFor(
      () => ctx.eval(`(async () => {
        const r = await FRP.refresh();
        const p = (r.data.proxies || []).find((x) => x.name === 'e2e-bindclash');
        return p && p.health ? p.health : null;
      })()`),
      (h) => h && h.ok === false && /frps 的监听端口/.test(String(h.reason || '')),
      { timeout: 45000, label: '健康检查点名 bindPort 冲突' },
    );
    check('失败原因点名「公网端口就是 frps 的监听端口」', /frps 的监听端口/.test(String(health.reason)), health.reason);
    check('提示里有「换个公网端口」的动作建议', /换个/.test(String(health.layers && health.layers.tunnel && health.layers.tunnel.hint)), JSON.stringify(health.layers && health.layers.tunnel).slice(0, 240));

    await ctx.eval(`(async () => { await FRP.stopTunnel(); await FRP.deleteProxy('e2e-bindclash'); return 1; })()`);
  },
};
