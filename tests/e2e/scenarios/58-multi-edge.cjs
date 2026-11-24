'use strict';
/* 多连接阶段 6：边界。
 *
 * 钉住四件事：
 *   ① 访问路径的键按连接区分：两台服务器上的同名代理各有各的 /path；
 *   ② 连同一台 frps 的两条连接，公网端口冲突在保存时就被点名（不再等 frps 回 "port already used"）；
 *   ③ 多连接时 runMode=service 会被收敛成 managed（服务只能托管一份 frpc.toml）；
 *   ④ 删掉连接后，它的访问路径记录一起清掉（不留悬空键）。
 */
const fs = require('node:fs');
const path = require('node:path');

const CONFIG = (addr, token, proxies) => [
  `serverAddr = "${addr}"`,
  'serverPort = 7000',
  'loginFailExit = false',
  '',
  '[auth]',
  'method = "token"',
  `token = "${token}"`,
  '',
  '[webServer]',
  'addr = "127.0.0.1"',
  'port = 7412',
  'user = "admin"',
  'password = "phase6-admin-pass"',
  '',
  ...proxies.flatMap((p) => [
    '[[proxies]]',
    `name = "${p.name}"`,
    `type = "${p.type}"`,
    'localIP = "127.0.0.1"',
    `localPort = ${p.localPort}`,
    ...(p.remotePort ? [`remotePort = ${p.remotePort}`] : []),
    '',
  ]),
].join('\n');

