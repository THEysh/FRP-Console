'use strict';

const fs = require('node:fs');
const path = require('node:path');
const toml = require('smol-toml');

const PROXY_TYPES = ['tcp', 'udp', 'http', 'https', 'stcp', 'sudp', 'xtcp', 'tcpmux'];
const HOST_TYPES = ['tcp', 'udp'];

const KNOWN_TOP_LEVEL = new Set([
  'serverAddr', 'serverPort', 'loginFailExit', 'auth', 'log', 'webServer', 'transport', 'proxies', 'visitors',
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}

function toInt(value, fallback = null) {
  if (value === '' || value === null || value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function normalizeAuth(raw) {
  const auth = isPlainObject(raw) ? raw : {};
  return {
    ...auth,
    method: typeof auth.method === 'string' && auth.method ? auth.method : 'token',
    token: typeof auth.token === 'string' ? auth.token : '',
  };
}

function normalizeLog(raw) {
  const log = isPlainObject(raw) ? raw : {};
  return {
    ...log,
    to: typeof log.to === 'string' && log.to ? log.to : './frpc.log',
    level: typeof log.level === 'string' && log.level ? log.level : 'info',
    maxDays: toInt(log.maxDays, 1) ?? 1,
  };
}

function normalizeWebServer(raw) {
  if (!isPlainObject(raw)) return null;
  return {
    ...raw,
    addr: typeof raw.addr === 'string' && raw.addr ? raw.addr : '127.0.0.1',
    port: toInt(raw.port, 7400) ?? 7400,
    user: typeof raw.user === 'string' ? raw.user : '',
    password: typeof raw.password === 'string' ? raw.password : '',
  };
}

function normalizeProxy(raw) {
  const proxy = isPlainObject(raw) ? { ...raw } : {};
  proxy.name = typeof proxy.name === 'string' ? proxy.name.trim() : '';
  proxy.type = typeof proxy.type === 'string' && proxy.type ? proxy.type.trim().toLowerCase() : 'tcp';
  proxy.localIP = typeof proxy.localIP === 'string' && proxy.localIP ? proxy.localIP : '127.0.0.1';
  proxy.localPort = toInt(proxy.localPort, null);
  if (proxy.remotePort !== undefined) proxy.remotePort = toInt(proxy.remotePort, null);
  if (Array.isArray(proxy.customDomains)) proxy.customDomains = proxy.customDomains.map(String).filter(Boolean);
  if (Array.isArray(proxy.locations)) proxy.locations = proxy.locations.map(String).filter(Boolean);
  if (isPlainObject(proxy.transport)) {
    proxy.transport = { ...proxy.transport };
    for (const key of ['useCompression', 'useEncryption', 'proxyProtocolVersion']) {
      if (proxy.transport[key] !== undefined) proxy.transport[key] = proxy.transport[key] === true || String(proxy.transport[key]) === 'true';
    }
  }
  return proxy;
}

function normalize(raw) {
  const src = isPlainObject(raw) ? raw : {};
  const extras = {};
  for (const [key, value] of Object.entries(src)) {
    if (!KNOWN_TOP_LEVEL.has(key)) extras[key] = value;
  }
  const model = {
    serverAddr: typeof src.serverAddr === 'string' ? src.serverAddr.trim() : '',
    serverPort: toInt(src.serverPort, 7000) ?? 7000,
    loginFailExit: src.loginFailExit !== false,
    auth: normalizeAuth(src.auth),
    log: normalizeLog(src.log),
    webServer: normalizeWebServer(src.webServer),
    transport: isPlainObject(src.transport) ? { ...src.transport } : null,
    proxies: Array.isArray(src.proxies) ? src.proxies.map(normalizeProxy) : [],
    visitors: Array.isArray(src.visitors) ? src.visitors.map((v) => (isPlainObject(v) ? { ...v } : v)) : [],
    _extra: extras,
  };
  return model;
}

function parseConfigText(text) {
  return normalize(toml.parse(text));
}

function readConfig(configPath) {
  const text = fs.readFileSync(configPath, 'utf8');
  const model = parseConfigText(text);
  model._sourceText = text;
  return model;
}

function validate(model) {
  const errors = [];
  const warnings = [];
  const push = (level, field, message) => (level === 'error' ? errors : warnings).push({ field, message });

  if (!model.serverAddr) push('error', 'serverAddr', '服务器地址不能为空');
  else if (!/^[A-Za-z0-9.-]+$/.test(model.serverAddr) && !/^\d{1,3}(\.[\d]{1,3}){3}$/.test(model.serverAddr)) {
    push('warn', 'serverAddr', '服务器地址看起来不是常见的主机名或 IP');
  }
  if (!Number.isInteger(model.serverPort) || model.serverPort < 1 || model.serverPort > 65535) {
    push('error', 'serverPort', '服务器端口必须在 1 - 65535 之间');
  }
  if (!model.auth.token) push('warn', 'auth.token', 'auth.token 为空；如果服务器未启用 token 校验可以忽略');

  const names = new Map();
  const remotePorts = new Map();
  for (const [index, proxy] of model.proxies.entries()) {
    const label = proxy.name || `第 ${index + 1} 个代理`;
    if (!proxy.name) {
      push('error', `proxies[${index}].name`, '代理名称不能为空');
    } else {
      if (/\s|[[\]]/.test(proxy.name)) push('error', `proxies[${index}].name`, `代理名称「${proxy.name}」不能包含空格或方括号`);
      if (names.has(proxy.name)) push('error', `proxies[${index}].name`, `代理名称「${proxy.name}」与「${names.get(proxy.name)}」重复`);
      else names.set(proxy.name, label);
    }

    if (!PROXY_TYPES.includes(proxy.type)) {
      push('error', `proxies[${index}].type`, `不支持的代理类型「${proxy.type}」`);
    }

    if (!HOST_TYPES.includes(proxy.type) && proxy.type !== 'tcpmux') {
      // http/https/stcp/sudp/xtcp 均不使用 localIP/localPort 以外的远程端口
    }

    if (!proxy.plugin) {
      if (!Number.isInteger(proxy.localPort) || proxy.localPort < 1 || proxy.localPort > 65535) {
        push('error', `proxies[${index}].localPort`, `${label} 的本地端口无效`);
      }
      if (!proxy.localIP) push('warn', `proxies[${index}].localIP`, `${label} 未设置 localIP，默认使用 127.0.0.1`);
    }

    if (HOST_TYPES.includes(proxy.type)) {
      if (!Number.isInteger(proxy.remotePort) || proxy.remotePort < 1 || proxy.remotePort > 65535) {
        push('error', `proxies[${index}].remotePort`, `${label} 需要 1 - 65535 的公网端口`);
      } else if (proxy.remotePort === model.serverPort) {
        push('warn', `proxies[${index}].remotePort`, `${label} 的公网端口与服务器端口相同，可能冲突`);
      } else {
        const key = `${proxy.type}:${proxy.remotePort}`;
        if (remotePorts.has(key)) push('error', `proxies[${index}].remotePort`, `${label} 的公网端口 ${proxy.remotePort} 与「${remotePorts.get(key)}」重复`);
        else remotePorts.set(key, label);
      }
    }

    if (['http', 'https'].includes(proxy.type)) {
      const hasDomains = Array.isArray(proxy.customDomains) && proxy.customDomains.length > 0;
      if (!hasDomains && !proxy.subdomain) {
        push('error', `proxies[${index}].customDomains`, `${label} 需要至少一个自定义域名或 subdomain`);
      }
    }

    if (['stcp', 'sudp', 'xtcp'].includes(proxy.type) && !proxy.secretKey) {
      push('warn', `proxies[${index}].secretKey`, `${label} 建议设置 secretKey`);
    }
  }

  if (model.webServer) {
    if (model.webServer.addr && model.webServer.addr !== '127.0.0.1' && model.webServer.addr !== 'localhost') {
      push('warn', 'webServer.addr', '管理 API 建议只监听 127.0.0.1，避免暴露到局域网');
    }
    if (!Number.isInteger(model.webServer.port) || model.webServer.port < 1 || model.webServer.port > 65535) {
      push('error', 'webServer.port', '管理 API 端口无效');
    }
  }

  return { errors, warnings };
}

function inlineValue(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(inlineValue).join(', ')}]`;
  if (isPlainObject(value)) return null;
  return null;
}

function emitDotted(obj, prefix, lines, skip = new Set()) {
  for (const [key, value] of Object.entries(obj || {})) {
    if (skip.has(key)) continue;
    const full = prefix ? `${prefix}.${key}` : key;
    if (value === null || value === undefined) continue;
    if (isPlainObject(value)) {
      emitDotted(value, full, lines);
    } else if (Array.isArray(value) && value.every((item) => isPlainObject(item))) {
      // 表格数组不支持点号嵌套，由调用方单独处理
      continue;
    } else {
      const inline = inlineValue(value);
      if (inline !== null) lines.push(`${full} = ${inline}`);
    }
  }
}

const PROXY_ORDER = ['name', 'type', 'localIP', 'localPort', 'remotePort', 'customDomains', 'subdomain', 'locations', 'secretKey', 'serverName', 'allowUsers', 'plugin'];
const TRANSPORT_ORDER = ['useCompression', 'useEncryption', 'bandwidthLimit', 'bandwidthLimitMode', 'proxyProtocolVersion', 'dialServerTimeout', 'dialServerKeepalive'];

function proxyLines(proxy) {
  const lines = [];
  const skip = new Set();
  const ordered = new Set(PROXY_ORDER);
  for (const key of PROXY_ORDER) {
    if (!Object.prototype.hasOwnProperty.call(proxy, key) || proxy[key] === undefined || proxy[key] === null || proxy[key] === '') continue;
    if (isPlainObject(proxy[key])) continue;
    const inline = inlineValue(proxy[key]);
    if (inline !== null) lines.push(`${key} = ${inline}`);
    skip.add(key);
  }

  const transport = isPlainObject(proxy.transport) ? proxy.transport : null;
  if (transport) {
    const known = new Set(TRANSPORT_ORDER);
    for (const key of TRANSPORT_ORDER) {
      if (transport[key] === undefined) continue;
      const inline = inlineValue(transport[key]);
      if (inline !== null) lines.push(`transport.${key} = ${inline}`);
    }
    for (const [key, value] of Object.entries(transport)) {
      if (known.has(key) || value === undefined) continue;
      const inline = inlineValue(value);
      if (inline !== null) lines.push(`transport.${key} = ${inline}`);
    }
    skip.add('transport');
  }

  for (const [key, value] of Object.entries(proxy)) {
    if (skip.has(key) || key === 'transport' || key.startsWith('_')) continue;
    if (value === null || value === undefined) continue;
    if (isPlainObject(value)) {
      emitDotted(value, key, lines);
    } else if (Array.isArray(value) && value.every((item) => isPlainObject(item))) {
      // 代理内部表格数组（如 plugin.visitor）罕见，保持原样忽略
    } else {
      const inline = inlineValue(value);
      if (inline !== null) lines.push(`${key} = ${inline}`);
    }
  }
  return lines;
}

function serialize(model) {
  const lines = [];
  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  lines.push('# ============================================================');
  lines.push('# FRP 客户端配置 · 由「FRP 控制台」管理');
  lines.push(`# 最近保存：${stamp}`);
  lines.push('# ============================================================');
  lines.push('');
  lines.push(`serverAddr = ${inlineValue(model.serverAddr)}`);
  lines.push(`serverPort = ${inlineValue(model.serverPort)}`);
  lines.push(`loginFailExit = ${model.loginFailExit ? 'true' : 'false'}`);
  lines.push('');

  if (isPlainObject(model.transport)) {
    lines.push('# 传输配置');
    emitDotted(model.transport, 'transport', lines);
    lines.push('');
  }

  lines.push('# 认证配置');
  emitDotted(model.auth, 'auth', lines);
  lines.push('');

  lines.push('# 日志配置');
  emitDotted(model.log, 'log', lines);
  lines.push('');

  if (model.webServer) {
    lines.push('# 客户端管理 API（仅本机访问，供 FRP 控制台热重载与状态查询）');
    emitDotted(model.webServer, 'webServer', lines);
    lines.push('');
  }

  if (isPlainObject(model._extra)) {
    const extras = { ...model._extra };
    const tableArrays = [];
    for (const [key, value] of Object.entries(extras)) {
      if (Array.isArray(value) && value.every((item) => isPlainObject(item))) {
        tableArrays.push([key, value]);
        continue;
      }
      if (isPlainObject(value)) {
        emitDotted(value, key, lines);
      } else if (value !== undefined) {
        const inline = inlineValue(value);
        if (inline !== null) lines.push(`${key} = ${inline}`);
      }
    }
    if (lines[lines.length - 1] !== '') lines.push('');
    for (const [key, value] of tableArrays) {
      for (const item of value) {
        lines.push(`[[${key}]]`);
        emitDotted(item, '', lines);
        lines.push('');
      }
    }
  }

  for (const proxy of model.proxies) {
    lines.push('# ------------------------------------------------------------');
    lines.push(`# 代理：${proxy.name || '(未命名)'}`);
    lines.push('# ------------------------------------------------------------');
    lines.push('[[proxies]]');
    lines.push(...proxyLines(proxy));
    lines.push('');
  }

  for (const visitor of model.visitors) {
    lines.push('[[visitors]]');
    if (isPlainObject(visitor)) emitDotted(visitor, '', lines);
    lines.push('');
  }

  return lines.join('\n').replace(/\n+$/, '\n');
}

function backupConfig(configPath) {
  try {
    if (!fs.existsSync(configPath)) return null;
    const dir = path.join(path.dirname(configPath), 'frp-console-backups');
    fs.mkdirSync(dir, { recursive: true });
    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    const base = path.basename(configPath, path.extname(configPath));
    const target = path.join(dir, `${base}-${stamp}.toml`);
    fs.copyFileSync(configPath, target);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.toml')).map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const item of files.slice(30)) {
      try { fs.unlinkSync(path.join(dir, item.f)); } catch { /* ignore */ }
    }
    return target;
  } catch {
    return null;
  }
}

