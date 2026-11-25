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
/* 上限只是防御手改配置。1.2.192 起一条连接 = 一台服务器，8 台不够用，放到 16。 */
const MAX_CONNECTIONS = 16;

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
    /* SSH 事实（1.2.192）：以前存在「服务器档案」里，档案与连接是两套东西；
     * 现在连接自己记住「我连的是哪台机器的 SSH」，档案退化成它的历史来源。
     * frps 的 serverAddr / token 不在这里——那是 frpc.toml 的事。 */
    host: String(input.host || '').trim(),
    port: Number(input.port) >= 1 && Number(input.port) <= 65535 ? Number(input.port) : 22,
    username: String(input.username || '').trim() || 'root',
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

/* 老数据迁移（1.2.192）：连接过去只记 serverId，SSH 地址在「服务器档案」里。
 * 现在连接自己该记住它连的是哪台机器，所以启动时按 serverId 把 host/port/username
 * 抄过来；没有 serverId 的（手写 settings 或新建连接）保持空，连接时会用配置里的
 * serverAddr 兜底并回写。纯函数，不写盘。 */
function backfillConnectionHosts(connections, profiles) {
  const list = Array.isArray(connections) ? connections : [];
  const pool = Array.isArray(profiles) ? profiles : [];
  let changed = false;
  const out = list.map((conn) => {
    if (!conn || String(conn.host || '').trim()) return conn;
    const p = pool.find((x) => x && x.id && x.id === conn.serverId) || null;
    if (!p || !String(p.host || '').trim()) return conn;
    changed = true;
    return {
      ...conn,
      host: String(p.host || '').trim(),
      port: Number(p.port) || 22,
      username: String(p.username || '').trim() || 'root',
    };
  });
  return { connections: out, changed };
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

/* http/https/tcpmux 代理对外发布的域名。subdomain 只给出前缀，
 * 真正的主机名还要拼服务器的 subDomainHost（未知时按前缀匹配即可）。 */
function proxyPublishesDomain(proxy, domain) {
  if (!proxy || !domain) return false;
  const want = String(domain).toLowerCase().replace(/^\*\./, '').trim();
  if (!want) return false;
  if (!['http', 'https', 'tcpmux'].includes(proxy.type)) return false;
  const exact = (proxy.customDomains || [])
    .map((x) => String(x).toLowerCase().replace(/^\*\./, '').trim())
    .filter(Boolean);
  /* customDomains 是完整主机名：只认精确相等（或用它的通配符覆盖子域） */
  if (exact.some((x) => x === want || want.endsWith(`.${x}`))) return true;
  /* subdomain 只是前缀：'demo' 发布的是 demo.<subDomainHost>，host 未知时按前缀判 */
  const sub = String(proxy.subdomain || '').toLowerCase().trim();
  return !!sub && (sub === want || want.startsWith(`${sub}.`) || sub.startsWith(`${want}.`));
}

/* 这份 frpc 配置（config.js 的模型）里有没有代理在发布这个域名 */
function ownsDomain(model, domain) {
  if (!model || !Array.isArray(model.proxies)) return false;
  return model.proxies.some((p) => proxyPublishesDomain(p, domain));
}

/* nginx 反代的上游端口：http/https/tcpmux 走 frps 的 vhost 端口，
 * tcp 代理（例如用户把 jellyfin 直接发布成 tcp 26296）就该指向那个远程端口——
 * 否则 nginx 把 443 的流量推给 frps 的 8080，frps 上没有对应域名路由，稳定回 404。
 * 真机取证：广州两台域名都是 tcp 类型，写死 8080 时 https 一直 404。 */
function upstreamPortForDomain(proxies, domain, fallbackPort) {
  const want = String(domain || '').trim().toLowerCase();
  const list = Array.isArray(proxies) ? proxies : [];
  /* 只认「在配置里真的用这个域名发布的代理」（http/https/subdomain）。
   * tcp 代理没有域名字段——用户把站点发布成 tcp 26000 还是 26296，配置里看不出来，
   * 猜错就会把 443 的流量推到一个错的端口（真机上是稳定 404）。
   * 这种域名一律退回 fallback，并由调用方给用户一句明确的提示。 */
  const hit = want ? list.find((p) => proxyPublishesDomain(p, want)) : null;
  if (!hit) return Number(fallbackPort) || 0;
  return Number(fallbackPort) || 0;
}

/* 配置里有没有代理用这个域名发布过（没有的话 nginx 反代到 vhost 端口一定 404）。 */
function publishProxyForDomain(proxies, domain) {
  const want = String(domain || '').trim().toLowerCase();
  const list = Array.isArray(proxies) ? proxies : [];
  if (!want) return null;
  return list.find((p) => proxyPublishesDomain(p, want)) || null;
}

/* 托盘文案：必须反映「所有连接」，不能只看当前这一条。
 * 当前连接停了、另外几条在跑时，若托盘仍写「隧道未运行」，用户会以为整个程序挂了。
 * others 由调用方算好（不含当前连接）：{ running: 已连上的条数, total: 全部条数 }。 */
function traySummary(runtime, others = {}) {
  const rt = runtime || {};
  const otherRunning = Math.max(0, Number(others.running) || 0);
  const total = Math.max(1, Number(others.total) || 1);
  const currentOk = !!rt.loggedIn;
  if (rt.loginFailed || rt.connectFailed) {
    return otherRunning > 0
      ? { label: `连不上服务器（另有 ${otherRunning} 条在线）`, tip: `当前连接连不上；另有 ${otherRunning} 条连接在线`, tone: 'error' }
      : { label: '连不上服务器', tip: '连不上服务器', tone: 'error' };
  }
  if (currentOk) {
    return otherRunning > 0
      ? { label: `隧道在线（共 ${otherRunning + 1} 条）`, tip: `当前连接在线；另有 ${otherRunning} 条连接在线`, tone: 'online' }
      : { label: '隧道在线', tip: '已连接', tone: 'online' };
  }
  if (rt.mode === 'starting' || rt.pending) return { label: '正在连接', tip: '正在连接服务器', tone: 'idle' };
  if (otherRunning > 0) {
    return total > 1
      ? { label: `当前连接未运行（另有 ${otherRunning} 条在线）`, tip: `当前这条连接没在跑；另外 ${otherRunning} 条连接在线`, tone: 'online' }
      : { label: `隧道在线（共 ${otherRunning} 条）`, tip: `${otherRunning} 条连接在线`, tone: 'online' };
  }
  if (rt.running) return { label: '隧道运行中（未登录）', tip: '隧道进程在跑，但还没登录上 frps', tone: 'idle' };
  return { label: '隧道未运行', tip: '未连接', tone: 'idle' };
}

module.exports = {
  backfillConnectionHosts,
  traySummary,
  upstreamPortForDomain,
  publishProxyForDomain,
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
  proxyPublishesDomain,
  ownsDomain,
};
