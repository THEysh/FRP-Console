'use strict';
/* 边界输入：公网端口被服务器上的「非 frp 进程」占着。
 * frps 只会回一句 port unavailable，1.2.142 之前界面说「frps 拒绝启动这个代理」，
 * 1.2.152 起要点名是哪个端口、并给出「检查端口」的动作。 */
const net = require('node:net');

module.exports = {
  id: 'port-occupied',
  title: '公网端口被别的程序占着时，说清是哪个端口',
  needs: ['app', 'frps', 'local', 'frpc'],
  async run(ctx) {
    const { check, waitFor, sleep } = ctx;

    /* 占住一个端口，模拟「服务器上别的程序占着」——本机就是服务器。 */
    const blocker = net.createServer((s) => s.end());
    let remotePort = 0;
    for (let p = 23161; p < 23191 && !remotePort; p += 1) {
      try {
        await new Promise((res, rej) => {
          const onErr = (e) => { blocker.removeListener('error', onErr); rej(e); };
          blocker.once('error', onErr);
          blocker.listen(p, '0.0.0.0', () => { blocker.removeListener('error', onErr); res(); });
        });
        remotePort = p;
      } catch { /* 换下一个端口 */ }
    }
    if (!remotePort) { check('占住一个测试端口', false, '23161-23190 都被占用'); return; }

    try {
      const saved = await ctx.eval(`(async () => {
        const res = await FRP.saveConfig({
          serverAddr: '127.0.0.1',
          serverPort: ${ctx.frps.bindPort},
          auth: { method: 'token', token: '${ctx.frps.token}' },
        });
        return { ok: !!(res && res.ok), err: (res && res.error) || '' };
      })()`);
      check('写入 frpc 配置', saved.ok, saved.err);

      const proxy = await ctx.eval(`(async () => {
        const res = await FRP.saveProxy('add', '', { name: 'e2e-occupied', type: 'tcp', localIP: '127.0.0.1', localPort: ${ctx.local.port}, remotePort: ${remotePort} });
        return { ok: !!(res && res.ok), err: (res && res.error) || '' };
      })()`);
      check('保存时放行（用户可能只是想先存着）', proxy.ok === true, proxy.err);

      const started = await ctx.eval(`(async () => { const res = await FRP.startTunnel(); return { ok: !!(res && res.ok), err: (res && res.error) || '' }; })()`);
      check('隧道能起来（只是这条代理起不来）', started.ok === true, started.err);

      const health = await waitFor(
        () => ctx.eval(`(async () => {
          const r = await FRP.refresh();
          const p = (r.data.proxies || []).find((x) => x.name === 'e2e-occupied');
          return p ? { status: p.status, health: p.health || null } : null;
        })()`),
        (v) => v && v.health && v.health.ok === false && /在 frps 上用不了/.test(String(v.health.reason || '')),
        { timeout: 60000, label: '健康检查归因到公网端口' },
      );
      check('状态是 start error（不是「隧道未建立」）', String(health.status) === 'start error', String(health.status));
      check(`失败原因点名端口 ${remotePort}`, String(health.health.reason).includes(String(remotePort)), health.health.reason);
      const hint = String((health.health.layers && health.health.layers.tunnel && health.health.layers.tunnel.hint) || '');
      check('提示里有「检查端口」的动作建议', /检查端口/.test(hint), hint.slice(0, 160));
      check('底层错误仍是 frps 的原话', String(health.health.error || '').length > 0, String(health.health.error));

      await sleep(200);
      await ctx.eval(`(async () => { await FRP.stopTunnel(); await FRP.deleteProxy('e2e-occupied'); return 1; })()`);
    } finally {
      blocker.close();
    }
  },
};
