'use strict';
/* 外部改配置自动热重载（设置里的「自动热重载」默认开）：
 * 用户用别的编辑器改了 frpc.toml，界面应该在几秒内跟上，而不是等重启。 */
module.exports = {
  id: 'external-reload',
  title: '外部改 frpc.toml 会自动重载',
  needs: ['app', 'frps', 'local', 'frpc'],
  async run(ctx) {
    const { check, waitFor } = ctx;
    const fs = require('node:fs');
    const path = require('node:path');

    const paths = await ctx.eval(`(async () => { const r = await FRP.refresh(); return r.data.paths; })()`);
    check('拿到 configPath', !!paths.configPath, JSON.stringify(paths).slice(0, 160));

    const original = fs.readFileSync(paths.configPath, 'utf8');
    try {
      const addition = [
        '',
        '[[proxies]]',
        'name = "external-added"',
        'type = "tcp"',
        'localIP = "127.0.0.1"',
        `localPort = ${ctx.local.port}`,
        'remotePort = 24380',
        '',
      ].join('\n');
      fs.writeFileSync(paths.configPath, `${original}${addition}`, 'utf8');

      const seen = await waitFor(
        () => ctx.eval(`(async () => { const r = await FRP.refresh(); return (r.data.proxies || []).map((p) => p.name); })()`),
        (names) => Array.isArray(names) && names.includes('external-added'),
        { timeout: 25000, label: '界面跟上了外部修改' },
      );
      check('外部新增的代理出现在界面', seen.includes('external-added'), seen.join(','));
    } finally {
      fs.writeFileSync(paths.configPath, original, 'utf8');
    }

    const gone = await waitFor(
      () => ctx.eval(`(async () => { const r = await FRP.refresh(); return (r.data.proxies || []).map((p) => p.name); })()`),
      (names) => Array.isArray(names) && !names.includes('external-added'),
      { timeout: 25000, label: '界面跟上了外部还原' },
    );
    check('还原后代理消失', !gone.includes('external-added'), gone.join(','));

    /* 外部改的是「连哪台 frps」时，frpc 不会自己换服务器：
     * 界面必须显示「隧道还在用旧配置运行」+ 重启按钮，不能假装没事。 */
    /* 单独跑这个场景时配置里可能还是空的：先指向 runner 起的 frps。 */
    await ctx.eval(`(async () => { await FRP.saveConfig({ serverAddr: '127.0.0.1', serverPort: ${ctx.frps.bindPort}, auth: { method: 'token', token: '${ctx.frps.token}' } }); return 1; })()`);
    const cur = await ctx.eval('(async () => { const r = await FRP.refresh(); return { port: r.data.config.serverPort, addr: r.data.config.serverAddr }; })()');
    check('隧道目标已指向测试 frps', !!cur.addr && !!cur.port, JSON.stringify(cur));
    const started = await ctx.eval('(async () => { const r = await FRP.startTunnel(); return { ok: r.ok, err: String(r.error || "").slice(0, 160) }; })()');
    check('启动隧道返回成功', started.ok === true, JSON.stringify(started));
    const ran = await waitFor(
      () => ctx.eval('(async () => { const d = (await FRP.refresh()).data; return { mode: d.runtime.mode, stale: !!d.runtime.staleConfig }; })()'),
      (v) => v && v.mode === 'managed',
      { timeout: 15000, label: '隧道起来' },
    ).catch(async () => {
      const why = await ctx.eval('(async () => { const d = (await FRP.refresh()).data; const a = await (window.FRP && FRP.getLogs ? FRP.getLogs(20) : Promise.resolve(null)); return { mode: d.runtime.mode, apiError: d.runtime.apiError, lastExit: d.runtime.lastExit, path: d.paths, logs: (a && a.data && a.data.logs || []).slice(-6) }; })()').catch((e) => String(e.message).slice(0, 200));
      console.log('    [调试] 隧道没起来：', JSON.stringify(why).slice(0, 700));
      return { mode: 'stopped', stale: false };
    });
    check('隧道先跑起来', !!(ran && ran.mode === 'managed'), JSON.stringify(ran));
    check('正常跑着时不应该有「旧配置」提示', ran && ran.stale === false, JSON.stringify(ran));

    try {
      const raw2 = fs.readFileSync(paths.configPath, 'utf8');
      const swapped = raw2.replace(new RegExp(`serverPort = ${cur.port}`), `serverPort = ${Number(cur.port) + 1}`);
      check('能改到服务器端口那一行', swapped !== raw2, `serverPort = ${cur.port}`);
      if (swapped !== raw2) fs.writeFileSync(paths.configPath, swapped, 'utf8');
      /* 提示条只画在概览页：前面的场景可能把界面留在别的视图上。 */
      await ctx.eval('(async () => { const n = document.querySelector(\'.nav-item[data-view="overview"]\'); if (n) n.click(); return 1; })()');
      await ctx.waitUi('.view', '概览页');
      const stale = await waitFor(
        () => ctx.eval('(async () => { const d = (await FRP.refresh()).data; return { port: d.config.serverPort, stale: !!d.runtime.staleConfig, btn: !!document.querySelector(\'[data-act="tunnel.restart"]\') }; })()'),
        (v) => v && Number(v.port) === Number(cur.port) + 1,
        { timeout: 25000, label: '界面跟上了外部改的连接参数' },
      );
      check('外部改了服务器端口后，界面标出「隧道还在用旧配置运行」', stale.stale === true, JSON.stringify(stale));
      check('提示条上给了「重启隧道」按钮', stale.btn === true, JSON.stringify(stale));
    } finally {
      fs.writeFileSync(paths.configPath, original.replace(/serverAddr = .*/, `serverAddr = "${cur.addr}"`), 'utf8');
      await ctx.eval('(async () => { await FRP.stopTunnel(); return 1; })()').catch(() => {});
    }
  },
};
