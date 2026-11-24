'use strict';
/* 多连接（同一个控制台同时保持 N 条隧道）的数据层。
 *
 * 为什么要有这一层：frp 的语义是「一个 frpc 进程 = 一个 frps + 一份配置 + 一个管理端口」，
 * 所以「同时连多台服务器」= 同时跑 N 个 frpc。这一层只负责「有几条连接、各自用哪份配置/
 * 哪个管理端口、当前在看哪一条」，不碰进程、不碰界面。
 *
 * 三条不变量（改这里之前先读一遍）：
 *   1. 连接里**不存** serverAddr / token —— 真相在磁盘上的 frpc.toml，存两份必然不一致
 *      （1.2.138「改了服务器地址但隧道没换」就是两份数据打了架）。
 *   2. 每条连接独占 configPath / logPath / adminPort，绝不共用。
 *   3. 代理的身份是「连接 + 名字」，不是名字 —— 两台服务器上出现同名代理完全合法，
 *      而 healthCache / proxyOpenPaths 过去都只按名字做键。
 */

const crypto = require('node:crypto');

/* 第一次迁移造出来的那条连接固定用这个 id：它是「老用户原本那一份配置」，
 * 之后新增的连接都拿随机 id。id 永不复用（删了再加不会捡回旧状态）。 */
const DEFAULT_CONNECTION_ID = 'c-default';
/* 上限只是防御手改配置：真到 8 条以上，界面与健康检查都该先重新设计。 */
const MAX_CONNECTIONS = 8;

function newConnectionId() {
  return `c-${crypto.randomBytes(4).toString('hex')}`;
}

/* 代理在图里、缓存里、设置里的唯一标识。 */
function keyOf(connectionId, proxyName) {
  return `${String(connectionId || '')}::${String(proxyName || '')}`;
}

function splitKey(key) {
  const text = String(key || '');
  const at = text.indexOf('::');
  if (at < 0) return { connectionId: '', name: text };
  return { connectionId: text.slice(0, at), name: text.slice(at + 2) };
}

function clampPort(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : fallback;
}

function normalizeConnection(input = {}) {
  const id = String(input.id || '').trim();
  return {
    id: /^[A-Za-z0-9_-]{1,40}$/.test(id) ? id : newConnectionId(),
    serverId: String(input.serverId || '').trim(),
    name: String(input.name || '').trim().slice(0, 60) || '新连接',
    configPath: String(input.configPath || '').trim(),
    logPath: String(input.logPath || '').trim(),
    adminPort: clampPort(input.adminPort, 7400),
    // enabled：控制台启动时是否跟着一起起来
    enabled: input.enabled !== false,
    // 每条连接自己的重连开关（默认跟随全局，但允许单条关掉）
    autoReconnect: input.autoReconnect !== false,
  };
}

/* 在已占用的端口集合里找一个能用的，从 start 开始往上。 */
function nextFreePort(used, start) {
  let port = clampPort(start, 7400);
  for (let i = 0; i < 400; i += 1) {
    if (!used.has(port)) return port;
    port = port >= 65535 ? 7400 : port + 1;
  }
  return port;
}

/* 端口去重：手改过 settings.json、或者两条连接被填成同一个端口时才会命中。
 * 不改用户的文件，只在内存里顺延，并让调用方知道「改过了」。 */
function dedupeAdminPorts(list) {
  const used = new Set();
  let changed = false;
  const out = list.map((item) => {
    const conn = { ...item };
    if (used.has(conn.adminPort)) {
      conn.adminPort = nextFreePort(used, conn.adminPort);
      changed = true;
    }
    used.add(conn.adminPort);
    return conn;
  });
  return { connections: out, changed };
}

function sameConnections(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((item, i) => (
    item.id === b[i].id
    && item.serverId === b[i].serverId
    && item.name === b[i].name
    && item.configPath === b[i].configPath
    && item.logPath === b[i].logPath
    && item.adminPort === b[i].adminPort
    && item.enabled === b[i].enabled
    && item.autoReconnect === b[i].autoReconnect
  ));
}