function writeConfig(configPath, model) {
  const text = serialize(model);
  const previous = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : null;
  if (previous === text) return { changed: false, backup: null, text };
  const backup = previous ? backupConfig(configPath) : null;
  const tmp = `${configPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, configPath);
  return { changed: true, backup, text };
}

function ensureAdmin(model, { port = 7400, user = 'admin', password = 'admin' } = {}) {
  const current = model.webServer;
  if (current && current.addr === '127.0.0.1' && Number(current.port) === Number(port) && current.user === user && current.password === password) {
    return false;
  }
  model.webServer = { ...(current || {}), addr: '127.0.0.1', port: Number(port), user, password };
  return true;
}

function suggestRemotePort(model, type = 'tcp') {
  if (!HOST_TYPES.includes(type) && type !== 'tcpmux') return null;
  const used = new Set();
  for (const proxy of model.proxies) {
    if (proxy.remotePort) used.add(Number(proxy.remotePort));
  }
  used.add(Number(model.serverPort));
  let port = 10000;
  while (port < 65000 && used.has(port)) port += 1;
  return port;
}

function publicAddressFor(model, proxy) {
  if (!model.serverAddr) return '';
  if (HOST_TYPES.includes(proxy.type)) {
    return proxy.remotePort ? `${model.serverAddr}:${proxy.remotePort}` : '';
  }
  if (proxy.type === 'http' || proxy.type === 'https') {
    const domain = Array.isArray(proxy.customDomains) && proxy.customDomains.length ? proxy.customDomains[0] : proxy.subdomain || '';
    if (!domain) return '';
    return `${proxy.type}://${domain}`;
  }
  return '';
}

