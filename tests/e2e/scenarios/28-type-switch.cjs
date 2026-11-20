'use strict';
/* 回归：把代理从 tcp 改成 http（再改回）时，旧类型专属字段必须被清掉。
 * 留 remotePort 会被 frpc 拒绝整份配置；留 customDomains 会让 tcp 代理凭空抢域名。 */
const fs = require('node:fs');

module.exports = {
  id: 'type-switch',
  title: '代理换类型时旧字段被清掉',
  needs: ['app', 'frps'],
  async run(ctx) {
    try {
      await ctx.eval(`(async () => {
        await FRP.saveConfig({ serverAddr: '127.0.0.1', serverPort: ${ctx.frps.bindPort}, auth: { method: 'token', token: ${JSON.stringify(ctx.frps.token)} } });
        return 1;
      })()`);
      const add = await ctx.eval(`(async () => { const r = await FRP.saveProxy('add','',{name:'switch-me',type:'tcp',localIP:'127.0.0.1',localPort:18080,remotePort:28741}); return { ok: r.ok, err: String(r.error||'').slice(0,120) }; })()`);
      ctx.check('先建一条 tcp 代理', add.ok === true, add.err);

      const confPath = await ctx.eval(`(async () => { const r = await FRP.init(); return String(r.data.state.paths.configPath || ''); })()`);
      const segment = () => {
        const text = fs.readFileSync(confPath, 'utf8');
        const idx = text.lastIndexOf('[[proxies]]');
        return idx < 0 ? '' : text.slice(idx);
      };

      const toHttp = await ctx.eval(`(async () => { const r = await FRP.saveProxy('edit','switch-me',{name:'switch-me',type:'http',localIP:'127.0.0.1',localPort:18080,customDomains:['switch.example.com']}); return { ok: r.ok, err: String(r.error||'').slice(0,140) }; })()`);
      ctx.check('改成 http 成功', toHttp.ok === true, toHttp.err);
      const s1 = segment();
      ctx.check('http 没有残留 remotePort', !/remotePort/.test(s1), s1.split('\n').filter((l) => l.includes('remotePort')).join(' | '));
      ctx.check('http 写入了 customDomains', /customDomains/.test(s1), s1.split('\n').filter((l) => l.includes('customDomains')).join(' | '));

      const backToTcp = await ctx.eval(`(async () => { const r = await FRP.saveProxy('edit','switch-me',{name:'switch-me',type:'tcp',localIP:'127.0.0.1',localPort:18080,remotePort:28742}); return { ok: r.ok, err: String(r.error||'').slice(0,140) }; })()`);
      ctx.check('改回 tcp 成功', backToTcp.ok === true, backToTcp.err);
      const s2 = segment();
      ctx.check('tcp 没有残留 customDomains', !/customDomains/.test(s2), s2.split('\n').filter((l) => l.includes('customDomains')).join(' | '));
      ctx.check('tcp 用了新的 remotePort', /remotePort = 28742/.test(s2), s2.split('\n').filter((l) => l.includes('remotePort')).join(' | '));

      const started = await ctx.eval(`(async () => { const r = await FRP.startTunnel(); return { ok: r.ok, err: String(r.error||'').slice(0,140) }; })()`);
      ctx.check('改完类型后隧道能正常启动', started.ok === true, started.err);
      const running = await ctx.waitFor(
        async () => ctx.eval(`(async () => { const r = await FRP.refresh(); const p = (r.data.proxies||[]).find((x) => x.name === 'switch-me'); return { mode: r.data.runtime.mode, status: p && p.status }; })()`),
        (v) => v && v.mode === 'managed' && v.status === 'running',
        { timeout: 20000, label: '代理 running' },
      ).catch(() => null);
      ctx.check('代理在 frpc 里是 running', !!running, running ? '' : '超时');
    } finally {
      await ctx.eval(`(async () => { await FRP.stopTunnel(); return 1; })()`).catch(() => {});
      await ctx.eval(`(async () => { await FRP.deleteProxy('switch-me'); return 1; })()`).catch(() => {});
    }
  },
};
