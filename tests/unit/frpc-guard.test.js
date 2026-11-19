'use strict';
/* FrpcManager 的并发保护（1.2.95）。
 *
 * 界面上「启动隧道」是普通按钮，慢机器上双击很常见：两次 start 都会通过
 * 「管理端口还空着」的判断，各 spawn 一个 frpc 去抢同一个 admin 端口；
 * 输的那个退出时把管理器的 child 指针清掉 —— 隧道还活着，界面显示已停止。
 * 这里只测「并发调用被合并成一个」和「停止会等启动落地」，不真起进程。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { FrpcManager } = require('../../src/main/frpc');

function manager() {
  const ctx = {
    getSettings: () => ({}),
    ensureAdminConfig: async () => ({ ok: true }),
  };
  return new FrpcManager(ctx);
}

test('并发 start：只真正执行一次，所有调用拿到同一个结果', async () => {
  const m = manager();
  let calls = 0;
  m._start = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 40));
    return { ok: true, mode: 'managed' };
  };
  const results = await Promise.all([m.start(), m.start(), m.start(), m.start(), m.start()]);
  assert.equal(calls, 1, '连点五次只能 spawn 一次');
  for (const r of results) assert.equal(r.mode, 'managed');
  assert.equal(m.startPromise, null, '落地后要清掉，否则之后的启动永远返回旧结果');
});

test('start 落地后可以再次启动（单飞不是一次性锁）', async () => {
  const m = manager();
  let calls = 0;
  m._start = async () => {
    calls += 1;
    return { ok: true, calls };
  };
  await m.start();
  await m.start();
  assert.equal(calls, 2);
});

test('start 抛异常时也会清掉单飞标记，不会卡死', async () => {
  const m = manager();
  m._start = async () => {
    throw new Error('boom');
  };
  await assert.rejects(() => m.start(), /boom/);
  assert.equal(m.startPromise, null);
  m._start = async () => ({ ok: true, recovered: true });
  assert.deepEqual(await m.start(), { ok: true, recovered: true });
});

test('stop 在启动进行中调用时，会等启动落地再停', async () => {
  const m = manager();
  const order = [];
  m._start = async () => {
    order.push('start:begin');
    await new Promise((r) => setTimeout(r, 60));
    order.push('start:end');
    return { ok: true, mode: 'managed' };
  };
  m.stopManaged = async () => {
    order.push('stop');
    return { ok: true };
  };
  /* isChildAlive 是 getter（会去探 pid 是否还活着），这里直接改写成常量，
   * 让 stop 走「有子进程 → stopManaged」那条分支。 */
  Object.defineProperty(m, 'isChildAlive', { get: () => true, configurable: true });
  const started = m.start();
  const stopped = m.stop();
  await Promise.allSettled([started, stopped]);
  assert.deepEqual(order, ['start:begin', 'start:end', 'stop'], '停止必须排在启动完成之后');
});