function makeProxy(input) {
  const type = String(input.type || 'tcp').toLowerCase();
  const base = {
    name: String(input.name || '').trim(),
    type,
    localIP: String(input.localIP || '127.0.0.1').trim() || '127.0.0.1',
    localPort: toInt(input.localPort, null),
  };
  if (HOST_TYPES.includes(type) || type === 'tcpmux') base.remotePort = toInt(input.remotePort, null);
  if (type === 'http' || type === 'https') {
    const domains = Array.isArray(input.customDomains)
      ? input.customDomains
      : String(input.customDomains || '').split(/[,，\s]+/);
    const cleaned = domains.map((d) => String(d).trim()).filter(Boolean);
    if (cleaned.length) base.customDomains = cleaned;
    if (input.subdomain) base.subdomain = String(input.subdomain).trim();
    if (cleaned.length === 0 && !base.subdomain) {
      // 留空由校验提示
    }
  }
  if (input.secretKey) base.secretKey = String(input.secretKey);
  const transport = {};
  if (input.useCompression) transport.useCompression = true;
  if (input.useEncryption) transport.useEncryption = true;
  if (input.bandwidthLimit) transport.bandwidthLimit = String(input.bandwidthLimit).trim();
  if (input.bandwidthLimitMode) transport.bandwidthLimitMode = String(input.bandwidthLimitMode).trim();
  if (Object.keys(transport).length) base.transport = transport;
  return base;
}

module.exports = {
  PROXY_TYPES,
  HOST_TYPES,
  parseConfigText,
  readConfig,
  normalize,
  validate,
  serialize,
  writeConfig,
  backupConfig,
  ensureAdmin,
  suggestRemotePort,
  publicAddressFor,
  makeProxy,
};
