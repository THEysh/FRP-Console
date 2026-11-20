'use strict';
/* 并发/竞态：用户在界面上「手快」时会发生的事。
 *
 * 1.2.90 那个「启动后显示未连接、切一下档案才好」的 bug 就是竞态：一次成功的连接
 * 结果被后到的状态刷新挤掉。这类问题的共同点是**单个操作都对，两个一起就错**，
 * 靠人点很难复现，所以这里直接把 IPC 并发打出去。
 */
module.exports = {
  id: '18-race',
  title: '并发与竞态：连点启动/停止、并发保存同一代理、运行中保存配置',
  needs: ['frps', 'frpc', 'local'],
  async run(ctx) {
    const evalIpc = (body) => ctx.eval(`(async () => { ${body} })()`);
    const { ensureConfig } = require('../helpers/seed.cjs');
    /* 单独跑这个场景（--only=race）时，前面的场景没帮忙写隧道目标，
     * 直接 startTunnel 只会报「服务器地址不能为空」。 */
    const seeded = await ensureConfig(ctx);
    ctx.check('隧道目标指向测试 frps', seeded && seeded.ok, JSON.stringify(seeded));

    /* ---------- ① 连点「启动隧道」5 次 ---------- */
    await evalIpc(`await FRP.stopTunnel(); return 1;`);
    const burst = await evalIpc(`
      const results = await Promise.all([1, 2, 3, 4, 5].map(() => FRP.startTunnel()));
      return results.map((r) => ({ ok: !!(r && r.ok), mode: r && r.data && r.data.mode }));
    `);
    ctx.check('连点启动没有报错', Array.isArray(burst) && burst.every((r) => r.ok), JSON.stringify(burst));
    const afterBurst = await ctx.waitFor(
      () => evalIpc('const r = await FRP.refresh(); return r.data.runtime;'),
      (rt) => rt && rt.connected === true,
      { timeout: 25000, label: '隧道连上' },
    );
    ctx.check('五次并发启动后处于托管模式且已连上', afterBurst.mode === 'managed' && afterBurst.connected === true, JSON.stringify(afterBurst));

    /* 只应该有一个 frpc：pid 稳定，且管理 API 只有一个在应答。 */
    const pids = [];
    for (let i = 0; i < 3; i++) {
      pids.push((await evalIpc('const r = await FRP.refresh(); return r.data.runtime.pid;')) || null);
      await ctx.sleep(400);
    }
    ctx.check('没有出现两个 frpc（pid 全程一致）', pids.every((p) => p && p === pids[0]), pids.join(','));

    /* ---------- ② 启动还没完成就叫停 ---------- */
    const interleaved = await evalIpc(`
      const a = FRP.stopTunnel();
      const b = FRP.startTunnel();
      const c = FRP.stopTunnel();
      const res = await Promise.allSettled([a, b, c]);
      return res.map((r) => (r.status === 'fulfilled' ? 'ok' : String(r.reason && r.reason.message || r.reason)));
    `);
    ctx.check('启动/停止交叉调用没有抛异常', interleaved.every((x) => x === 'ok'), interleaved.join(','));
    /* stop→start→stop 并发，最终是「跑着」还是「停了」取决于调度，不该断言具体结局；
     * 要守的是「不会卡在 starting」以及「显式停止一定能停下」。 */
    const settled = await ctx.waitFor(
      () => evalIpc('const r = await FRP.refresh(); return r.data.runtime;'),
      (rt) => rt && rt.mode !== 'starting',
      { timeout: 25000, label: '交叉调用后状态收敛（不卡在 starting）' },
    );
    ctx.check('交叉调用后不会卡在 starting', settled.mode !== 'starting', JSON.stringify({ mode: settled.mode, pid: settled.pid }));

    await evalIpc('await FRP.stopTunnel(); return 1;');
    const stopped = await ctx.waitFor(
      () => evalIpc('const r = await FRP.refresh(); return r.data.runtime;'),
      (rt) => rt && rt.connected === false,
      { timeout: 25000, label: '显式停止后不再连接' },
    );
    ctx.check('显式停止后确实停下', stopped.mode === 'stopped' || stopped.pid === null, JSON.stringify({ mode: stopped.mode, pid: stopped.pid }));

    /* ---------- ③ 并发保存同一条代理 ---------- */
    await evalIpc(`await FRP.saveProxy('add', '', { name: 'race-a', type: 'tcp', localIP: '127.0.0.1', localPort: 18080, remotePort: 23411 }); return 1;`);
    const saves = await evalIpc(`
      const base = { name: 'race-a', type: 'tcp', localIP: '127.0.0.1', localPort: 18080 };
      const ports = [23412, 23413, 23414];
      const res = await Promise.all(ports.map((p) => FRP.saveProxy('edit', 'race-a', { ...base, remotePort: p })));
      return res.map((r) => !!(r && r.ok));
    `);
    ctx.check('三次并发保存都返回了结果', Array.isArray(saves) && saves.length === 3, JSON.stringify(saves));
    const snapshot = await evalIpc(`
      const r = await FRP.refresh();
      const p = (r.data.proxies || []).filter((x) => x.name === 'race-a');
      return { count: p.length, ports: p.map((x) => x.remotePort), configError: r.data.configError || '' };
    `);
    ctx.check('代理没有被写成两条', snapshot.count === 1, JSON.stringify(snapshot));
    ctx.check(
      '落盘的端口是三次里的一个（不是半截值）',
      [23412, 23413, 23414].includes(Number(snapshot.ports[0])),
      JSON.stringify(snapshot.ports),
    );
    ctx.check('并发保存后配置仍可解析', !snapshot.configError, snapshot.configError);

    /* ---------- ④ 并发「新增」与「删除」同名代理 ---------- */
    const addDrop = await evalIpc(`
      const base = { name: 'race-b', type: 'tcp', localIP: '127.0.0.1', localPort: 18080, remotePort: 23415 };
      const res = await Promise.allSettled([
        FRP.saveProxy('add', '', base),
        FRP.saveProxy('add', '', { ...base, remotePort: 23416 }),
        FRP.deleteProxy('race-b'),
      ]);
      return res.map((r) => (r.status === 'fulfilled' ? !!(r.value && r.value.ok) : 'rejected'));
    `);
    ctx.check('并发新增+删除不抛异常', addDrop.every((x) => x !== 'rejected'), JSON.stringify(addDrop));
    const afterAddDrop = await evalIpc(`
      const r = await FRP.refresh();
      const p = (r.data.proxies || []).filter((x) => x.name === 'race-b');
      return { count: p.length, configError: r.data.configError || '' };
    `);
    ctx.check('同名代理最多只剩一条', afterAddDrop.count <= 1, JSON.stringify(afterAddDrop));
    ctx.check('配置没有被并发写坏', !afterAddDrop.configError, afterAddDrop.configError);

    /* ---------- ⑤ 隧道运行时，保存配置与热重载并发 ---------- */
    await evalIpc(`
      await FRP.saveProxy('add', '', { name: 'race-c', type: 'tcp', localIP: '127.0.0.1', localPort: 18080, remotePort: 23417 });
      await FRP.startTunnel();
      return 1;
    `);
    const hotRace = await evalIpc(`
      const res = await Promise.allSettled([
        FRP.reloadTunnel(),
        FRP.saveProxy('edit', 'race-c', { name: 'race-c', type: 'tcp', localIP: '127.0.0.1', localPort: 18080, remotePort: 23418 }),
        FRP.reloadTunnel(),
      ]);
      return res.map((r) => (r.status === 'fulfilled' ? !!(r.value && r.value.ok) : 'rejected'));
    `);
    ctx.check('运行中并发重载+保存不抛异常', hotRace.every((x) => x !== 'rejected'), JSON.stringify(hotRace));
    const afterHot = await evalIpc(`
      const r = await FRP.refresh();
      const p = (r.data.proxies || []).find((x) => x.name === 'race-c');
      return { port: p && p.remotePort, configError: r.data.configError || '', mode: r.data.runtime.mode };
    `);
    ctx.check('并发之后配置仍是合法的（能读出端口）', Number(afterHot.port) === 23418, JSON.stringify(afterHot));
    ctx.check('隧道仍在运行', afterHot.mode === 'managed', String(afterHot.mode));

    /* 收尾：把这几个测试代理删掉，别影响后面的场景 */
    await evalIpc(`
      await FRP.deleteProxy('race-a');
      await FRP.deleteProxy('race-b');
      await FRP.deleteProxy('race-c');
      await FRP.stopTunnel();
      return 1;
    `);
  },
};
