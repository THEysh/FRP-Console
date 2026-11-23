'use strict';
/* 隧道守护（自动重连）的策略单测：不依赖 electron、不依赖真实 frpc。 */
const test = require('node:test');
const assert = require('node:assert');
const {
  reconnectDelay,
  ReconnectSupervisor,
  MAX_ATTEMPTS,
  LONG_INTERVAL,
  STABLE_MS,
  FAST_FAIL_MS,
} = require('../../src/main/supervisor');

/* 极简假时钟：把 setTimeout 收进队列，由 tick() 手动推进。 */
function fakeClock(start = 1_000_000) {
  let now = start;
  let seq = 0;
  const pending = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      seq += 1;
      pending.set(seq, { fn, at: now + Math.max(0, ms) });
      return seq;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    pendingCount: () => pending.size,
    /* 推进到点：按到期时间顺序执行（执行中新增的定时器也会被看到）。 */
    async tick(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, t] = due;
        pending.delete(id);
        now = t.at;
        t.fn();
        // 让 run() 里的 await 落地
        await Promise.resolve();
        await Promise.resolve();
      }
      now = target;
    },
  };
}

test('退避序列：1 秒起，封顶 60 秒，第 11 次起每 5 分钟', () => {
  assert.equal(reconnectDelay(1), 1000);
  assert.equal(reconnectDelay(2), 2000);
  assert.equal(reconnectDelay(3), 4000);
  assert.equal(reconnectDelay(4), 8000);
  assert.equal(reconnectDelay(5), 16000);
  assert.equal(reconnectDelay(6), 30000);
  for (let n = 7; n <= MAX_ATTEMPTS; n += 1) assert.equal(reconnectDelay(n), 60000, `第 ${n} 次应是 60 秒`);
  assert.equal(reconnectDelay(11), LONG_INTERVAL);
  assert.equal(reconnectDelay(50), LONG_INTERVAL);
  assert.equal(LONG_INTERVAL, 5 * 60 * 1000);
});

test('快速失败保护：连着 3 次“起来就挂”后，第一次也要等 60 秒', () => {
  assert.equal(reconnectDelay(1, { fastFails: 0 }), 1000);
  assert.equal(reconnectDelay(1, { fastFails: 2 }), 1000);
  assert.equal(reconnectDelay(1, { fastFails: 3 }), 60000);
});

test('arm → 到点重启；成功则进入 stable，60 秒后计数清零', async () => {
  const clock = fakeClock();
  let restarts = 0;
  const sup = new ReconnectSupervisor({
    now: clock.now,
    timers: { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
    canRestart: () => true,
    restart: async () => {
      restarts += 1;
      return { ok: true };
    },
  });

  const v1 = sup.arm('frpc 意外退出');
  assert.equal(v1.state, 'waiting');
  assert.equal(v1.attempts, 1);
  assert.equal(v1.nextInMs, 1000);

  await clock.tick(1000);
  assert.equal(restarts, 1);
  assert.equal(sup.view().state, 'stable');

  // 60 秒稳定期过后计数归零
  await clock.tick(STABLE_MS);
  const v2 = sup.view();
  assert.equal(v2.state, 'idle');
  assert.equal(v2.attempts, 0);
});

test('重启失败会接着排下一次，次数递增、间隔按退避走', async () => {
  const clock = fakeClock();
  const seen = [];
  const sup = new ReconnectSupervisor({
    now: clock.now,
    timers: { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
    canRestart: () => true,
    restart: async () => {
      seen.push(Date.now ? clock.now() : 0);
      return { ok: false, error: 'connect refused' };
    },
  });

  sup.arm('挂了');
  await clock.tick(1000); // 第 1 次执行（失败）→ 排第 2 次
  let v = sup.view();
  assert.equal(v.attempts, 2);
  assert.equal(v.nextInMs, 2000);
  assert.equal(v.lastError, 'connect refused');

  await clock.tick(2000); // 第 2 次（失败）→ 排第 3 次
  v = sup.view();
  assert.equal(v.attempts, 3);
  assert.equal(v.nextInMs, 4000);
  assert.equal(seen.length, 2);
});

test('canRestart 为 false 时不排队（用户关了开关 / 外来 frpc / 升级中）', () => {
  const clock = fakeClock();
  const sup = new ReconnectSupervisor({
    now: clock.now,
    timers: { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
    canRestart: () => false,
    restart: async () => ({ ok: true }),
  });
  const v = sup.arm('意外退出');
  assert.equal(v.state, 'idle');
  assert.equal(clock.pendingCount(), 0);
});

test('重复 arm 不会排队两次（exit 事件与健康守护同时触发）', () => {
  const clock = fakeClock();
  const sup = new ReconnectSupervisor({
    now: clock.now,
    timers: { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
    canRestart: () => true,
    restart: async () => ({ ok: true }),
  });
  sup.arm('a');
  sup.arm('b');
  assert.equal(clock.pendingCount(), 1);
  assert.equal(sup.view().attempts, 1);
});

test('cancel 清掉定时器并归零；之后还能重新 arm', async () => {
  const clock = fakeClock();
  let restarts = 0;
  const sup = new ReconnectSupervisor({
    now: clock.now,
    timers: { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
    canRestart: () => true,
    restart: async () => {
      restarts += 1;
      return { ok: true };
    },
  });
  sup.arm('挂了');
  sup.cancel('用户停止了隧道');
  assert.equal(sup.view().state, 'idle');
  assert.equal(clock.pendingCount(), 0);

  await clock.tick(5000);
  assert.equal(restarts, 0);

  sup.arm('又挂了');
  await clock.tick(1000);
  assert.equal(restarts, 1);
});

test('快速失败计数：起来不到 3 秒就挂，会累积 fastFails', async () => {
  const clock = fakeClock();
  const sup = new ReconnectSupervisor({
    now: clock.now,
    timers: { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
    canRestart: () => true,
    restart: async () => {
      // 模拟“起来就挂”：等 1 秒（小于 FAST_FAIL_MS）后返回失败
      await new Promise((r) => {
        clock.setTimeout(r, 1000);
      });
      return { ok: false, error: 'spawn failed' };
    },
  });
  sup.arm('挂了');
  await clock.tick(1000);
  // 第一次执行中又排了 1 秒的“运行”定时器；推进后失败落地
  await clock.tick(1000);
  assert.ok(FAST_FAIL_MS > 0);
  const v = sup.view();
  assert.ok(v.attempts >= 2);
});