/* 老数据里没有任何连接：用「当前那一份配置」造出第一条。
 * 这一步必须无损——用户在意的只有 configPath / logPath / adminPort，
 * 以及它指向哪台服务器档案（证书、nginx、SSH 都挂在档案上）。 */
function legacyConnection(raw = {}) {
  const servers = Array.isArray(raw.servers) ? raw.servers : [];
  const bound = servers.find((s) => s && s.id === raw.clientServerId)
    || servers.find((s) => s && s.id === raw.activeServerId)
    || null;
  const label = bound ? (String(bound.name || '').trim() || String(bound.host || '').trim()) : '';
  return normalizeConnection({
    id: DEFAULT_CONNECTION_ID,
    serverId: bound ? bound.id : '',
    name: label || '默认连接',
    configPath: raw.configPath || '',
    logPath: raw.logPath || '',
    adminPort: raw.adminPort || 7400,
  });
}

/* 迁移入口：幂等。传进来的 raw 就是 settings.json 的内容（或已经 load 过的对象）。
 * 返回的连接列表里，第一条永远是「老用户原本那条」（id=c-default），
 * 这样即使后面新增/删除别的连接，老配置也不会被换到另一个 id 下。 */
function migrateConnections(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const incoming = Array.isArray(source.connections)
    ? source.connections.filter((item) => item && typeof item === 'object')
    : [];

  if (incoming.length) {
    let normalized = incoming.slice(0, MAX_CONNECTIONS).map((item) => normalizeConnection(item));
    // 去重 id（手改配置可能写重）
    const seen = new Set();
    let changedIds = false;
    normalized = normalized.map((conn) => {
      if (seen.has(conn.id)) {
        changedIds = true;
        return { ...conn, id: newConnectionId() };
      }
      seen.add(conn.id);
      return conn;
    });
    const deduped = dedupeAdminPorts(normalized);
    const connections = deduped.connections;
    let active = String(source.activeConnectionId || '');
    if (!connections.some((c) => c.id === active)) active = connections[0].id;
    const changed = changedIds || deduped.changed
      || active !== String(source.activeConnectionId || '')
      || !sameConnections(connections, incoming);
    return { connections, activeConnectionId: active, changed };
  }

  const conn = legacyConnection(source);
  return { connections: [conn], activeConnectionId: conn.id, changed: true };
}

function findConnection(connections, id) {
  const list = Array.isArray(connections) ? connections : [];
  return list.find((c) => c && c.id === id) || list[0] || null;
}

/* 设置页填了新的 configPath/logPath/adminPort 时，写回当前连接 ——
 * 否则「连接列表」与「顶层字段」会各说各话（1.2.138 同款问题）。 */
function applyLegacyPaths(connections, activeId, patch = {}) {
  const list = Array.isArray(connections) ? connections : [];
  const target = findConnection(list, activeId);
  if (!target) return { connections: list, changed: false };
  let changed = false;
  const next = list.map((conn) => {
    if (conn.id !== target.id) return conn;
    const copy = { ...conn };
    if (patch.configPath !== undefined && String(patch.configPath || '').trim() !== conn.configPath) {
      copy.configPath = String(patch.configPath || '').trim();
      changed = true;
    }
    if (patch.logPath !== undefined && String(patch.logPath || '').trim() !== conn.logPath) {
      copy.logPath = String(patch.logPath || '').trim();
      changed = true;
    }
    if (patch.adminPort !== undefined) {
      const port = clampPort(patch.adminPort, conn.adminPort);
      if (port !== conn.adminPort) {
        copy.adminPort = port;
        changed = true;
      }
    }
    return copy;
  });
  return { connections: next, changed };
}

module.exports = {
  DEFAULT_CONNECTION_ID,
  MAX_CONNECTIONS,
  newConnectionId,
  keyOf,
  splitKey,
  normalizeConnection,
  nextFreePort,
  dedupeAdminPorts,
  migrateConnections,
  findConnection,
  applyLegacyPaths,
  clampPort,
};
