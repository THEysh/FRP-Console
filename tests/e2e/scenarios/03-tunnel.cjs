'use strict';
/* 端到端隧道：连 frps → 起 frpc → 代理三层全通，并且公网端口真的能访问。
 * 覆盖 config 写入、隧道启动、健康检查、reload 之后的状态收敛。 */
module.exports = {
  id: 'tunnel-e2e',
  title: '真实隧道：三层全通 + 公网可访问',
  needs: ['app', 'frps', 'local', 'frpc'],
  async run(ctx) {
    const { check, waitFor } = ctx;
    const localPort = ctx.local.port;

    const saved = await ctx.eval(`(async () => {
      const res = await FRP.saveConfig({
        serverAddr: '127.0.0.1',
        serverPort: ${ctx.frps.bindPort},
        auth: { method: 'token', token: '${ctx.frps.token}' },
        log: { to: './frpc.log', level: 'info' },
      });
      return { ok: !!(res && res.ok), err: (res && res.error) || '' };
    })()`);
    check('写入 frpc 配置', saved.ok, saved.err);

    const proxy = await ctx.eval(`(async () => {
      const res = await FRP.saveProxy('add', '', { name: 'e2e-tunnel', type: 'tcp', localIP: '127.0.0.1', localPort: ${localPort}, remotePort: 23280 });
      return { ok: !!(res && res.ok), err: (res && res.error) || '' };
    })()`);
    check('新增隧道代理', proxy.ok, proxy.err);

    const started = await ctx.eval(`(async () => { const res = await FRP.startTunnel(); return { ok: !!(res && res.ok), data: res && res.data, err: (res && res.error) || '' }; })()`);
    check('启动隧道', started.ok, JSON.stringify(started).slice(0, 240));

    const runtime = await waitFor(
      () => ctx.eval(`(async () => { const r = await FRP.refresh(); return r.data.runtime; })()`),
      (r) => r && r.connected === true,
      { timeout: 30000, label: 'frpc 连上 frps' },
    );
    check('runtime 报已连接', runtime.connected === true, JSON.stringify(runtime).slice(0, 240));
    check('runtime 是托管进程模式', runtime.mode === 'managed', runtime.mode);

    const health = await waitFor(
      () => ctx.eval(`(async () => {
        const r = await FRP.refresh();
        const p = (r.data.proxies || []).find((x) => x.name === 'e2e-tunnel');
        return p ? { health: p.health, status: p.status, publicAddress: p.publicAddress } : null;
      })()`),
      (p) => p && p.health && p.health.ok === true,
      { timeout: 40000, label: '三层健康检查全绿' },
    );
    check('本地层通', !!(health.health.layers && health.health.layers.local && health.health.layers.local.ok), JSON.stringify(health.health.layers && health.health.layers.local));
    check('隧道层通', !!(health.health.layers && health.health.layers.tunnel && health.health.layers.tunnel.ok), JSON.stringify(health.health.layers && health.health.layers.tunnel));
    check('公网层通', !!(health.health.layers && health.health.layers.public && health.health.layers.public.ok), JSON.stringify(health.health.layers && health.health.layers.public));

    /* 直接访问公网端口：健康检查是「我们自己的判定」，这里再从外部验一次。 */
    const body = await new Promise((resolve) => {
      const http = require('node:http');
      const req = http.get({ host: '127.0.0.1', port: 23280, path: '/', timeout: 8000 }, (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, text }));
      });
      req.on('error', (e) => resolve({ status: 0, text: String(e.message) }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ status: 0, text: 'timeout' });
      });
    });
    check('公网端口返回 200', body.status === 200, `status=${body.status} ${body.text.slice(0, 120)}`);
    check('返回的是本地服务的内容', /hello-e2e/.test(body.text || ''), body.text.slice(0, 120));
  },
};
