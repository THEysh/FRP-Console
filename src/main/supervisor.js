'use strict';
/* 隧道守护（自动重连）。
 *
 * 为什么需要它：frpc 自己在“连上了又断”时会退避重连，所以连接层的抖动不用我们管；
 * 但 frpc **进程**一旦没了（被杀软/游戏反作弊结束进程、崩溃、更新时被杀），
 * 以前只是弹一条通知就结束，用户必须手动点「启动隧道」。
 *
 * 这里只负责“什么时候再试一次”，真正的重启由 index.js 注入的 restart 回调完成，
 * 这样重连策略可以单独跑单测（不依赖 electron、不依赖真实进程）。
 *
 * 退避策略（用户 2026-11-23 拍板）：
 *   第 1~10 次：1s → 2s → 4s → 8s → 16s → 30s → 60s …（封顶 60s）
 *   第 11 次起：每 5 分钟试一次，直到成功或者用户取消。
 * 另外两个保护：
 *   - 快速失败（起来 3 秒内又挂）连续 3 次 → 间隔直接拉到 60 秒，避免配置坏了疯狂重启；
 *   - 稳定运行 60 秒后计数清零，下次断了重新从 1 秒开始。
 */

const FAST_BACKOFF = [1000, 2000, 4000, 8000, 16000, 30000, 60000];
const MAX_ATTEMPTS = 10;
const LONG_INTERVAL = 5 * 60 * 1000;
const FAST_FAIL_MS = 3000;
const FAST_FAIL_LIMIT = 3;
const STABLE_MS = 60000;

/* @param {number} attempt 即将进行的第几次尝试（从 1 开始）
 * @param {object} [opts] { fastFails } 连续“起来就挂”的次数
 * @returns {number} 等待毫秒数 */
function reconnectDelay(attempt, opts = {}) {
  const n = Math.max(1, Math.floor(Number(attempt) || 1));
  let delay;
  if (n <= FAST_BACKOFF.length) delay = FAST_BACKOFF[n - 1];
  else if (n <= MAX_ATTEMPTS) delay = FAST_BACKOFF[FAST_BACKOFF.length - 1];
  else delay = LONG_INTERVAL;
  // 快速失败保护：连着几次都是刚起来就挂，说明大概率是配置/端口问题，别再 1 秒一次刷。
  if ((Number(opts.fastFails) || 0) >= FAST_FAIL_LIMIT) delay = Math.max(delay, FAST_BACKOFF[FAST_BACKOFF.length - 1]);
  if (n > MAX_ATTEMPTS) delay = LONG_INTERVAL;
  return delay;
}

class ReconnectSupervisor {
  /* hooks:
   *   restart(): Promise<{ok:boolean,error?:string}>  真正去拉起隧道
   *   canRestart(): boolean                           现在该不该自动重连（用户关了开关/外来 frpc/正在升级/配置有错 → false）
   *   onChange(): void                                状态变了，通知界面刷新
   *   log(message, level): void                       写进日志页
   *   now(): number
   *   timers: { setTimeout, clearTimeout }
   */
  constructor(hooks = {}) {
    this.hooks = hooks;
    this.now = hooks.now || Date.now;
    this.setTimeout = (hooks.timers && hooks.timers.setTimeout) || setTimeout;
    this.clearTimeout = (hooks.timers && hooks.timers.clearTimeout) || clearTimeout;
    this.timer = null;
    this.state = 'idle'; // idle | waiting | running | stable
    this.attempts = 0;
    this.nextAt = 0;
    this.reason = '';
    this.lastError = '';
    this.fastFails = 0;
    this.lastStartAt = 0;
    this.stableTimer = null;
  }

  /* 现在是否有一个“待重连”在排队 */
  isWaiting() {
    return this.state === 'waiting' && !!this.timer;
  }

  view() {
    const now = this.now();
    const waiting = this.state === 'waiting';
    return {
      state: this.state,
      active: waiting || this.state === 'running',
      attempts: this.attempts,
      // 还有多少毫秒重试（等待中才有意义，界面直接显示“N 秒后重试”）
      nextInMs: waiting && this.nextAt ? Math.max(0, this.nextAt - now) : 0,
      reason: this.reason,
      lastError: this.lastError,
      // 已经退到“每 5 分钟一次”的阶段
      slowMode: this.attempts > MAX_ATTEMPTS,
    };
  }

