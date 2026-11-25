'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { app, safeStorage } = require('electron');
const { readJson, writeJsonAtomic, ensureDir } = require('./util');
const connections = require('./connections');

const DEFAULT_SETTINGS = {
  version: 2,
  frpcPath: '',
  configPath: '',
  frpsDashboardUrl: '',
  serviceName: 'frpc',
  serviceAutoDetect: true,
  runMode: 'auto',
  adminPort: 7400,
  adminUser: 'admin',
  // 留空表示“还没生成”，首次启动会换成一串随机密码（见 index.js）。
  // 以前这里写死 admin/admin：本机任何进程都能用这组口令读 /api/config，
  // 而那份响应里带着 frps 的 auth.token 明文。
  adminPassword: '',
  // frps 侧的 vhost 端口。客户端没有别的办法知道它，只能由用户填；
  // 拼公网地址和做连通性检查都要用（不填就是 80/443）。
  vhostHttpPort: 80,
  vhostHttpsPort: 443,
  // 方案 Y：服务器上已由 nginx 在 443 终止 TLS 并反代到 frps 的 vhostHTTPPort，
  // 此时 http/https 代理的公网地址统一是 https://域名（不带端口）。
  nginxProxyEnabled: false,
  // Let's Encrypt / HTTPS 证书：只签生产证书。
  // dnsProvider 为空表示还没配 DNS 验证渠道（cloudflare 或 manual）。
  acmeEmail: '',
  dnsProvider: '',
  autoReload: true,
  /* 隧道断了（frpc 进程退出 / 管理 API 卡死 / 睡眠唤醒后假死）时自动重连。
   * 第一次 1 秒后重试，逐步退避；第 10 次之后改成每 5 分钟一次，直到成功或用户停手。 */
  autoReconnect: true,
  pollIntervalMs: 3000,
  // 默认不把系统 HTTP_PROXY 传给 frpc：frp 会拿它去代理 TCP 握手，多半被网关 502 拒掉。
  stripProxyEnv: true,
  closeToTray: true,
  startMinimized: false,
  launchTunnelOnStart: false,
  // 登录 Windows 后自动启动控制台（写 HKCU 的 Run 项，不需要管理员权限）。
  launchAtLogin: false,
  logBuffer: 600,
  // 首启生成过模板配置就置 true：用户之后手动删掉它，也不该再冒出来。
  starterConfigCreated: false,
  // 统一模型：所有 frps 服务器都是档案；activeServerId 是当前查看的档案，
  // clientServerId 是本机 frpc.toml 当前实际指向的档案。
  servers: [],
  activeServerId: '',
  clientServerId: '',
  /* 多连接：每条 = 一个 frpc 进程 + 一份 frpc.toml + 一个管理端口。
   * 老用户第一次升级时会被迁移成一条（id=c-default），行为与升级前完全一致。
   * 详见 src/main/connections.js 头部的不变量说明。 */
  connections: [],
  activeConnectionId: '',
  /* 代理的「访问路径」：很多服务（Go 写的面板、Jellyfin 的反代前置等）根路径直接 404，
   * 真正入口在 /panel/ 这类子路径上。frpc 不认这个字段（未知字段会让整份配置 unmarshal 失败），
   * 所以存在我们自己这边，按代理名索引，只用于生成链接与健康检查探测。 */
  proxyOpenPaths: {},
};

function newServerId() {
  return `srv-${crypto.randomUUID()}`;
}

function normalizeServerProfile(input = {}) {
  const host = String(input.host || '').trim();
  const port = Number(input.port) || 22;
  const clampPort = (n) => { const v = Number(n) || 0; return Number.isInteger(v) && v > 0 && v < 65536 ? v : 0; };
  return {
    id: String(input.id || '').trim() || newServerId(),
    name: String(input.name || '').trim() || host || '新服务器',
    host,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 22,
    username: String(input.username || 'root').trim() || 'root',
    clientPort: Math.min(65535, Math.max(1, Number(input.clientPort) || 7000)),
    clientToken: String(input.clientToken || ''),
    configPath: String(input.configPath || ''),
    serviceName: String(input.serviceName || 'frps'),
    dashboardUrl: String(input.dashboardUrl || ''),
    // 方案 Y 是「这台服务器」的事实（它上面配没配 nginx 反代），跟着档案走。
    // 以前存成全局开关：多服务器用户切档案后会被上一台的状态污染
    //（比如 lab 无 nginx，http 代理却按 https://域名 显示和探测）。
    nginxProxyEnabled: !!input.nginxProxyEnabled,
    // frps 的 vhost 端口同样是「这台服务器」的事实，跟着档案走（0 = 还没读到过）。
    // 以前只存全局 settings.vhostHttpPort：连了 A（8080）再切回 B（28080），
    // B 的 http 代理会按 A 的端口显示和探测，甚至探测到本机同端口的无关服务（假绿）。
    vhostHttpPort: clampPort(input.vhostHttpPort),
    vhostHttpsPort: clampPort(input.vhostHttpsPort),
    createdAt: Number(input.createdAt) || Date.now(),
    lastConnectedAt: Number(input.lastConnectedAt) || 0,
  };
}

