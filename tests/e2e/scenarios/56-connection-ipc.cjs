'use strict';
/* 多连接阶段 4：状态聚合 + 连接管理 IPC。
 *
 * 钉住这几件事（都是界面上「连接切换器」会直接用到、且很容易做歪的语义）：
 *   ① connections:add 建的是**空的**起步配置，不会把当前连接的 serverAddr/token 复制过去；
 *   ② 重名、管理端口撞车、把文件夹当配置文件、删当前连接 —— 都要被明确拦下；
 *   ③ connectionsAgg 是各连接 counts 的和（hero 汇总用）；
 *   ④ 切「当前连接」会先停掉正在跑的隧道，并把全局投影换成新连接的配置。
 */
const fs = require('node:fs');
const path = require('node:path');

const STARTER = [
  'serverAddr = ""',
  'serverPort = 7000',
  'loginFailExit = false',
  '',
  '[auth]',
  'method = "token"',
  'auth.token = ""',
  '',
].join('\n');

module.exports = {
  id: '56-connection-ipc',
  title: '多连接：连接的增改删与切换（IPC 层）',
  needs: ['app'],
  async run(ctx) {
    const { check } = ctx;
    const work = path.join(ctx.dataDir, 'ci');
    fs.mkdirSync(work, { recursive: true });
    const cfgA = path.join(work, 'a.toml');
    fs.writeFileSync(cfgA, STARTER, 'utf8');
    const dirAsConfig = path.join(work, 'not-a-file');
    fs.mkdirSync(dirAsConfig, { recursive: true });

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
          adminPort: 7452,
          adminUser: 'admin',
          adminPassword: 'ci-admin-pass-123456',
          autoReload: true,
          autoReconnect: true,
          pollIntervalMs: 3000,
          stripProxyEnv: true,
          closeToTray: true,
          launchAtLogin: false,
          logBuffer: 600,
          starterConfigCreated: true,
          servers: [],
          proxyOpenPaths: {},
          connections: [
            { id: 'c-default', name: 'A', serverId: '', configPath: cfgA, logPath: '', adminPort: 7452, enabled: true, autoReconnect: true },
          ],
          activeConnectionId: 'c-default',
        }, null, 2), 'utf8');
      },
    });
    check('实例启动', !!inst && inst.ready === true);
    if (!inst || !inst.ready) return;
    const ev = inst.eval;
    try {
      const initial = await ev(`(async () => {
        const r = await FRP.connections();
        const st = await FRP.refresh();
        const s = (st.data || st.state || st);
        return { list: r.data.connections, agg: s.connectionsAgg, active: r.data.activeConnectionId };
      })()`);
      check('初始只有一条连接', initial.list.length === 1 && initial.active === 'c-default', JSON.stringify(initial.list.map((c) => c.id)));
      check('聚合里有这条连接', !!initial.agg && initial.agg.connections === 1, JSON.stringify(initial.agg));

      const added = await ev(`(async () => {
        const r = await FRP.connectionAdd({ name: 'B' });
        return { ok: r.ok, err: (r.error || '').slice(0, 120), conn: r.data && r.data.connection };
      })()`);
      check('新增一条连接成功', !!(added.ok && added.conn), JSON.stringify(added).slice(0, 200));
      if (!added.ok) return;

      /* 新连接必须是空配置：不能把 A 的 serverAddr/token 带过去 */
      const cfgText = fs.readFileSync(added.conn.configPath, 'utf8');
      check('新连接用的是独立配置文件', added.conn.configPath.includes(added.conn.id), added.conn.configPath);
      check('新连接是空起步配置（不复制当前连接的服务器信息）', /serverAddr = ""/.test(cfgText), cfgText.split('\n')[0]);
      check('两条连接的管理端口不同', added.conn.adminPort !== 7452, `${added.conn.adminPort} vs 7452`);

      const dup = await ev(`(async () => { const r = await FRP.connectionAdd({ name: 'B' }); return { ok: r.ok, err: r.error }; })()`);
      check('重名会被拦下', dup.ok === false && /已经有叫/.test(dup.err || ''), dup.err);

      const badPort = await ev(`(async () => { const r = await FRP.connectionUpdate({ id: '${added.conn.id}', adminPort: 7452 }); return { ok: r.ok, err: r.error }; })()`);
      check('管理端口撞车会被拦下', badPort.ok === false && /管理端口/.test(badPort.err || ''), badPort.err);

      const badPath = await ev(`(async () => { const r = await FRP.connectionUpdate({ id: '${added.conn.id}', configPath: ${JSON.stringify(dirAsConfig)} }); return { ok: r.ok, err: r.error }; })()`);
      check('把文件夹当配置文件会被拦下', badPath.ok === false && /文件夹/.test(badPath.err || ''), badPath.err);

      const renamed = await ev(`(async () => { const r = await FRP.connectionUpdate({ id: '${added.conn.id}', name: 'B2' }); return { ok: r.ok, name: r.data && r.data.connection && r.data.connection.name }; })()`);
      check('改名成功', renamed.ok === true && renamed.name === 'B2', JSON.stringify(renamed));

      const removeActive = await ev(`(async () => { const r = await FRP.connectionRemove('c-default'); return { ok: r.ok, err: r.error }; })()`);
      check('不许删当前连接', removeActive.ok === false && /当前连接/.test(removeActive.err || ''), removeActive.err);

      /* 切到 B2：当前没有隧道在跑，所以 stopped 应为空 */
      const act = await ev(`(async () => {
        const r = await FRP.connectionActive('${added.conn.id}');
        const list = await FRP.connections();
        return { ok: r.ok, stopped: r.data && r.data.stopped, active: list.data.activeConnectionId, count: list.data.connections.length };
      })()`);
      check('切换当前连接成功', act.ok === true && act.active === added.conn.id, JSON.stringify(act));

      const stAfter = await ev('(async () => { const st = await FRP.refresh(); const s = (st.data || st.state || st); return { cfg: s.paths && s.paths.configPath, agg: s.connectionsAgg }; })()');
      check('切换后全局配置路径跟着换', String(stAfter.cfg || '').includes(added.conn.id), stAfter.cfg);
      check('聚合仍然统计两条连接', !!stAfter.agg && stAfter.agg.connections === 2, JSON.stringify(stAfter.agg));

      const removed = await ev(`(async () => { const r = await FRP.connectionRemove('c-default'); return { ok: r.ok, err: r.error, count: r.data && r.data.connections && r.data.connections.length }; })()`);
      check('非当前连接可以删除', removed.ok === true && removed.count === 1, JSON.stringify(removed));
      check('删连接不删磁盘上的配置文件', fs.existsSync(cfgA), cfgA);
    } finally {
      try { await inst.stop(); } catch { /* ignore */ }
    }
  },
};
