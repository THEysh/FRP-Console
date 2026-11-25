'use strict';
/* 回归：本地服务只监听 IPv6（::1）时，代理能保存、能探活、能起来。
 * 1.2.115 之前 localIP='::1' 会被自己的校验拒掉（"不是合法的主机名或 IP"）。 */
const net = require('node:net');

module.exports = {
  id: 'ipv6-local',
  title: 'IPv6 本地服务能建代理并通过健康检查',
  needs: ['app', 'frps'],
  async run(ctx) {
    const server = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok');
    });
    const port = 18097;
    await new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(port, '::1', resolve);
    });

    try {
      const probe = await ctx.eval(`(async () => { const r = await FRP.probeTcp('::1', ${port}); return r.data; })()`);
      ctx.check('本机 ::1 端口可达', probe && probe.ok === true, JSON.stringify(probe));
      /* 有些环境（含部分沙箱/安全软件）直接禁止连 IPv6 回环，connect 会立刻 EACCES：
       * 那是环境能力问题，不是产品缺陷，跳过并写明原因。 */
      if (probe && probe.ok === false && /EACCES|EPERM|EAFNOSUPPORT|ENETUNREACH/i.test(String(probe.error || ''))) {
        ctx.skip('这个环境不允许连 IPv6 回环（' + String(probe.error || '').slice(0, 40) + '），跳过');
        return;
      }

      await ctx.eval(`(async () => {
        await FRP.saveConfig({ serverAddr: '127.0.0.1', serverPort: ${ctx.frps.bindPort}, auth: { method: 'token', token: ${JSON.stringify(ctx.frps.token)} } });
        return 1;
      })()`);
      const add = await ctx.eval(`(async () => { const r = await FRP.saveProxy('add','',{name:'v6-local',type:'tcp',localIP:'::1',localPort:${port},remotePort:28751}); return { ok: r.ok, err: String(r.error||'').slice(0,160) }; })()`);
      ctx.check('localIP 填 ::1 能保存', add.ok === true, add.err);

      const started = await ctx.eval(`(async () => { const r = await FRP.startTunnel(); return { ok: r.ok, err: String(r.error||'').slice(0,160) }; })()`);
      ctx.check('隧道能启动', started.ok === true, started.err);

      const health = await ctx.waitFor(
        async () => ctx.eval(`(async () => { const r = await FRP.refresh(); const p = (r.data.proxies||[]).find((x) => x.name === 'v6-local'); return p ? { status: p.status, ok: !!(p.health && p.health.ok), reason: p.health && p.health.reason } : null; })()`),
        (v) => v && v.status === 'running' && v.ok === true,
        { timeout: 20000, label: 'IPv6 代理三层全通' },
      );
      ctx.check('IPv6 代理三层全通', health.ok === true, JSON.stringify(health));
    } finally {
      server.close();
      await ctx.eval(`(async () => { await FRP.stopTunnel(); return 1; })()`).catch(() => {});
      await ctx.eval(`(async () => { await FRP.deleteProxy('v6-local'); return 1; })()`).catch(() => {});
    }
  },
};
