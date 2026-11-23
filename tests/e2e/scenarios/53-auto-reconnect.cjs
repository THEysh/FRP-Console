'use strict';
/* 断线自动重连（1.2.164）：frpc 进程被杀之后，不用手动点也应该自己回来。
 *
 * 用户现场：玩游戏时反作弊/安全软件会把 frpc 结束掉，程序只弹一条通知，
 * 得手动点「启动隧道」才恢复。这里钉住三条行为：
 *   ① 意外退出后排上重连，界面能看到「第 N 次 · X 秒后」；
 *   ② 自己重连成功，并且换成新的 pid；
 *   ③ 用户主动停止 / 关掉开关时，绝对不许自己复活。
 */
const { execFileSync } = require('node:child_process');

module.exports = {
  id: '53-auto-reconnect',
  title: 'frpc 被杀后自动重连；用户停止或关开关后不再自动拉起',
  needs: ['frps', 'frpc', 'local'],
  async run(ctx) {
    const { ensureConfig } = require('../helpers/seed.cjs');
    const seeded = await ensureConfig(ctx);
    ctx.check('隧道目标指向测试 frps', seeded && seeded.ok, JSON.stringify(seeded));

    const kill = (pid) => {
      try {
        execFileSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    };
    const runtimeOf = () => ctx.eval(`(async () => { const r = await FRP.refresh(); return r.data.runtime; })()`);

    /* 先确保开关是开的（前面的场景可能改过），并清场 */
    await ctx.eval(`(async () => {
      await FRP.saveSettings({ autoReconnect: true });
      await FRP.stopTunnel();
      const r = await FRP.refresh();
      if (!(r.data.proxies || []).some((p) => p.name === 'rc-probe')) {
        await FRP.saveProxy('add', '', { name: 'rc-probe', type: 'tcp', localIP: '127.0.0.1', localPort: ${ctx.local.port}, remotePort: 24611 });
      }
      return 1;
    })()`);

    const started = await ctx.eval(`(async () => { const st = await FRP.startTunnel(); return { ok: !!(st && st.ok), err: (st && st.error) || '' }; })()`);
    ctx.check('隧道先正常起来', started.ok === true, started.err);

    const up = await ctx.waitFor(
      runtimeOf,
      (rt) => rt && rt.connected === true && !!rt.pid,
      { timeout: 25000, label: '隧道连上' },
    );
    const firstPid = up.pid;
    ctx.check('拿到 frpc 的 pid', !!firstPid, `pid=${firstPid}`);

    /* ---- 场景 A：意外被杀 → 自动重连 ---- */
    ctx.check('能杀掉 frpc 进程（模拟被安全软件结束）', kill(firstPid), `pid=${firstPid}`);

    /* 重连排队是在 exit 事件里同步发生的，正常 1~2 秒内就能看到。
     * 超时时把最后三次采样打出来（含 lastExit），比只说“超时”好查。 */
    const samples = [];
    let waiting = null;
    for (let i = 0; i < 20 && !waiting; i += 1) {
      const rt = await runtimeOf();
      samples.push({ mode: rt.mode, connected: rt.connected, pid: rt.pid, rc: rt.reconnect, exit: rt.lastExit });
      if (rt.reconnect && (rt.reconnect.state === 'waiting' || rt.reconnect.state === 'running')) waiting = rt;
      else await ctx.sleep(500);
    }
    ctx.check('意外退出后排上了重连（界面能显示第几次）', !!waiting && waiting.reconnect.attempts >= 1, waiting ? JSON.stringify(waiting.reconnect) : JSON.stringify(samples.slice(-3)));
    if (!waiting) return;

    const back = await ctx.waitFor(
      runtimeOf,
      (rt) => rt && rt.connected === true && rt.pid && String(rt.pid) !== String(firstPid),
      { timeout: 30000, interval: 700, label: '自动重连成功' },
    );
    ctx.check('自动重连成功，并换成新的 frpc 进程', String(back.pid) !== String(firstPid), `old=${firstPid} new=${back.pid}`);

    const logLine = await ctx.eval(`(async () => {
      const r = await FRP.getLogs(200);
      const arr = Array.isArray(r.data) ? r.data : (r.data && r.data.lines) || [];
      const hit = arr.map((l) => String(l.line || l.text || l)).filter((t) => t.includes('[reconnect]'));
      return { count: hit.length, sample: hit.slice(-3) };
    })()`);
    ctx.check('日志里留下了重连记录', logLine.count > 0, JSON.stringify(logLine.sample));

    /* ---- 场景 B：用户主动停止 → 不许自己复活 ---- */
    await ctx.eval(`(async () => { await FRP.stopTunnel(); return 1; })()`);
    await ctx.sleep(6000);
    const afterStop = await runtimeOf();
    ctx.check('用户停止后保持停止', afterStop.connected === false, JSON.stringify({ connected: afterStop.connected, mode: afterStop.mode }));
    ctx.check('用户停止后没有排队重连', !afterStop.reconnect || afterStop.reconnect.state === 'idle', JSON.stringify(afterStop.reconnect));

    /* ---- 场景 C：关掉开关 → 意外退出也不重连 ---- */
    await ctx.eval(`(async () => { await FRP.saveSettings({ autoReconnect: false }); return 1; })()`);
    const started2 = await ctx.eval(`(async () => { const st = await FRP.startTunnel(); return { ok: !!(st && st.ok) }; })()`);
    ctx.check('关掉开关后仍能手动启动', started2.ok === true);
    const up2 = await ctx.waitFor(
      runtimeOf,
      (rt) => rt && rt.connected === true && !!rt.pid,
      { timeout: 25000, label: '第二次连上' },
    );
    kill(up2.pid);
    await ctx.sleep(7000);
    const afterOff = await runtimeOf();
    ctx.check('开关关掉时不会自动重连', afterOff.connected === false && (!afterOff.reconnect || afterOff.reconnect.state === 'idle'), JSON.stringify({ connected: afterOff.connected, reconnect: afterOff.reconnect }));

    /* 收尾：恢复开关与现场 */
    await ctx.eval(`(async () => {
      await FRP.saveSettings({ autoReconnect: true });
      await FRP.deleteProxy('rc-probe');
      await FRP.stopTunnel();
      return 1;
    })()`);
  },
};
