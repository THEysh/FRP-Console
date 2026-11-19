'use strict';
/* 健康检查的「说真话」能力：本地服务挂了就必须报「本地服务不通」，
 * 而且不能再算进「在线」。这是 1.2.3 报告里最核心的一条（假绿）。 */
module.exports = {
  id: 'health-truth',
  title: '本地服务挂掉时如实报错（不假绿）',
  needs: ['app', 'frps', 'local', 'frpc'],
  async run(ctx) {
    const { check, waitFor } = ctx;

    /* 03 已经把隧道跑起来了；这里只把本地端口改成一个没人监听的口。 */
    const changed = await ctx.eval(`(async () => {
      const res = await FRP.saveProxy('edit', 'e2e-tunnel', { name: 'e2e-tunnel', type: 'tcp', localIP: '127.0.0.1', localPort: 1, remotePort: 23280 });
      return { ok: !!(res && res.ok), err: (res && res.error) || '' };
    })()`);
    check('把本地端口改成死端口', changed.ok, changed.err);

    const state = await waitFor(
      () => ctx.eval(`(async () => {
        const r = await FRP.refresh();
        const p = (r.data.proxies || []).find((x) => x.name === 'e2e-tunnel');
        return {
          ok: p && p.health ? p.health.ok : null,
          reason: p && p.health ? p.health.reason : '',
          counts: r.data.counts,
          localError: p && p.health && p.health.layers && p.health.layers.local ? p.health.layers.local.error : '',
        };
      })()`),
      (s) => s && s.ok === false,
      { timeout: 40000, label: '健康检查发现本地不可用' },
    );
    check('health.ok 变成 false', state.ok === false, JSON.stringify(state).slice(0, 240));
    check('原因是「本地服务不通」', /本地服务不通/.test(state.reason || ''), state.reason);
    check('第一层带上具体错误', /ECONNREFUSED|refused/i.test(state.localError || ''), state.localError);
    check('这条代理不再计入在线', Number(state.counts.online) === 0, `online=${state.counts.online} total=${state.counts.total}`);
    check('计入「本地服务不通」统计', Number(state.counts.unhealthyLocal) >= 1, `unhealthyLocal=${state.counts.unhealthyLocal}`);

    /* 恢复现场，后续场景还要用这条隧道。 */
    const restored = await ctx.eval(`(async () => {
      const res = await FRP.saveProxy('edit', 'e2e-tunnel', { name: 'e2e-tunnel', type: 'tcp', localIP: '127.0.0.1', localPort: ${ctx.local.port}, remotePort: 23280 });
      return { ok: !!(res && res.ok) };
    })()`);
    check('恢复本地端口', restored.ok);
  },
};
