'use strict';
/* frpc 进程被杀（崩溃 / 任务管理器结束 / 杀软拦截）之后，界面能不能自己收敛。
 *
 * 这是「隧道突然不通」最常见的现场。要求：
 *   ① 状态如实变成已停止（不能还显示「已连接」）；
 *   ② 在线数归零（三层检查的第二层已经没了，不能继续把代理算作在线）；
 *   ③ 给出可读的失败原因（而不是空白或英文堆栈）；
 *   ④ 再点一次「启动隧道」能恢复，且代理三层重新变绿。
 */
const { execFileSync } = require('node:child_process');

module.exports = {
  id: '20-crash',
  title: 'frpc 被杀：状态收敛、在线归零、能重新拉起',
  needs: ['frps', 'frpc', 'local'],
  async run(ctx) {
    const { ensureConfig } = require('../helpers/seed.cjs');
    const seeded = await ensureConfig(ctx);
    ctx.check('隧道目标指向测试 frps', seeded && seeded.ok, JSON.stringify(seeded));

    const prepared = await ctx.eval(`(async () => {
      await FRP.stopTunnel();
      const r = await FRP.refresh();
      if (!(r.data.proxies || []).some((p) => p.name === 'crash-probe')) {
        await FRP.saveProxy('add', '', { name: 'crash-probe', type: 'tcp', localIP: '127.0.0.1', localPort: ${ctx.local.port}, remotePort: 24401 });
      }
      const st = await FRP.startTunnel();
      return { ok: !!(st && st.ok), mode: st && st.data && st.data.mode };
    })()`);
    ctx.check('隧道先正常起来', prepared.ok === true, JSON.stringify(prepared));

    const up = await ctx.waitFor(
      () => ctx.eval(`(async () => { const r = await FRP.refresh(); return r.data.runtime; })()`),
      (rt) => rt && rt.connected === true && rt.pid,
      { timeout: 25000, label: '隧道连上' },
    );
    ctx.check('拿到了 frpc 的 pid', !!up.pid, JSON.stringify({ pid: up.pid }));

    /* 从宿主机直接杀进程：模拟任务管理器结束任务 / 进程自己崩掉。 */
    let killed = true;
    try {
      execFileSync('taskkill', ['/F', '/PID', String(up.pid)], { stdio: 'ignore' });
    } catch (error) {
      killed = false;
      ctx.check('能杀掉 frpc 进程（taskkill 成功）', false, String(error && error.message));
    }
    if (!killed) return;

    const after = await ctx.waitFor(
      () =>
        ctx.eval(`(async () => {
          const r = await FRP.refresh();
          const rt = r.data.runtime || {};
          const raw = r.data.logs;
          const arr = Array.isArray(raw) ? raw : (raw && raw.lines) || [];
          /* 原因字段与状态在同一次采样里取：中间若发生自动重连，lastExit 会被清掉，
           * 分两次读就会出现「状态收敛了、原因却是空」的假失败。 */
          return {
            runtime: rt,
            counts: r.data.counts,
            connectFailed: !!rt.connectFailed,
            connectError: rt.connectError || '',
            lastExit: (rt.lastExit && String(rt.lastExit.error || rt.lastExit.code || '')) || '',
            logHasExit: arr.some((l) => /exit|退出|stopped|重连|reconnect/i.test(String(l.line || l.text || l))),
          };
        })()`),
      (v) => v && v.runtime && v.runtime.connected === false && !v.runtime.pid,
      { timeout: 20000, interval: 700, label: '状态收敛为未连接' },
    );
    ctx.check('状态如实变成未连接（不再显示已连接）', after.runtime.connected === false && !after.runtime.pid, JSON.stringify(after.runtime).slice(0, 200));
    ctx.check('在线数归零（没有把死掉的隧道算在线）', Number(after.counts.online) === 0, `online=${after.counts.online}`);

    /* 失败原因要能读到人话：frpc 退出码 / 连接失败文案 / 日志里出现退出或重连（用同一次采样，避免被自动重连清空）。 */
    ctx.check(
      '给出了失败原因（进程退出 / 连接失败文案）',
      !!(after.connectError || after.lastExit || after.logHasExit),
      JSON.stringify({ connectError: after.connectError, lastExit: after.lastExit, logHasExit: after.logHasExit }).slice(0, 240),
    );

    /* 重启能恢复 */
    const restarted = await ctx.eval(`(async () => {
      const st = await FRP.startTunnel();
      return { ok: !!(st && st.ok), err: (st && st.error) || '' };
    })()`);
    ctx.check('重新启动成功', restarted.ok === true, restarted.err);
    const back = await ctx.waitFor(
      () => ctx.eval(`(async () => { const r = await FRP.refresh(); return r.data.runtime; })()`),
      (rt) => rt && rt.connected === true,
      { timeout: 25000, label: '重新连上' },
    );
    ctx.check('重新连上且换了新 pid', !!back.pid && String(back.pid) !== String(up.pid), `old=${up.pid} new=${back.pid}`);

    const healthy = await ctx.waitFor(
      () => ctx.eval(`(async () => {
        const r = await FRP.refresh();
        const p = (r.data.proxies || []).find((x) => x.name === 'crash-probe');
        return p && p.health ? { ok: !!p.health.ok, reason: p.health.reason || '' } : null;
      })()`),
      (v) => v && v.ok === true,
      { timeout: 40000, interval: 2000, label: '代理三层恢复' },
    ).catch(() => null);
    ctx.check('恢复后代理三层重新全通', !!healthy && healthy.ok === true, JSON.stringify(healthy));

    await ctx.eval(`(async () => { await FRP.deleteProxy('crash-probe'); await FRP.stopTunnel(); return 1; })()`);
  },
};
