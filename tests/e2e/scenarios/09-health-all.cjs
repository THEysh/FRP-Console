'use strict';
/* 代理数量回归：超过 16 条时**每一条都要被检查**。
 * 1.2.3 的历史 bug 是 `slice(0, 16)`：第 17 条起永远不检查，坏掉的代理照样显示「在线」，
 * 概览还宣称「全部代理三层全通」。这里用 20 条把它们全部盯住。 */
module.exports = {
  id: 'health-all-proxies',
  title: '20 条代理时健康检查不截断',
  needs: ['app', 'frps', 'local', 'frpc'],
  async run(ctx) {
    const { check, waitFor } = ctx;
    const { ensureConfig } = require('../helpers/seed.cjs');
    const seeded = await ensureConfig(ctx);
    check('准备：隧道目标指向测试 frps', seeded.ok, seeded.err || '');

    /* 健康检查只在隧道连上时跑（frpc 没起来时一律「待检测」，这是刻意的：
     * 否则用户只是忘了点启动，界面就一片「隧道未建立」红字）。所以这里先起隧道。 */
    const started = await waitFor(
      () => ctx.eval(`(async () => {
        const r0 = await FRP.refresh();
        if (r0.data.runtime && r0.data.runtime.connected) return { ok: true, already: true };
        const res = await FRP.startTunnel();
        return { ok: !!(res && res.ok), err: (res && res.error) || '' };
      })()`),
      (s) => s && s.ok === true,
      { timeout: 30000, label: '隧道连上测试 frps' },
    );
    check('隧道已连上（健康检查的前提）', started.ok === true, JSON.stringify(started).slice(0, 160));

    const added = await ctx.eval(`(async () => {
      const names = [];
      for (let i = 0; i < 20; i += 1) {
        const res = await FRP.saveProxy('add', '', {
          name: 'bulk-' + String(i).padStart(2, '0'),
          type: 'tcp',
          localIP: '127.0.0.1',
          localPort: ${ctx.local.port},
          remotePort: 24000 + i,
        });
        if (res && res.ok) names.push('bulk-' + String(i).padStart(2, '0'));
      }
      return { ok: names.length === 20, names: names.length };
    })()`);
    check('能连续新增 20 条代理', added.ok, `added=${added.names}`);

    const checked = await waitFor(
      () => ctx.eval(`(async () => {
        const r = await FRP.refresh();
        const bulk = (r.data.proxies || []).filter((p) => /^bulk-/.test(p.name));
        return { total: bulk.length, withHealth: bulk.filter((p) => p.health).length, reasons: bulk.filter((p) => p.health && !p.health.ok).map((p) => p.name + ':' + (p.health.reason || '')) };
      })()`),
      /* 只等「都检查到」会在 reload 边界上误报：最后一两条还是上一轮的结果。
       * 等「都检查到且都正常」，真有问题也只是拖到超时，不会把正常情况报成故障。 */
      (s) => s && s.total >= 20 && s.withHealth >= 20 && s.reasons.length === 0,
      { timeout: 90000, label: '20 条代理全部检查到且都正常' },
    );
    check('20 条代理都有健康结果（没有被 slice 截断）', checked.withHealth >= 20, JSON.stringify(checked).slice(0, 240));
    check('全部判定为通', checked.reasons.length === 0, JSON.stringify(checked.reasons));

    /* 再挑最后一条弄坏，确认它**会被**发现（而不是永远绿）。 */
    const broke = await ctx.eval(`(async () => {
      const res = await FRP.saveProxy('edit', 'bulk-19', { name: 'bulk-19', type: 'tcp', localIP: '127.0.0.1', localPort: 1, remotePort: 24019 });
      return { ok: !!(res && res.ok) };
    })()`);
    check('把最后一条的本地端口改坏', broke.ok);

    const detected = await waitFor(
      () => ctx.eval(`(async () => {
        const r = await FRP.refresh();
        const p = (r.data.proxies || []).find((x) => x.name === 'bulk-19');
        return { ok: p && p.health ? p.health.ok : null, reason: p && p.health ? p.health.reason : '', counts: r.data.counts };
      })()`),
      (s) => s && s.ok === false,
      { timeout: 45000, label: '第 20 条代理的故障被发现' },
    );
    check('第 20 条的故障被发现', detected.ok === false, JSON.stringify(detected).slice(0, 200));
    /* 在线数 = 总数 - 这一条坏掉的（前面场景还留了一条 e2e-tunnel，不能假设只有 bulk-*）。 */
    check('坏掉的那条不再计入在线', Number(detected.counts.online) === Number(detected.counts.total) - 1, `online=${detected.counts.online} total=${detected.counts.total}`);
    check('计入本地不通统计', Number(detected.counts.unhealthyLocal) >= 1, `unhealthyLocal=${detected.counts.unhealthyLocal}`);

    /* 清理：批量代理不留给后面的场景（它们会拖慢每一轮健康检查）。 */
    const cleaned = await ctx.eval(`(async () => {
      for (let i = 0; i < 20; i += 1) {
        await FRP.deleteProxy('bulk-' + String(i).padStart(2, '0'));
      }
      const r = await FRP.refresh();
      return (r.data.proxies || []).filter((p) => /^bulk-/.test(p.name)).length;
    })()`);
    check('清理批量代理', cleaned === 0, `left=${cleaned}`);
  },
};
