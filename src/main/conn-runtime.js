'use strict';
/* 多连接运行期状态容器与纯判定逻辑（I1 / I3 / I6）。
 *
 * 把「按连接持有的 Map + epoch 过期判定 + desired 状态机 + ensureAdmin 分派」
 * 抽成不依赖 Electron 的模块，既让主进程减少全局散落状态，也能直接用 node:test 跑单测。 */

function createConnectionRuntime() {
  const managers = new Map();
  const guards = new Map();
  const desired = new Map();
  const followers = new Map();
  const startedFingerprints = new Map();
  const parkedModels = new Map();
  const parkedStamps = new Map();
  const appliedStamps = new Map();
  const stopRequests = new Map();
  const apiDownSince = new Map();
  const netChangedAt = new Map();
  let epoch = 0;

  return {
    managers,
    guards,
    desired,
    followers,
    startedFingerprints,
    parkedModels,
    parkedStamps,
    appliedStamps,
    stopRequests,
    apiDownSince,
    netChangedAt,

    getEpoch() {
      return epoch;
    },

    bumpEpoch() {
      epoch += 1;
      return epoch;
    },

    isStaleEpoch(capturedEpoch) {
      return capturedEpoch !== epoch;
    },

    /* I1：一连接一 manager，幂等获取/创建。 */
    getOrCreateManager(connId, factory) {
      const id = String(connId || '');
      if (!id) return null;
      if (managers.has(id)) return managers.get(id);
      const created = factory(id);
      if (!created) return null;
      managers.set(id, created);
      return created;
    },

    /* I3：启动意图按连接存，未启动过的连接明确返回 false，绝不从其它连接继承。 */
    setDesired(connId, value) {
      const id = String(connId || '');
      const on = !!value;
      if (id) desired.set(id, on);
      return on;
    },

    isDesired(connId) {
      const id = String(connId || '');
      return !!(id && desired.get(id));
    },

    clearAllDesired() {
      for (const id of desired.keys()) desired.set(id, false);
    },

    markStopQuiet(connId, ms = 12000, now = Date.now()) {
      const id = String(connId || '');
      const until = now + ms;
      if (id) stopRequests.set(id, until);
      return until;
    },

    clearStopQuiet(connId) {
      const id = String(connId || '');
      if (id) stopRequests.delete(id);
    },

    isStopQuiet(connId, now = Date.now()) {
      const id = String(connId || '');
      const until = (id && stopRequests.get(id)) || 0;
      return until > now;
    },

    setFingerprint(connId, fp) {
      const id = String(connId || '');
      if (!id) return '';
      const text = String(fp || '');
      if (text) startedFingerprints.set(id, text);
      else startedFingerprints.delete(id);
      return text;
    },

    getFingerprint(connId) {
      const id = String(connId || '');
      return (id && startedFingerprints.get(id)) || '';
    },

    invalidateModel(connId) {
      const id = String(connId || '');
      if (!id) return;
      parkedModels.delete(id);
      parkedStamps.delete(id);
    },

    removeConnection(connId) {
      const id = String(connId || '');
      if (!id) return;
      const f = followers.get(id);
      if (f && typeof f.stop === 'function') {
        try { f.stop(); } catch { /* ignore */ }
      }
      managers.delete(id);
      guards.delete(id);
      desired.delete(id);
      followers.delete(id);
      startedFingerprints.delete(id);
      parkedModels.delete(id);
      parkedStamps.delete(id);
      appliedStamps.delete(id);
      stopRequests.delete(id);
      apiDownSince.delete(id);
      netChangedAt.delete(id);
    },
  };
}

/* ensureAdminFor 分派：当前连接走全局 model 落盘（同步磁盘 + persistModel），
 * 非当前连接走独立 frpc.toml 落盘（不碰全局 model）。 */
function dispatchEnsureAdmin({ conn, activeConnectionId, ensureActive, ensureParked }) {
  if (!conn) return { ok: false, error: '连接不存在' };
  if (conn.id === activeConnectionId) return ensureActive(conn);
  return ensureParked(conn);
}

/* 跨切换的异步结果丢弃判定（I6）。 */
function runWithEpochGuard(runtime, fn) {
  const captured = runtime.getEpoch();
  return Promise.resolve().then(fn).then((result) => ({
    stale: runtime.isStaleEpoch(captured),
    result,
  }));
}

module.exports = {
  createConnectionRuntime,
  dispatchEnsureAdmin,
  runWithEpochGuard,
};
