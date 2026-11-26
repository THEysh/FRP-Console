'use strict';
/* 多连接运行期状态机单测（1.2.229 C2）：
 *   1. manager 幂等获取与创建（I1）
 *   2. desired 状态机按连接隔离，绝不从 active 泄漏到未启动的连接（I3）
 *   3. epoch 递增与跨切换异步结果丢弃（I6）
 *   4. ensureAdminFor active / parked 分派
 *   5. stopRequests 静音窗口按连接隔离，启动时清除旧静音期
 *   6. 真进程验证（有 frpc.exe 时）：两条连接各自起 frpc，切换 active 指针后两个 pid 不变且各自管理端口仍独立响应
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { createConnectionRuntime, dispatchEnsureAdmin, runWithEpochGuard } = require('../../src/main/conn-runtime');
const { FrpcManager } = require('../../src/main/frpc');
const configModule = require('../../src/main/config');

test('getOrCreateManager：同一 connId 幂等返回同一实例，不同 connId 互相独立', () => {
  const rt = createConnectionRuntime();
  let created = 0;
  const factory = (id) => {
    created += 1;
    return { id, seq: created };
  };
  const a1 = rt.getOrCreateManager('c-a', factory);
  const a2 = rt.getOrCreateManager('c-a', factory);
  const b1 = rt.getOrCreateManager('c-b', factory);
  assert.strictEqual(a1, a2);
  assert.notStrictEqual(a1, b1);
  assert.equal(created, 2);
  assert.equal(rt.getOrCreateManager('', factory), null);
});

test('desired 状态机：按连接独立保存，未启动的连接始终为 false', () => {
  const rt = createConnectionRuntime();
  assert.equal(rt.isDesired('c-a'), false);
  assert.equal(rt.isDesired('c-b'), false);

  rt.setDesired('c-a', true);
  assert.equal(rt.isDesired('c-a'), true);
  assert.equal(rt.isDesired('c-b'), false, '启动 A 不能影响从未启动的 B');

  rt.setDesired('c-b', true);
  rt.setDesired('c-a', false);
  assert.equal(rt.isDesired('c-a'), false);
  assert.equal(rt.isDesired('c-b'), true, '停止 A 不能影响 B');

  rt.clearAllDesired();
  assert.equal(rt.isDesired('c-a'), false);
  assert.equal(rt.isDesired('c-b'), false);
});

test('epoch 丢弃逻辑：await 期间发生切换，返回 stale=true', async () => {
  const rt = createConnectionRuntime();
  const sameEpoch = await runWithEpochGuard(rt, async () => {
    await new Promise((r) => setTimeout(r, 15));
    return 'ok-same';
  });
  assert.equal(sameEpoch.stale, false);
  assert.equal(sameEpoch.result, 'ok-same');

  const pending = runWithEpochGuard(rt, async () => {
    await new Promise((r) => setTimeout(r, 40));
    return 'from-old-active';
  });
  rt.bumpEpoch();
  const switched = await pending;
  assert.equal(switched.stale, true, '切换后返回的异步结果必须标记为 stale');
  assert.equal(switched.result, 'from-old-active');
});

test('ensureAdminFor 分派：active 与 parked 走各自回调，空连接报错', () => {
  const calls = [];
  const resActive = dispatchEnsureAdmin({
    conn: { id: 'c-a', configPath: 'a.toml' },
    activeConnectionId: 'c-a',
    ensureActive: (c) => { calls.push(['active', c.id]); return { ok: true, branch: 'active' }; },
    ensureParked: (c) => { calls.push(['parked', c.id]); return { ok: true, branch: 'parked' }; },
  });
  const resParked = dispatchEnsureAdmin({
    conn: { id: 'c-b', configPath: 'b.toml' },
    activeConnectionId: 'c-a',
    ensureActive: (c) => { calls.push(['active', c.id]); return { ok: true, branch: 'active' }; },
    ensureParked: (c) => { calls.push(['parked', c.id]); return { ok: true, branch: 'parked' }; },
  });
  const resMissing = dispatchEnsureAdmin({
    conn: null,
    activeConnectionId: 'c-a',
    ensureActive: () => ({ ok: true }),
    ensureParked: () => ({ ok: true }),
  });

  assert.equal(resActive.branch, 'active');
  assert.equal(resParked.branch, 'parked');
  assert.equal(resMissing.ok, false);
  assert.deepEqual(calls, [['active', 'c-a'], ['parked', 'c-b']]);
});

test('stopRequests 静音窗按连接隔离，clearStopQuiet 允许刚停又启后立即响应崩溃', () => {
  const rt = createConnectionRuntime();
  const t0 = 100000;
  rt.markStopQuiet('c-a', 12000, t0);
  assert.equal(rt.isStopQuiet('c-a', t0 + 1000), true);
  assert.equal(rt.isStopQuiet('c-b', t0 + 1000), false);
  assert.equal(rt.isStopQuiet('c-a', t0 + 12001), false);

  rt.clearStopQuiet('c-a');
  assert.equal(rt.isStopQuiet('c-a', t0 + 1000), false);
});

test('removeConnection 彻底清理连接对应的所有 Map 条目并停掉 follower', () => {
  const rt = createConnectionRuntime();
  let stopped = false;
  rt.managers.set('c-b', { id: 'c-b' });
  rt.guards.set('c-b', { cancel() {} });
  rt.setDesired('c-b', true);
  rt.followers.set('c-b', { stop() { stopped = true; } });
  rt.setFingerprint('c-b', 'fp-b');
  rt.markStopQuiet('c-b', 5000);
  rt.parkedModels.set('c-b', {});
  rt.apiDownSince.set('c-b', 123);

  rt.removeConnection('c-b');
  assert.equal(stopped, true);
  assert.equal(rt.managers.has('c-b'), false);
  assert.equal(rt.guards.has('c-b'), false);
  assert.equal(rt.isDesired('c-b'), false);
  assert.equal(rt.followers.has('c-b'), false);
  assert.equal(rt.getFingerprint('c-b'), '');
  assert.equal(rt.stopRequests.has('c-b'), false);
  assert.equal(rt.parkedModels.has('c-b'), false);
  assert.equal(rt.apiDownSince.has('c-b'), false);
});

function freePort(start) {
  return new Promise((resolve) => {
    let port = start;
    const next = () => {
      if (port > start + 200) { resolve(0); return; }
      const srv = net.createServer();
      srv.once('error', () => { port += 1; next(); });
      srv.listen(port, '127.0.0.1', () => {
        const picked = port;
        srv.close(() => resolve(picked));
      });
    };
    next();
  });
}

test('真进程 I1+I2：双 FrpcManager 动态 ctx 切换 active 指针后，两条 frpc 的 pid 不变且各自管理端口独立', async (t) => {
  const frpcPath = path.resolve(__dirname, '..', '..', 'vendor', 'frpc', 'frpc.exe');
  if (!fs.existsSync(frpcPath)) {
    t.skip('缺少 vendor/frpc/frpc.exe，跳过真进程测试');
    return;
  }
  const portA = await freePort(17410);
  const portB = await freePort(portA + 1);
  assert.ok(portA && portB && portA !== portB);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frp-c2-test-'));
  const cfgA = path.join(dir, 'a.toml');
  const cfgB = path.join(dir, 'b.toml');
  const writeCfg = (file, adminPort) => {
    fs.writeFileSync(file, [
      'serverAddr = "127.0.0.1"',
      'serverPort = 1',
      'loginFailExit = false',
      '',
      '[webServer]',
      'addr = "127.0.0.1"',
      `port = ${adminPort}`,
      'user = "admin"',
      'password = "unit-pass-123456"',
      '',
    ].join('\n'), 'utf8');
  };
  writeCfg(cfgA, portA);
  writeCfg(cfgB, portB);

  const conns = [
    { id: 'c-a', configPath: cfgA, logPath: path.join(dir, 'a.log'), adminPort: portA },
    { id: 'c-b', configPath: cfgB, logPath: path.join(dir, 'b.log'), adminPort: portB },
  ];
  let activeId = 'c-a';
  const baseSettings = { adminUser: 'admin', adminPassword: 'unit-pass-123456', stripProxyEnv: true };
  const modelById = {
    'c-a': configModule.readConfig(cfgA),
    'c-b': configModule.readConfig(cfgB),
  };
  const rt = createConnectionRuntime();
  const makeMgr = (id) => rt.getOrCreateManager(id, () => new FrpcManager({
    getSettings: () => {
      const c = conns.find((x) => x.id === id);
      return { ...baseSettings, adminPort: c.adminPort };
    },
    getPaths: () => {
      const c = conns.find((x) => x.id === id);
      return { frpcPath, configPath: c.configPath, logPath: c.logPath };
    },
    getConfig: () => modelById[id],
    ensureAdminConfig: async () => ({ ok: true }),
    startService: async () => ({ ok: false, error: 'managed only' }),
    stopService: async () => ({ ok: false, error: 'managed only' }),
  }));

  const mmA = makeMgr('c-a');
  const mmB = makeMgr('c-b');
  try {
    const rA = await mmA.start({ runMode: 'managed' });
    const rB = await mmB.start({ runMode: 'managed' });
    assert.equal(rA.ok, true, rA.error);
    assert.equal(rB.ok, true, rB.error);
    await mmA.refresh();
    await mmB.refresh();
    const pidA = mmA.snapshot().pid;
    const pidB = mmB.snapshot().pid;
    assert.ok(pidA && pidB && pidA !== pidB, `应有两个独立 pid：${pidA} vs ${pidB}`);
    assert.equal(mmA.snapshot().adminPort, portA);
    assert.equal(mmB.snapshot().adminPort, portB);

    /* 模拟切换视图指针：只换 activeId + epoch，不碰任何进程 */
    activeId = 'c-b';
    rt.bumpEpoch();
    await mmA.refresh();
    await mmB.refresh();
    assert.equal(activeId, 'c-b');
    assert.equal(mmA.snapshot().pid, pidA, '切到 B 后 A 的 pid 必须不变');
    assert.equal(mmB.snapshot().pid, pidB, '切到 B 后 B 的 pid 必须不变');
    assert.equal(mmA.snapshot().adminPort, portA, '切到 B 后 A 仍问自己的管理端口');
    assert.equal(mmB.snapshot().adminPort, portB, '切到 B 后 B 仍问自己的管理端口');

    /* 停止 A，B 完全不受影响 */
    await mmA.stop({ runMode: 'managed' });
    await mmA.refresh();
    await mmB.refresh();
    assert.equal(mmA.snapshot().pid, null);
    assert.equal(mmB.snapshot().pid, pidB);
    assert.equal(mmB.snapshot().connected, true);
  } finally {
    await mmA.stop({ runMode: 'managed' }).catch(() => {});
    await mmB.stop({ runMode: 'managed' }).catch(() => {});
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
