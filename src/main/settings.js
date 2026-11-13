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
  adminPassword: 'admin',
  autoReload: true,
  pollIntervalMs: 3000,
  // 默认不把系统 HTTP_PROXY 传给 frpc：frp 会拿它去代理 TCP 握手，多半被网关 502 拒掉。
  stripProxyEnv: true,
  closeToTray: true,
  startMinimized: false,
  launchTunnelOnStart: false,
  // 登录 Windows 后自动启动控制台（写 HKCU 的 Run 项，不需要管理员权限）。
  launchAtLogin: false,
  confirmStopService: true,
  logBuffer: 600,
  // 首启生成过模板配置就置 true：用户之后手动删掉它，也不该再冒出来。
  starterConfigCreated: false,
  // 统一模型：所有 frps 服务器都是档案；activeServerId 是当前查看的档案，
  // clientServerId 是本机 frpc.toml 当前实际指向的档案。
  servers: [],
  activeServerId: '',
  clientServerId: '',
};

function newServerId() {
  return `srv-${crypto.randomUUID()}`;
}

function normalizeServerProfile(input = {}) {
  const host = String(input.host || '').trim();
  const port = Number(input.port) || 22;
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
  cached = {
    ...DEFAULT_SETTINGS,
    ...base,
    version: 2,
    servers,
    activeServerId,
    clientServerId,
  };
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
  readServerSecret,
  hasServerSecret,
  hasLegacySecret,
  saveServerSecret,
  clearServerSecret,
  migrateLegacySecret,
  serverSecretFile,
  legacyServerHost,
};