  /* 排队一次重连。已经在排队就不重复排（避免 exit 事件和健康守护双触发）。 */
  arm(reason = '') {
    if (this.timer) return this.view();
    if (this.hooks.canRestart && !this.hooks.canRestart()) return this.view();
    this.attempts += 1;
    const delay = reconnectDelay(this.attempts, { fastFails: this.fastFails });
    this.state = 'waiting';
    this.reason = reason;
    this.nextAt = this.now() + delay;
    this.timer = this.setTimeout(() => {
      this.timer = null;
      this.run().catch(() => {});
    }, delay);
    if (this.hooks.log) {
      this.hooks.log(
        `[reconnect] 第 ${this.attempts} 次自动重连将在 ${Math.round(delay / 1000)} 秒后开始${reason ? `（原因：${reason}）` : ''}`,
        'warn'
      );
    }
    this.changed();
    return this.view();
  }

  async run() {
    if (this.hooks.canRestart && !this.hooks.canRestart()) {
      this.cancel('条件不满足');
      return;
    }
    this.state = 'running';
    this.nextAt = 0;
    this.changed();
    this.lastStartAt = this.now();
    let result;
    try {
      result = await this.hooks.restart();
    } catch (e) {
      result = { ok: false, error: (e && e.message) || String(e) };
    }
    if (result && result.ok) {
      this.lastError = '';
      this.state = 'stable';
      this.armStableCheck();
      if (this.hooks.log) this.hooks.log(`[reconnect] 第 ${this.attempts} 次重连成功`, 'info');
      this.changed();
      return;
    }
    this.lastError = (result && result.error) || '未知错误';
    const lived = this.now() - this.lastStartAt;
    if (lived < FAST_FAIL_MS) this.fastFails += 1;
    else this.fastFails = 0;
    if (this.hooks.log) this.hooks.log(`[reconnect] 第 ${this.attempts} 次重连失败：${this.lastError}`, 'error');
    this.changed();
    // 失败就继续排下一次（attempts 已经加过，这里不再 +1）
    if (!this.timer) {
      const delay = reconnectDelay(this.attempts + 1, { fastFails: this.fastFails });
      this.attempts += 1;
      this.state = 'waiting';
      this.nextAt = this.now() + delay;
      this.timer = this.setTimeout(() => {
        this.timer = null;
        this.run().catch(() => {});
      }, delay);
      this.changed();
    }
  }

  /* 起来了先别算“成功”：frpc 可能 2 秒后就挂（端口冲突、token 错）。
   * 稳定 60 秒才把计数清零，否则会一直停在“第 N 次”。 */
  armStableCheck() {
    if (this.stableTimer) this.clearTimeout(this.stableTimer);
    this.stableTimer = this.setTimeout(() => {
      this.stableTimer = null;
      this.attempts = 0;
      this.fastFails = 0;
      this.state = 'idle';
      this.reason = '';
      this.lastError = '';
      this.changed();
    }, STABLE_MS);
  }

  /* 运行期发现连接断了（进程还在，但管理 API 不通）时也要重置到“可以重连”的状态 */
  cancel(reason = '') {
    if (this.timer) this.clearTimeout(this.timer);
    if (this.stableTimer) this.clearTimeout(this.stableTimer);
    const had = !!(this.timer || this.stableTimer || this.state !== 'idle');
    this.timer = null;
    this.stableTimer = null;
    this.state = 'idle';
    this.nextAt = 0;
    this.attempts = 0;
    this.fastFails = 0;
    if (reason) this.reason = '';
    if (had && this.hooks.log && reason) this.hooks.log(`[reconnect] 已停止自动重连（${reason}）`, 'info');
    if (had) this.changed();
    return this.view();
  }

  changed() {
    if (this.hooks.onChange) {
      try {
        this.hooks.onChange();
      } catch (e) {
        /* 界面刷新失败不该影响重连本身 */
      }
    }
  }
}

module.exports = {
  ReconnectSupervisor,
  reconnectDelay,
  FAST_BACKOFF,
  MAX_ATTEMPTS,
  LONG_INTERVAL,
  STABLE_MS,
  FAST_FAIL_MS,
  FAST_FAIL_LIMIT,
};
