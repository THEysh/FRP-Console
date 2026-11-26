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

/* 参数化的自动重连阻断判定（C3）：每条连接按自己的模型、desired、foreign 判断；
 * 非当前连接一律托管进程，不做系统服务模式判定。空串表示允许自动重连。 */
function evalSupervisorBlockReason({
  conn,
  isActive = false,
  settings,
  desired = false,
  updatingNow = false,
  isQuitting = false,
  snapshot = null,
  validationErrors = [],
} = {}) {
  if (!settings) return '设置还没加载';
  if (!conn) return '连接不存在';
  if (settings.autoReconnect === false) return '用户关掉了「断线自动重连」';
  if (conn.autoReconnect === false) return '这条连接关掉了「断线自动重连」';
  if (conn.enabled === false) return '这条连接已停用';
  if (!desired) return '隧道不是程序启动的（用户没让它开）';
  if (updatingNow) return '正在安装更新';
  if (isQuitting) return '应用正在退出';
  if (!snapshot) return '管理器还没准备好';
  if (snapshot.foreign) return '管理端口上是别人的 frpc';
  if (isActive && (snapshot.mode === 'service' || snapshot.runtimeMode === 'service')) {
    return '隧道由系统服务托管，进程不归程序管';
  }
  if (Array.isArray(validationErrors) && validationErrors.length) {
    return `配置有 ${validationErrors.length} 处错误，先改配置`;
  }
  return '';
}

/* 后台连接重连通知策略（C3）：只有「当前查看」的连接弹通知，后台连接静默重连，
 * 状态通过概览与托盘实时反映，不打断用户当前操作。 */
function shouldNotifyExit({ isActive = false, quiet = false, isQuitting = false } = {}) {
  return !!(isActive && !quiet && !isQuitting);
}

/* 按连接推进「管理 API 连续无响应」健康窗口（C3）。返回 true 表示已超阈值应触发守护。 */
function stepApiDownWindow(runtime, connId, { eligible, connected, now = Date.now(), thresholdMs = 15000 } = {}) {
  const id = String(connId || '');
  if (!id || !eligible || connected) {
    if (id) runtime.apiDownSince.delete(id);
    return false;
  }
  const since = runtime.apiDownSince.get(id) || 0;
  if (!since) {
    runtime.apiDownSince.set(id, now);
    return false;
  }
  if (now - since > thresholdMs) {
    runtime.apiDownSince.delete(id);
    return true;
  }
  return false;
}

module.exports = {
  createConnectionRuntime,
  dispatchEnsureAdmin,
  runWithEpochGuard,
  evalSupervisorBlockReason,
  shouldNotifyExit,
  stepApiDownWindow,
};
