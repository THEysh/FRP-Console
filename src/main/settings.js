'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { app, safeStorage } = require('electron');
const { readJson, writeJsonAtomic, ensureDir } = require('./util');

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
// v1 的 settings.server.host 只在首次载入时存在，单独记一份，
// 避免 save() 之后丢掉线索导致单密码永远无法迁移。
let legacyHostMemo = '';

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function dataDir() {
  return app.getPath('userData');
}

function load() {
  if (cached) return cached;
  const raw = readJson(settingsFile(), {});
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
  /* Windows 服务模式已经没有入口了（设置页那张卡删了，也没有“装成服务”的按钮），
   * 但老设置里可能还留着 runMode='service'。留着它会让「启动隧道」每次都先去找
   * 系统服务、报“未检测到 FRP 系统服务”，看起来像功能坏了 —— 直接归一到 auto。 */
  if (cached.runMode === 'service') cached.runMode = 'auto';
  delete cached.server;
  legacyHostMemo = String((base.server && base.server.host) || legacyHostMemo || '');
  return cached;
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
  cached = { ...load(), ...(patch || {}) };
  cached.version = 2;
  cached.servers = normalizeServers(cached.servers);
  delete cached.server;
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
  add(process.cwd());
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
  serverProfileKey,
  mergeDuplicateServers,
  readServerSecret,
  hasServerSecret,
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