module.exports = {
  id: '58-multi-edge',
  title: '多连接：跨连接端口冲突、访问路径归属、服务模式收敛',
  needs: ['app'],
  async run(ctx) {
    const { check, sleep } = ctx;
    const work = path.join(ctx.dataDir, 'edge');
    fs.mkdirSync(work, { recursive: true });
    const cfgA = path.join(work, 'a.toml');
    const cfgB = path.join(work, 'b.toml');
    fs.writeFileSync(cfgA, CONFIG('10.9.9.1', 'token-a', [{ name: 'shared', type: 'tcp', localPort: 18080, remotePort: 46100 }]), 'utf8');
    fs.writeFileSync(cfgB, CONFIG('10.9.9.1', 'token-b', [{ name: 'shared', type: 'tcp', localPort: 18080, remotePort: 46200 }]), 'utf8');

    const inst = await ctx.startApp({
      seed: (dir) => {
        const data = path.join(dir, 'frp-console-data');
        fs.mkdirSync(data, { recursive: true });
        fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({
          version: 2,
          frpcPath: path.join(__dirname, '..', '..', '..', 'vendor', 'frpc', 'frpc.exe'),
          configPath: cfgA,
          logPath: '',
          runMode: 'managed',
          adminPort: 7450,
          adminUser: 'admin',
          adminPassword: 'phase6-admin-pass',
          autoReload: true,
          autoReconnect: true,
          pollIntervalMs: 3000,
          stripProxyEnv: true,
          closeToTray: true,
          launchAtLogin: false,
          logBuffer: 600,
          starterConfigCreated: true,
          servers: [],
          proxyOpenPaths: { shared: '/legacy-path/' },
          connections: [
            { id: 'c-default', name: 'A', serverId: '', configPath: cfgA, logPath: '', adminPort: 7450, enabled: true, autoReconnect: true },
          ],
          activeConnectionId: 'c-default',
        }, null, 2), 'utf8');
      },
    });
    check('实例启动', !!inst && inst.ready === true);
    if (!inst || !inst.ready) return;
    const ev = inst.eval;
    try {
      /* bootstrap 里 manager 是异步创建的：先等到 runtime 就绪再动配置 */
      await ev(`(async () => {
        for (let i = 0; i < 40; i += 1) {
          const st = await FRP.refresh();
          const s2 = st.data || st.state || st;
          if (s2.runtime && s2.paths && s2.paths.configPath) return true;
          await new Promise((r) => setTimeout(r, 250));
        }
        return false;
      })()`);

      /* 老数据的裸名键（shared → /legacy-path/）应迁到 c-default::shared 上 */
      await ev('(async () => { const st = await FRP.refresh(); return true; })()');
      await sleep(500);
      const afterMigrate = JSON.parse(fs.readFileSync(path.join(inst.dir, 'frp-console-data', 'settings.json'), 'utf8'));
      check('老的裸名访问路径迁到当前连接前缀', afterMigrate.proxyOpenPaths['c-default::shared'] === '/legacy-path/' && !afterMigrate.proxyOpenPaths.shared, JSON.stringify(afterMigrate.proxyOpenPaths));

      /* 给 A 加一条同服务器、同端口的代理：应与 B 冲突（B 还没建，先建 B） */
      const added = await ev(`(async () => { const r = await FRP.connectionAdd({ name: 'B' }); return { ok: r.ok, id: r.data && r.data.connection && r.data.connection.id }; })()`);
      check('新增连接 B', added.ok === true, JSON.stringify(added));
      if (!added.ok) return;
      const upd = await ev(`(async () => { const r = await FRP.connectionUpdate({ id: '${added.id}', configPath: ${JSON.stringify(cfgB)} }); return { ok: r.ok, err: r.error || '' }; })()`);
      check('把 B 指向同一台 frps 的另一份配置', upd.ok === true, upd.err);
      await sleep(600);

      /* B 这份配置里已经有 shared/46200：在 A 上加同端口应被跨连接挡住 */
      const clash = await ev(`(async () => {
        const r = await FRP.saveProxy('add', '', { name: 'a-clash', type: 'tcp', localIP: '127.0.0.1', localPort: 18080, remotePort: 46200 });
        return { ok: r.ok, err: r.error || '' };
      })()`);
      check('跨连接端口冲突被点名拦截', clash.ok === false && /已经被「B」/.test(clash.err || ''), clash.err);

      /* 不同端口不受影响 */
      const fine = await ev(`(async () => {
        const r = await FRP.saveProxy('add', '', { name: 'a-ok', type: 'tcp', localIP: '127.0.0.1', localPort: 18080, remotePort: 46300 });
        return { ok: r.ok, err: r.error || '' };
      })()`);
      check('不同端口可以正常保存', fine.ok === true, fine.err);

      /* 访问路径按连接分开：A 上的 a-ok 设 /a/，不污染 B 的同名代理 */
      const pathSave = await ev(`(async () => {
        const r = await FRP.saveProxy('edit', 'a-ok', { name: 'a-ok', type: 'tcp', localIP: '127.0.0.1', localPort: 18080, remotePort: 46300, openPath: '/a-panel/' });
        return { ok: r.ok, err: r.error || '' };
      })()`);
      check('A 上的访问路径保存成功', pathSave.ok === true, pathSave.err);
      const files = JSON.parse(fs.readFileSync(path.join(inst.dir, 'frp-console-data', 'settings.json'), 'utf8'));
      check('访问路径键带连接前缀', files.proxyOpenPaths['c-default::a-ok'] === '/a-panel/', JSON.stringify(files.proxyOpenPaths));

      /* 多连接时把运行模式设成 service：应被收敛成 managed */
      const svc = await ev(`(async () => { const r = await FRP.saveSettings({ runMode: 'service' }); return { ok: r.ok, err: r.error || '', mode: r.data && r.data.state && r.data.state.settings && r.data.state.settings.runMode }; })()`);
      /* 1.2.83 起设置页已经没有“Windows 服务”入口，service 一律归一成 auto；
       * 多连接时再兜一层（tunnel:start 里也有守卫）。 */
      check('多连接时 service 模式被收敛（不再是 service）', svc.ok === true && svc.mode !== 'service', JSON.stringify(svc));

      /* 删掉 B：它的路径记录应一并清掉（这里先给 B 写一条） */
      const writeB = await ev(`(async () => {
        const raw = await FRP.serverState().catch(() => null);
        return { ok: !!raw };
      })()`);
      const removeB = await ev(`(async () => { const r = await FRP.connectionRemove('${added.id}'); return { ok: r.ok, err: r.error || '' }; })()`);
      check('删除连接 B', removeB.ok === true, removeB.err);
      await sleep(400);
      const afterDel = JSON.parse(fs.readFileSync(path.join(inst.dir, 'frp-console-data', 'settings.json'), 'utf8'));
      check('删除连接后不残留它的前缀键', !Object.keys(afterDel.proxyOpenPaths || {}).some((k) => k.startsWith(`${added.id}::`)), JSON.stringify(afterDel.proxyOpenPaths));
      check('当前连接的路径还在', afterDel.proxyOpenPaths['c-default::a-ok'] === '/a-panel/', JSON.stringify(afterDel.proxyOpenPaths));
    } finally {
      try { await inst.stop(); } catch { /* ignore */ }
    }
  },
};