function normalizeServers(list) {
  const seen = new Set();
  const result = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || typeof item !== 'object') continue;
    const profile = normalizeServerProfile(item);
    if (seen.has(profile.id)) profile.id = newServerId();
    seen.add(profile.id);
    result.push(profile);
  }
  return result;
}

/* 服务器档案的身份 = 「哪台机器」= host + SSH 端口。
 * username 只是登录属性，同一台机器换账号不该多出一条档案。
 * host 归一：去空格、转小写、去掉结尾的根域点（example.com. 与 example.com 是同一台）。 */
function serverProfileKey(profile = {}) {
  const host = String(profile.host || '').trim().toLowerCase().replace(/\.+$/, '');
  const port = Number(profile.port) || 22;
  return host ? `${host}:${port}` : '';
}

/* 把「同一台机器」的多条档案合并成一条。返回 { servers, merged }，
 * merged 里记录每个键被并掉的 id 列表与保留的 id，供调用方迁移密码与绑定关系。 */
function mergeDuplicateServers(list) {
  const groups = new Map();
  const keyless = [];
  for (const profile of Array.isArray(list) ? list : []) {
    const key = serverProfileKey(profile);
    if (!key) {
      /* 没有地址的档案（半截新建、或用户清空了 host）不参与合并，也不能丢。 */
      keyless.push(profile);
      continue;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(profile);
  }
  const merged = [];
  const out = [...keyless];
  for (const [key, items] of groups) {
    if (items.length === 1) {
      out.push(items[0]);
      continue;
    }
    /* 保留哪一条：最近连接过的优先，其次 created 最早的（历史更长、地址更可信）。 */
    const sorted = [...items].sort((a, b) => {
      const at = Number(a.lastConnectedAt) || 0;
      const bt = Number(b.lastConnectedAt) || 0;
      if (at !== bt) return bt - at;
      return (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0);
    });
    const keep = { ...sorted[0] };
    const ts = (v) => (Number(v) > 0 ? Number(v) : 0);
    for (const other of sorted.slice(1)) {
      /* 合并规则：保留项为空时才用别人的值；时间字段取极值。
       * 服务器事实（nginx 反代、vhost 端口）跟着保留项走——它代表最近一次连上时的结论。 */
      for (const field of ['clientToken', 'configPath', 'dashboardUrl', 'serviceName', 'frpcPath']) {
        if (!keep[field] && other[field]) keep[field] = other[field];
      }
      if (!keep.clientPort && other.clientPort) keep.clientPort = other.clientPort;
      const created = [ts(keep.createdAt), ts(other.createdAt)].filter(Boolean);
      keep.createdAt = created.length ? Math.min(...created) : Date.now();
      keep.lastConnectedAt = Math.max(ts(keep.lastConnectedAt), ts(other.lastConnectedAt));
    }
    out.push(keep);
    merged.push({ key, keepId: keep.id, dropped: sorted.slice(1).map((item) => item.id) });
  }
  return { servers: out, merged };
}

let cached = null;
/* 多连接迁移是否还没落盘（load() 只改内存，见 persistMigration）。 */
let migrationPending = false;
// v1 的 settings.server.host 只在首次载入时存在，单独记一份，
// 避免 save() 之后丢掉线索导致单密码永远无法迁移。
let legacyHostMemo = '';

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function dataDir() {
  return app.getPath('userData');
}

/* 标量字段的容错收敛。
 *
 * 保存路径（index.js 的 settings:save）一直在夹取值，但 **load 从来没有**：
 * 于是「升级途中断电写坏了半截 JSON」「用户手工编辑过」「老版本允许存进来的怪值」
 * 会原样进入运行期，最典型的是设置页那个数字输入框显示成 `abc`，
 * 或者 runMode 既不是 auto 也不是 managed（两个单选都不亮，用户只能猜）。
 * 这里把每个标量按 DEFAULT_SETTINGS 的类型与文档区间收一遍；
 * 类型对、值合法的一律原样保留（布尔仍然只有 true/false，不影响 `!== false` 这类判断）。
 */
const BOOL_KEYS = [
  'serviceAutoDetect',
  'nginxProxyEnabled',
  'autoReload',
  'autoReconnect',
  'stripProxyEnv',
  'closeToTray',
  'startMinimized',
  'launchTunnelOnStart',
  'launchAtLogin',
  'starterConfigCreated',
];
const STRING_KEYS = ['frpcPath', 'configPath', 'logPath', 'frpsDashboardUrl', 'serviceName', 'adminUser', 'adminPassword', 'acmeEmail', 'dnsProvider'];
const PORT_KEYS = ['adminPort', 'vhostHttpPort', 'vhostHttpsPort'];

/* 已经删掉的功能留下的字段（1.2.38 去掉 STAGING、1.2.83 去掉「停止服务前确认」）。 */
const OBSOLETE_KEYS = ['acmeStaging', 'confirmStopService'];

function sanitizeSettings(input) {
  const out = { ...input };
  for (const key of BOOL_KEYS) {
    if (typeof out[key] !== 'boolean') out[key] = DEFAULT_SETTINGS[key];
  }
  for (const key of STRING_KEYS) {
    if (key === 'logPath' && out[key] === undefined) continue; // logPath 可以不存在（由配置推导）
    if (typeof out[key] !== 'string') out[key] = DEFAULT_SETTINGS[key] || '';
  }
  out.runMode = out.runMode === 'managed' ? 'managed' : 'auto';
  for (const key of PORT_KEYS) {
    const n = Math.floor(Number(out[key]));
    const min = key === 'adminPort' ? 1 : 0; // vhost 端口 0 表示“没填”
    out[key] = Number.isFinite(n) && n >= min && n <= 65535 ? n : DEFAULT_SETTINGS[key];
  }
  const poll = Math.floor(Number(out.pollIntervalMs));
  out.pollIntervalMs = Number.isFinite(poll) && poll >= 1000 && poll <= 30000 ? poll : DEFAULT_SETTINGS.pollIntervalMs;
  const buffer = Math.floor(Number(out.logBuffer));
  out.logBuffer = Number.isFinite(buffer) && buffer >= 100 && buffer <= 2000 ? buffer : DEFAULT_SETTINGS.logBuffer;
  out.certDirs = Array.isArray(out.certDirs)
    ? out.certDirs.filter((item) => typeof item === 'string' && item.trim()).slice(0, 8)
    : [];
  if (!out.proxyOpenPaths || typeof out.proxyOpenPaths !== 'object' || Array.isArray(out.proxyOpenPaths)) out.proxyOpenPaths = {};
  /* 连接列表只做「形状」收敛：真正的迁移（造第一条、端口去重、id 去重）在
   * migrateConnections 里做，避免这里生成随机 id 导致每次 load 都“有变化”。 */
  out.connections = Array.isArray(out.connections)
    ? out.connections.filter((item) => item && typeof item === 'object').slice(0, connections.MAX_CONNECTIONS)
    : [];
  out.activeConnectionId = typeof out.activeConnectionId === 'string' ? out.activeConnectionId : '';
  for (const key of OBSOLETE_KEYS) delete out[key];
  return out;
}

function load() {
  if (cached) return cached;  const raw = readJson(settingsFile(), {});
  const base = raw && typeof raw === 'object' ? raw : {};
  const servers = normalizeServers(base.servers);
  // v1 迁移：旧的 settings.server 是唯一的一份 SSH 连接信息，升级成第一个档案。
  if (!servers.length && base.server && typeof base.server === 'object' && String(base.server.host || '').trim()) {
    servers.push(normalizeServerProfile({
      name: String(base.server.host || '').trim(),
      host: base.server.host,
      port: base.server.port,
      username: base.server.username,
    }));
  }
  let activeServerId = String(base.activeServerId || '');
  if (!servers.some((item) => item.id === activeServerId)) activeServerId = '';
  let clientServerId = String(base.clientServerId || '');
  if (!servers.some((item) => item.id === clientServerId)) clientServerId = '';
  // 迁移：老版本把 nginxProxyEnabled 存成全局开关。它其实是「某台服务器」的事实。
  // 这个 true 只会在「连服务器页检测到 nginx 反代」时被置位（旧代码是全局覆盖写），
  // 也就是说：全局为 true ⇒ 最后一次连接的那台服务器配了 nginx（连到没配的会把
  // 它覆盖回 false）。所以归属按 lastConnectedAt 最新优先；activeServerId 会被
  // serverApply 切换隧道目标改写、clientServerId 是绑定关系，都可能指向别的机器，
  // 只作兜底。seed 错档案会让那台机器的 http 代理被错误按「已配 nginx」处理
  // （公网地址/探测全走错）。
  if (base.nginxProxyEnabled && servers.length && !servers.some((item) => item.nginxProxyEnabled)) {
    const byRecent = [...servers].sort((a, b) => (b.lastConnectedAt || 0) - (a.lastConnectedAt || 0));
    const target = byRecent.find((item) => item.lastConnectedAt)
      || servers.find((item) => item.id === activeServerId)
      || servers.find((item) => item.id === clientServerId)
      || servers[0];
    target.nginxProxyEnabled = true;
  }
  // 迁移：老版本只把 vhost 端口存成全局 settings.vhostHttpPort/vhostHttpsPort。它跟
  // nginxProxyEnabled 一样是「最后一次连过的服务器」的事实，归属按同样的规则 seed 进
  // 档案；全局值保留，作为「隧道没绑定任何档案」时的兜底。
  if (servers.length && !servers.some((item) => item.vhostHttpPort || item.vhostHttpsPort)) {
    const gHttp = Number(base.vhostHttpPort) || 0;
    const gHttps = Number(base.vhostHttpsPort) || 0;
    if (gHttp > 0 || gHttps > 0) {
      const byRecent = [...servers].sort((a, b) => (b.lastConnectedAt || 0) - (a.lastConnectedAt || 0));
      const target = byRecent.find((item) => item.lastConnectedAt)
        || servers.find((item) => item.id === activeServerId)
        || servers.find((item) => item.id === clientServerId)
        || servers[0];
      target.vhostHttpPort = gHttp;
      target.vhostHttpsPort = gHttps;
    }
  }
  cached = {
    ...DEFAULT_SETTINGS,
    ...base,
    version: 2,
    servers,
    activeServerId,
    clientServerId,
  };
  /* 标量统一收敛：runMode 只留 auto/managed（老设置的 'service' 在 sanitizeSettings
   * 里已归一到 auto —— 服务模式入口早删了，留着会让「启动隧道」每次先去找系统服务、
   * 报“未检测到 FRP 系统服务”），端口/轮询/缓冲按文档区间夹取，类型不对的布尔与
   * 字符串回到默认值。 */
  cached = sanitizeSettings(cached);
  delete cached.server;
  /* 多连接迁移：老数据（只有顶层 configPath/logPath/adminPort）在这里变成一条连接。
   * 迁移只改内存，落盘交给 persistMigration()——index.js 启动时调用一次，
   * 这样 load() 保持“只读”，单测里不会往磁盘写东西。 */
  const migrated = connections.migrateConnections(cached);
  cached.connections = migrated.connections;
  cached.activeConnectionId = migrated.activeConnectionId;
  /* 1.2.192：连接自己带 SSH 事实。老数据里它只记 serverId，这里按档案把
   * host/port/username 抄过来；抄完才算迁移完（和上一步共用一个 pending 标记）。 */
  const hosts = connections.backfillConnectionHosts(cached.connections, cached.servers);
  cached.connections = hosts.connections;
  migrationPending = migrated.changed || hosts.changed;
  /* 投影：阶段 1 的运行期代码仍然只读顶层这三个字段，所以让它们跟着“当前连接”走。
   * 等到进程层多实例化完成后，这份投影就只用于兼容旧代码，不再是真相。 */
  const activeConn = connections.findConnection(cached.connections, cached.activeConnectionId);
  if (activeConn) {
    cached.configPath = activeConn.configPath || '';
    cached.logPath = activeConn.logPath || '';
    cached.adminPort = activeConn.adminPort || DEFAULT_SETTINGS.adminPort;
  }
  legacyHostMemo = String((base.server && base.server.host) || legacyHostMemo || '');
  return cached;
}

/* 迁移是否需要落盘（只在第一次升级时 true）。 */
function persistMigration() {
  load();
  if (!migrationPending) return false;
  migrationPending = false;
  writeJsonAtomic(settingsFile(), cached);
  return true;
}

function legacyServerHost() {
  return legacyHostMemo || (cached && cached.legacyServerHost) || '';
}

function serverSecretFile() {
  return path.join(dataDir(), 'server-secret.json');
}

/*
 * 密码库：{ v: 2, items: { [serverId]: { enc, at } }, legacy?: { enc } }
 * 每台服务器的密码只属于自己的档案槽位，绝不跨档案回退；
 * legacy 是 v1 的单密码，迁移成功后立即删除。
 */
function readSecretStore() {
  const raw = readJson(serverSecretFile(), null);
  if (!raw || typeof raw !== 'object') return { v: 2, items: {}, legacy: null };
  const items = raw.items && typeof raw.items === 'object' ? raw.items : {};
  const legacySource = raw.legacy && raw.legacy.enc ? raw.legacy : raw.enc ? raw : null;
  return { v: 2, items, legacy: legacySource ? { enc: legacySource.enc, at: Number(legacySource.at) || 0 } : null };
}

function writeSecretStore(store) {
  const payload = { v: 2, items: store.items || {} };
  if (store.legacy && store.legacy.enc) payload.legacy = store.legacy;
  writeJsonAtomic(serverSecretFile(), payload);
  return payload;
}

function decrypt(value) {
  try {
    if (!value || !value.enc || !safeStorage.isEncryptionAvailable()) return '';
    return safeStorage.decryptString(Buffer.from(String(value.enc), 'base64'));
  } catch {
    return '';
  }
}

function readServerSecret(serverId = '') {
  const store = readSecretStore();
  const id = String(serverId || '').trim();
  if (id) return decrypt(store.items[id]);
  const first = Object.values(store.items)[0];
  if (first) return decrypt(first);
  return decrypt(store.legacy);
}

/* 连接自己的密码（1.2.193）：同一个密文库，键加 conn: 前缀，
 * 与「服务器档案」的密码互不覆盖（老数据还在档案键下，连接会依次回退）。 */
function connectionSecretKey(connectionId = '') {
  const id = String(connectionId || '').trim();
  return id ? `conn:${id}` : '';
}

function readConnectionSecret(connectionId = '') {
  const key = connectionSecretKey(connectionId);
  if (!key) return '';
  return readServerSecret(key);
}

function hasConnectionSecret(connectionId = '') {
  return !!readConnectionSecret(connectionId);
}

function saveConnectionSecret(connectionId, password) {
  const key = connectionSecretKey(connectionId);
  if (!key) return { ok: false, error: '缺少连接 ID' };
  return saveServerSecret(key, password);
}

function clearConnectionSecret(connectionId = '') {
  const key = connectionSecretKey(connectionId);
  if (!key) return { ok: false, error: '缺少连接 ID' };
  return clearServerSecret(key);
}

function hasServerSecret(serverId = '') {
  return !!readServerSecret(serverId);
}

function hasLegacySecret() {
  return !!decrypt(readSecretStore().legacy);
}

function saveServerSecret(serverId, password) {
  const id = String(serverId || '').trim();
  if (!id) return { ok: false, error: '缺少服务器档案 ID' };
  if (!password) return clearServerSecret(id);
  if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: '当前系统不支持加密存储，未保存密码' };
  try {
    const store = readSecretStore();
    store.items[id] = { enc: safeStorage.encryptString(String(password)).toString('base64'), at: Date.now() };
    writeSecretStore(store);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}

function clearServerSecret(serverId = '') {
  try {
    const store = readSecretStore();
    if (serverId) delete store.items[String(serverId).trim()];
    else store.items = {};
    writeSecretStore(store);
  } catch { /* ignore */ }
  return { ok: true };
}

function migrateLegacySecret(serverId) {
  const store = readSecretStore();
  if (!store.legacy || !serverId) return false;
  const password = decrypt(store.legacy);
  if (!password || !safeStorage.isEncryptionAvailable()) return false;
  try {
    store.items[serverId] = { enc: safeStorage.encryptString(password).toString('base64'), at: Date.now() };
    store.legacy = null; // 迁移完成即销毁单密码，避免出现两份来源
    writeSecretStore(store);
    return true;
  } catch {
    return false;
  }
}

/* DNS 验证凭据库（Cloudflare API token），结构与 server-secret.json 相同，
 * 用 safeStorage（Windows DPAPI）加密，绝不进 settings.json 或日志。 */
function dnsSecretFile() {
  return path.join(dataDir(), 'dns-secret.json');
}

function readDnsSecretStore() {
  const raw = readJson(dnsSecretFile(), null);
  if (!raw || typeof raw !== 'object') return { v: 1, cloudflare: null };
  return { v: 1, cloudflare: raw.cloudflare && raw.cloudflare.enc ? raw.cloudflare : null };
}

function writeDnsSecretStore(store) {
  const payload = { v: 1 };
  if (store.cloudflare && store.cloudflare.enc) payload.cloudflare = store.cloudflare;
  writeJsonAtomic(dnsSecretFile(), payload);
  return payload;
}

function readCloudflareToken() {
  const store = readDnsSecretStore();
  return decrypt(store.cloudflare);
}

function hasCloudflareToken() {
  return !!readCloudflareToken();
}

function saveCloudflareToken(token) {
  if (!token) return clearCloudflareToken();
  if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: '当前系统不支持加密存储，未保存 token' };
  try {
    const store = readDnsSecretStore();
    store.cloudflare = { enc: safeStorage.encryptString(String(token)).toString('base64'), at: Date.now() };
    writeDnsSecretStore(store);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}

function clearCloudflareToken() {
  try {
    const store = readDnsSecretStore();
    store.cloudflare = null;
    writeDnsSecretStore(store);
  } catch { /* ignore */ }
  return { ok: true };
}

function save(patch) {
  cached = sanitizeSettings({ ...load(), ...(patch || {}) });
  cached.version = 2;
  cached.servers = normalizeServers(cached.servers);
  delete cached.server;
  /* 连接列表：切换/新增走 patch.activeConnectionId / patch.connections；
   * 只改 configPath/logPath/adminPort 时，写回“当前连接”，避免两边各说各话。 */
  const incoming = connections.migrateConnections(cached);
  let list = incoming.connections;
  const wantedActive = String((patch && patch.activeConnectionId) || '');
  const switching = !!(wantedActive && wantedActive !== incoming.activeConnectionId
    && list.some((item) => item.id === wantedActive));
  const activeId = switching ? wantedActive : incoming.activeConnectionId;
  if (switching) {
    // 切到另一条：顶层三个字段跟着新的那条走（不要把新连接的路径覆盖成旧的）
    const target = connections.findConnection(list, activeId);
    if (target) {
      cached.configPath = target.configPath || '';
      cached.logPath = target.logPath || '';
      cached.adminPort = target.adminPort || DEFAULT_SETTINGS.adminPort;
    }
  } else {
    const applied = connections.applyLegacyPaths(list, activeId, {
      configPath: cached.configPath,
      logPath: cached.logPath,
      adminPort: cached.adminPort,
    });
    list = applied.connections;
  }
  cached.connections = list;
  cached.activeConnectionId = activeId;
  if (!cached.servers.some((item) => item.id === cached.activeServerId)) {
    // 优先落回“本机隧道绑定”的档案，其次才取第一个，避免当前查看的档案被随机改掉。
    const fallback = cached.servers.find((item) => item.id === cached.clientServerId) || cached.servers[0];
    cached.activeServerId = fallback ? fallback.id : '';
  }
  if (!cached.servers.some((item) => item.id === cached.clientServerId)) cached.clientServerId = '';
  writeJsonAtomic(settingsFile(), cached);
  return cached;
}

function bundledFrpcDir() {
  // 安装包内置的 frpc.exe：electron-builder 的 extraResources 把它放在
  // <安装目录>/resources/frpc/。它永远和安装包同一个版本，优先级高于
  // “用户自己在别处放了一份”的猜测。
  try {
    if (!app.isPackaged) return '';
    return path.join(process.resourcesPath, 'frpc');
  } catch {
    return '';
  }
}

function candidateDirs(settings) {
  const dirs = [];
  const add = (dir) => {
    if (!dir) return;
    const resolved = path.resolve(dir);
    if (!dirs.includes(resolved)) dirs.push(resolved);
  };
  add(bundledFrpcDir());
  add(process.env.PORTABLE_EXECUTABLE_DIR);
  add(path.dirname(process.execPath));
  /* 打包后不再看「当前工作目录」：从资源管理器双击时它等于 exe 目录（上面已加过），
   * 但从终端/快捷方式启动时它可能是任意目录——那里若躺着别人的 frpc.toml，
   * 会被当成「我的配置」直接读进来（连带 serverAddr 与 token）。
   * 开发运行时仍保留，方便 npm start 直接用仓库里的配置。 */
  if (!app.isPackaged) add(process.cwd());
  try {
    add(app.getAppPath());
    add(path.dirname(app.getAppPath()));
    // 开发/解压运行的便利位置：npm run fetch:frpc 会把 frpc.exe 放到这里。
    // 只加这个（内含 exe、不含配置），不加仓库里的 runtime/ —— 那会把开发者
    // 自己正在用的 frpc.toml 连带真实 Token 一起认成“用户配置”。
    add(path.join(app.getAppPath(), 'vendor', 'frpc'));
  } catch {
    /* ignore */
  }
  add(settings && settings.configPath ? path.dirname(settings.configPath) : '');
  add(settings && settings.frpcPath ? path.dirname(settings.frpcPath) : '');
  add(dataDir());
  return dirs;
}

function looksLikeFrpcDir(dir) {
  try {
    return fs.statSync(path.join(dir, 'frpc.exe')).isFile();
  } catch {
    return false;
  }
}

function discoverFrpc(settings) {
  if (settings && settings.frpcPath && fs.existsSync(settings.frpcPath)) {
    return settings.frpcPath;
  }
  for (const dir of candidateDirs(settings)) {
    if (looksLikeFrpcDir(dir)) return path.join(dir, 'frpc.exe');
  }
  return '';
}

function discoverConfig(settings, frpcPath) {
  if (settings && settings.configPath && fs.existsSync(settings.configPath)) {
    return settings.configPath;
  }
  const dirs = [];
  if (frpcPath) dirs.push(path.dirname(frpcPath));
  for (const dir of candidateDirs(settings)) dirs.push(dir);
  for (const dir of dirs) {
    for (const name of ['frpc.toml', 'frpc.yaml', 'frpc.yml', 'frpc.json']) {
      const file = path.join(dir, name);
      try {
        if (fs.statSync(file).isFile()) return file;
      } catch {
        /* ignore */
      }
    }
  }
  return '';
}

async function refreshPaths() {
  const settings = load();
  const frpcPath = discoverFrpc(settings);
  const configPath = discoverConfig(settings, frpcPath);
  const patch = {};
  if (frpcPath && frpcPath !== settings.frpcPath) patch.frpcPath = frpcPath;
  if (configPath && configPath !== settings.configPath) patch.configPath = configPath;
  if (Object.keys(patch).length) save(patch);
  return { frpcPath, configPath };
}

function logPathFromConfig(model, configPath) {
  const raw = model && model.log && typeof model.log.to === 'string' ? model.log.to.trim() : '';
  if (raw) {
    const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
    const filePart = parts.find((p) => p !== 'console' && p !== 'file' && p !== 'none' && p !== '');
    if (filePart) {
      if (path.isAbsolute(filePart)) return filePart;
      return path.resolve(configPath ? path.dirname(configPath) : dataDir(), filePart);
    }
    const explicit = parts.find((p) => p === 'file');
    if (explicit) {
      return path.resolve(configPath ? path.dirname(configPath) : dataDir(), 'frpc.log');
    }
  }
  return path.join(configPath ? path.dirname(configPath) : dataDir(), 'frpc.log');
}

module.exports = {
  DEFAULT_SETTINGS,
  load,
  save,
  refreshPaths,
  discoverFrpc,
  discoverConfig,
  bundledFrpcDir,
  settingsFile,
  dataDir,
  logPathFromConfig,
  ensureDir,
  newServerId,
  normalizeServerProfile,
  sanitizeSettings,
  persistMigration,
  OBSOLETE_KEYS,
  serverProfileKey,
  mergeDuplicateServers,
  readServerSecret,
  hasServerSecret,
  connectionSecretKey,
  readConnectionSecret,
  hasConnectionSecret,
  saveConnectionSecret,
  clearConnectionSecret,
  hasLegacySecret,
  saveServerSecret,
  clearServerSecret,
  migrateLegacySecret,
  serverSecretFile,
  legacyServerHost,
  dnsSecretFile,
  readCloudflareToken,
  hasCloudflareToken,
  saveCloudflareToken,
  clearCloudflareToken,
};
