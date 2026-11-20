'use strict';
/* 服务端场景：隧道正在跑的时候把「服务器地址/端口/token」改掉。
 *
 * frpc 不会自己换服务器——它只在启动时读一次配置。所以主进程必须在
 * 连接参数变化后把隧道重启一次，否则界面显示「已连接」，实际连的还是旧的那台，
 * 新服务器上一条代理都不会注册。
 *
 * 这条场景就是那个假绿的回归：起两台 frps，隧道跑在 A 上，把配置改成 B，
 * 要求 IPC 明确返回 restarted:true，且 frpc 的 pid 变了、隧道仍是 managed。
 */
const path = require('node:path');
const frps = require('../helpers/frps.cjs');

const A = { port: 17100, dash: 17600, token: 'switch-a-token-0001' };
const B = { port: 17101, dash: 17601, token: 'switch-b-token-0002' };

module.exports = {
  id: 'config-switch',
  title: '改服务器地址/端口/token 时，隧道必须真的换过去（不能显示已连接却还连旧的）',
  needs: ['app', 'frps'],
  async run(ctx) {
    const { check } = ctx;
    const a = await frps.startFrps({ dir: path.join(ctx.dataDir, 'frps-a'), bindPort: A.port, dashPort: A.dash, token: A.token });
    const b = await frps.startFrps({ dir: path.join(ctx.dataDir, 'frps-b'), bindPort: B.port, dashPort: B.dash, token: B.token });
    if (!a || !b) {
      check('准备两台测试 frps', false, '缺少 frps 二进制');
      return;
    }
    try {
      await frps.waitPort(A.port);
      await frps.waitPort(B.port);

      const save = (p, token) => ctx.eval(`(async () => {
        const r = await FRP.saveConfig({ serverAddr: '127.0.0.1', serverPort: ${p}, auth: { method: 'token', token: '${token}' }, log: { to: './frpc.log', level: 'info' } });
        return { ok: r.ok, restarted: !!(r.data && r.data.restarted), err: String((r.data && r.data.restartError) || '').slice(0, 120) };
      })()`);
      const snap = () => ctx.eval(`(async () => {
        const r = await FRP.refresh(); const d = r.data;
        return { mode: d.runtime && d.runtime.mode, pid: d.runtime && d.runtime.pid, stale: !!(d.runtime && d.runtime.staleConfig) };
      })()`);

      await save(A.port, A.token);
      await ctx.eval(`(async () => { await FRP.startTunnel(); return 1; })()`);
      const s1 = await ctx.waitFor(
        () => snap(),
        (v) => v && v.mode === 'managed',
        { timeout: 30000, label: 'A 上跑通' },
      );
      check('隧道先在 A 上跑起来', !!(s1 && s1.mode === 'managed' && s1.pid), JSON.stringify(s1));

      const r1 = await save(B.port, B.token);
      check('改到 B 时 IPC 报告已自动重启', r1.ok === true && r1.restarted === true, JSON.stringify(r1));
      const s2 = await ctx.waitFor(
        () => snap(),
        (v) => v && v.mode === 'managed' && v.pid && v.pid !== s1.pid,
        { timeout: 30000, label: 'B 上跑通' },
      );
      check('frpc 真的换了进程（pid 变了）', !!(s2 && s2.pid && s2.pid !== s1.pid), `${s1.pid} → ${s2 && s2.pid}`);
      check('没有残留「用旧配置在跑」的标记', !!(s2 && s2.stale === false), JSON.stringify(s2 && { stale: s2.stale }));

      const r2 = await save(A.port, A.token);
      const s3 = await ctx.waitFor(
        () => snap(),
        (v) => v && v.mode === 'managed' && v.pid && v.pid !== s2.pid,
        { timeout: 30000, label: '切回 A' },
      );
      check('切回 A 同样会自动重启', r2.restarted === true && !!(s3 && s3.pid !== s2.pid), JSON.stringify(r2));
    } finally {
      await ctx.eval(`(async () => { await FRP.stopTunnel(); return 1; })()`).catch(() => {});
      a.stop();
      b.stop();
    }
  },
};
