'use strict';

const fs = require('node:fs');
const path = require('node:path');
const toml = require('smol-toml');

const PROXY_TYPES = ['tcp', 'udp', 'http', 'https', 'stcp', 'sudp', 'xtcp', 'tcpmux'];
const HOST_TYPES = ['tcp', 'udp'];
// 备份目录里保留多少份（够回退最近十几次改动，又不至于把磁盘占满）
const BACKUP_KEEP = 10;

/* Chrome / Edge 会拒绝访问这些「不安全端口」，报 ERR_UNSAFE_PORT（浏览器在发出请求前就拦截，
 * 即使隧道是通的也打不开）。列表来自 Chromium net/base/port_util.cc 的 kRestrictedPorts。
 * 自动建议公网端口时跳过它们，手动填了也给出 warning，免得用户配好后发现浏览器打不开。 */
const BROWSER_UNSAFE_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161,
  179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563,
  587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061,
  6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080,
]);

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

/* 主机名 / IPv4 的合理性检查。
 * 不联网、不查 DNS，只挡掉明显写错的东西（999.1.1.1、带协议前缀、带空格）。 */
function isHostLike(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(text)) {
    return text.split('.').every((part) => Number(part) <= 255);
  }
  return /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(text);
}

/* 绑定域名：允许 *.example.com 这种通配，但不允许协议、路径、端口、空格。 */
function isDomainLike(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  if (/[\/\\\s:]/.test(text)) return false;
  return /^\*?(?:\.[A-Za-z0-9-]+)*\.[A-Za-z0-9][A-Za-z0-9-]*$|^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+$/.test(text);
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

function normalizeProxy(raw, options = {}) {
  const proxy = isPlainObject(raw) ? { ...raw } : {};
  proxy.name = typeof proxy.name === 'string' ? proxy.name.trim() : '';
  proxy.type = typeof proxy.type === 'string' && proxy.type ? proxy.type.trim().toLowerCase() : 'tcp';
  proxy.localIP = typeof proxy.localIP === 'string' && proxy.localIP ? proxy.localIP : '127.0.0.1';
  proxy.localPort = toInt(proxy.localPort, null);
  // https2http / https2https 只在 https 类型下有效；type=http + 插件是非法组合，
  // 会让 frps 把代理注册到 vhostHTTPPort、收到明文 HTTP 时报
  // 「Client sent an HTTP request to an HTTPS server」。加载时自动纠正成 https。
  if (isPlainObject(proxy.plugin) && ['https2http', 'https2https'].includes(proxy.plugin.type) && proxy.type !== 'https') {
    proxy.type = 'https';
  }
  /* 方案 Y（服务器 nginx 已统一终止 TLS）：公网入口只有 nginx 443 → frps vhostHTTPPort。
   * https + https2http/https2https 插件会把代理注册到 frps 的 vhostHTTPSPort（内网端口），
   * nginx 永远不会转发它 —— 表现为「控制台全绿、浏览器打开是 frp 的 404 页」。
   * 插件意味着后端本来就是明文 HTTP，Y 模式下统一纠正成纯 http，TLS 交给 nginx。 */
  if (options.nginxProxyEnabled && isPlainObject(proxy.plugin) && ['https2http', 'https2https'].includes(proxy.plugin.type)) {
    proxy.type = 'http';
    delete proxy.plugin;
  }
  // 只保留该类型真正认的字段：手改过的配置里常见 stcp 带 remotePort、
  // tcpmux 带 remotePort，写回去 frpc 会整份配置拒绝启动。
  if (HOST_TYPES.includes(proxy.type)) {
    if (proxy.remotePort !== undefined) proxy.remotePort = toInt(proxy.remotePort, null);
  } else if (PROXY_TYPES.includes(proxy.type)) {
    delete proxy.remotePort;
  }
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

function normalize(raw, options = {}) {
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
    proxies: Array.isArray(src.proxies) ? src.proxies.map((p) => normalizeProxy(p, options)) : [],
    visitors: Array.isArray(src.visitors) ? src.visitors.map((v) => (isPlainObject(v) ? { ...v } : v)) : [],
    _extra: extras,
  };
  return model;
}

function parseConfigText(text, options = {}) {
  return normalize(toml.parse(text), options);
}

function readConfig(configPath) {
  const text = fs.readFileSync(configPath, 'utf8');
  const model = parseConfigText(text);
  model._sourceText = text;
  return model;
}

function validate(model, options = {}) {
  const errors = [];
  const warnings = [];
  const push = (level, field, message) => (level === 'error' ? errors : warnings).push({ field, message });
  const allowPorts = options.allowPorts || [];

  if (!model.serverAddr) push('error', 'serverAddr', '服务器地址不能为空');
  else if (/\s/.test(model.serverAddr)) push('error', 'serverAddr', '服务器地址不能包含空格');
  else if (/^[a-z]+:\/\//i.test(model.serverAddr)) push('error', 'serverAddr', '服务器地址只填主机名或 IP，不要带 http:// 前缀');
  else if (!/^[A-Za-z0-9.-]+$/.test(model.serverAddr)) push('warn', 'serverAddr', '服务器地址看起来不是常见的主机名或 IP');
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

    if (!proxy.plugin) {
      if (!Number.isInteger(proxy.localPort) || proxy.localPort < 1 || proxy.localPort > 65535) {
        push('error', `proxies[${index}].localPort`, `${label} 的本地端口无效`);
      }
      if (!proxy.localIP) push('warn', `proxies[${index}].localIP`, `${label} 未设置 localIP，默认使用 127.0.0.1`);
      /* localIP 不校验的话，"999.1.1.1" 这种地址会被原样写进配置：
       * frpc 连不上本地服务，界面只会说“本地服务不通”，
       * 用户去查那个服务查半天，其实是 IP 打错了。 */
      else if (!isHostLike(proxy.localIP)) push('error', `proxies[${index}].localIP`, `${label} 的本地地址「${proxy.localIP}」不是合法的主机名或 IP`);
    }

    if (HOST_TYPES.includes(proxy.type)) {
      if (!Number.isInteger(proxy.remotePort) || proxy.remotePort < 1 || proxy.remotePort > 65535) {
        push('error', `proxies[${index}].remotePort`, `${label} 需要 1 - 65535 的公网端口`);
      } else {
        if (proxy.remotePort === model.serverPort) {
          push('warn', `proxies[${index}].remotePort`, `${label} 的公网端口与服务器端口相同，可能冲突`);
        }
        if (BROWSER_UNSAFE_PORTS.has(proxy.remotePort)) {
          push('warn', `proxies[${index}].remotePort`, `${label} 的公网端口 ${proxy.remotePort} 是浏览器（Chrome/Edge）的禁用端口，浏览器会拒绝访问（ERR_UNSAFE_PORT），建议换一个端口`);
        }
        if (!portInAllowList(proxy.remotePort, allowPorts)) {
          const range = formatAllowPorts(allowPorts);
          push('warn', `proxies[${index}].remotePort`, `${label} 的公网端口 ${proxy.remotePort} 不在服务器 allowPorts 允许范围${range ? `（${range}）` : ''}内，frps 会拒绝注册`);
        }
        const key = `${proxy.type}:${proxy.remotePort}`;
        if (remotePorts.has(key)) push('error', `proxies[${index}].remotePort`, `${label} 的公网端口 ${proxy.remotePort} 与「${remotePorts.get(key)}」重复`);
        else remotePorts.set(key, label);
      }
    }

    if (['http', 'https', 'tcpmux'].includes(proxy.type)) {
      const domains = Array.isArray(proxy.customDomains) ? proxy.customDomains : [];
      if (!domains.length && !proxy.subdomain) {
        push('error', `proxies[${index}].customDomains`, `${label} 需要至少一个自定义域名或 subdomain`);
      }
      for (const domain of domains) {
        // 带 http:// 或者带端口的域名会让 frpc 启动失败，但报错信息完全看不出是这个原因
        if (!isDomainLike(domain)) push('error', `proxies[${index}].customDomains`, `${label} 的域名「${domain}」不合法：只填域名本身，不要带 http://、端口或路径`);
      }
    }

    if (isPlainObject(proxy.plugin)) {
      const plugin = proxy.plugin;
      if (!['https2http', 'https2https'].includes(plugin.type)) {
        push('error', `proxies[${index}].plugin.type`, `${label} 的插件类型「${plugin.type}」不支持`);
      }
      if (!plugin.crtPath) push('error', `proxies[${index}].plugin.crtPath`, `${label} 需要证书文件 crtPath`);
      if (!plugin.keyPath) push('error', `proxies[${index}].plugin.keyPath`, `${label} 需要私钥文件 keyPath`);
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

const PROXY_ORDER = ['name', 'type', 'localIP', 'localPort', 'remotePort', 'customDomains', 'subdomain', 'multiplexer', 'locations', 'secretKey', 'serverName', 'allowUsers', 'plugin'];
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
    /* 名字精确到毫秒：以前只到秒，同一秒内连续保存两次会写同一个文件名，
     * 后一次把前一次的备份覆盖掉，正好丢掉最该留的那份。 */
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}-${String(now.getMilliseconds()).padStart(3, '0')}`;
    const base = path.basename(configPath, path.extname(configPath));
    const target = path.join(dir, `${base}-${stamp}.toml`);
    fs.copyFileSync(configPath, target);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.toml')).map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const item of files.slice(BACKUP_KEEP)) {
      try { fs.unlinkSync(path.join(dir, item.f)); } catch { /* ignore */ }
    }
    return target;
  } catch {
    return null;
  }
}

function backupsDir(configPath) {
  return path.join(path.dirname(configPath), 'frp-console-backups');
}

/* 列出某份配置的历史备份（供设置页可视化，按时间倒序）。 */
function listBackups(configPath) {
  const dir = backupsDir(configPath);
  try {
    if (!fs.existsSync(dir)) return { ok: true, backups: [], dir };
    const backups = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.toml'))
      .map((f) => {
        const full = path.join(dir, f);
        const st = fs.statSync(full);
        return { file: f, size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    return { ok: true, backups, dir };
  } catch (e) {
    return { ok: false, error: `读取备份目录失败：${e.message}`, dir, backups: [] };
  }
}

/* 把某个备份还原回配置路径；还原前会先把当前配置再备份一份，避免覆盖后回不去。 */
function restoreBackup(configPath, file) {
  try {
    const dir = backupsDir(configPath);
    const full = path.resolve(dir, file);
    if (!full.startsWith(path.resolve(dir) + path.sep)) {
      return { ok: false, error: '非法的备份文件名' };
    }
    if (!fs.existsSync(full)) return { ok: false, error: '备份文件不存在' };
    // 先把要还原的内容读进内存，再做当前配置的备份——备份会按保留数裁剪，
    // 若正在还原的是最老那份，备份动作可能把它删掉，所以这里必须先读走。
    const content = fs.readFileSync(full);
    const currentBackup = backupConfig(configPath);
    fs.writeFileSync(configPath, content);
    return { ok: true, backup: currentBackup, restoredFrom: file };
  } catch (e) {
    return { ok: false, error: `还原失败：${e.message}` };
  }
}

/* 保存时写在文件头的“最近保存”时间戳不属于配置内容，
 * 比较时必须先抹掉，否则每分钟第一次保存都会判定“内容变了”，
 * 于是备份目录被相同的副本迅速灌满，真正的改动反而被挤出去。 */
const STAMP_LINE = /^# 最近保存：.*$/m;

function configContentKey(text) {
  return String(text || '').replace(STAMP_LINE, '').replace(/\r\n/g, '\n').trim();
}

function writeConfig(configPath, model) {
  const text = serialize(model);
  const previous = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : null;
  if (previous !== null && configContentKey(previous) === configContentKey(text)) {
    return { changed: false, backup: null, text: previous };
  }
  const backup = previous !== null ? backupConfig(configPath) : null;
  const tmp = `${configPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, configPath);
  return { changed: true, backup, text };
}

/* 直接写 frpc.toml 原文（「配置编辑器」用）：保留用户手写的字段与注释，
 * 不做 serialize 归一化。写前备份、临时文件原子替换，语义与 writeConfig 一致。 */
function writeRawConfig(configPath, content) {
  const text = String(content || '');
  const previous = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : null;
  if (previous !== null && configContentKey(previous) === configContentKey(text)) {
    return { changed: false, backup: null, text: previous };
  }
  const backup = previous !== null ? backupConfig(configPath) : null;
  const tmp = `${configPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, configPath);
  return { changed: true, backup, text };
}

/* 把管理 API 的监听信息写进 frpc.toml。
 * 调用方传进来的是整份 settings（字段叫 adminPort/adminUser/adminPassword），
 * 以前这里按 port/user/password 解构，于是永远落在默认值 7400/admin/admin上 ——
 * 用户在设置里改端口、改口令，写进配置的还是老样子，
 * 控制台去问新端口，frpc 还在老端口听着，界面就永远卡在“等待管理 API 就绪”。 */
function ensureAdmin(model, options = {}) {
  const port = Number(options.adminPort !== undefined ? options.adminPort : options.port !== undefined ? options.port : 7400) || 7400;
  const user = String(options.adminUser || options.user || 'admin');
  const password = String(options.adminPassword || options.password || 'admin');
  const current = model.webServer;
  if (current && current.addr === '127.0.0.1' && Number(current.port) === port && current.user === user && current.password === password) {
    return false;
  }
  model.webServer = { ...(current || {}), addr: '127.0.0.1', port, user, password };
  return true;
}

/* 服务器 frps.toml 里的 allowPorts（[{start,end}|{single}]）是「客户端能申请的 remotePort 白名单」。
 * 空数组 / 非数组 = 不限制。这里判断某个端口是否被允许。 */
function portInAllowList(port, allowPorts) {
  if (!Array.isArray(allowPorts) || allowPorts.length === 0) return true;
  const n = Number(port);
  return allowPorts.some((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    if (entry.single != null) return n === Number(entry.single);
    if (entry.start != null && entry.end != null) return n >= Number(entry.start) && n <= Number(entry.end);
    return false;
  });
}

function formatAllowPorts(allowPorts) {
  if (!Array.isArray(allowPorts) || allowPorts.length === 0) return '';
  return allowPorts
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return '';
      if (entry.single != null) return String(entry.single);
      if (entry.start != null && entry.end != null) return `${entry.start}-${entry.end}`;
      return '';
    })
    .filter(Boolean)
    .join(',');
}

function collectUsedPorts(model) {
  const used = new Set();
  for (const proxy of model.proxies) {
    if (proxy.remotePort) used.add(Number(proxy.remotePort));
  }
  used.add(Number(model.serverPort));
  return used;
}

function suggestRemotePort(model, type = 'tcp', options = {}) {
  // 只有 tcp/udp 有公网端口；tcpmux 靠域名复用，不占端口。
  if (!HOST_TYPES.includes(type)) return null;
  const used = collectUsedPorts(model);
  const allowPorts = options.allowPorts || [];
  let port = 10000;
  while (port < 65000) {
    if (!used.has(port) && !BROWSER_UNSAFE_PORTS.has(port) && portInAllowList(port, allowPorts)) return port;
    port += 1;
  }
  return null;
}

/* 随机端口：优先在空闲 + 非浏览器黑名单 + 服务器 allowPorts 白名单里随机取一个，
 * 随机 200 次都取不到（比如 allowPorts 范围很小）就退回顺序找。 */
function randomRemotePort(model, type = 'tcp', options = {}) {
  if (!HOST_TYPES.includes(type)) return null;
  const used = collectUsedPorts(model);
  const allowPorts = options.allowPorts || [];
  for (let i = 0; i < 200; i++) {
    const port = 10000 + Math.floor(Math.random() * 55000); // 10000..64999
    if (!used.has(port) && !BROWSER_UNSAFE_PORTS.has(port) && portInAllowList(port, allowPorts)) return port;
  }
  return suggestRemotePort(model, type, options);
}

function firstDomainOf(proxy) {
  if (Array.isArray(proxy.customDomains) && proxy.customDomains.length) return String(proxy.customDomains[0]);
  return proxy.subdomain ? String(proxy.subdomain) : '';
}

function publicAddressFor(model, proxy, options = {}) {
  if (!model.serverAddr) return '';
  if (HOST_TYPES.includes(proxy.type)) {
    return proxy.remotePort ? `${model.serverAddr}:${proxy.remotePort}` : '';
  }
  if (proxy.type === 'http' || proxy.type === 'https') {
    const domain = firstDomainOf(proxy);
    if (!domain) return '';
    /* 方案 Y：服务器上已由 nginx 在 443 终止 TLS 并反代到 frps，公网入口
     * 是统一的 https://域名（不带端口）。这里直接返回它，不再拼 frps 的
     * vhost 端口（8080/8443 是内网端口，不该暴露给用户）。 */
    if (options.nginxProxyEnabled) {
      return `https://${domain}`;
    }
    /* 端口不能省：frps 的 vhostHTTPPort 很少真的开在 80（容器、非 root、多实例都换过端口），
     * 以前一律拼成 http://域名，导致健康检查永远访问不到自己的服务，
     * 界面报“公网不可达”，而实际隧道是通的。 */
    const standard = proxy.type === 'https' ? 443 : 80;
    const port = vhostPortOf(proxy.type, options);
    return `${proxy.type}://${domain}${port === standard ? '' : `:${port}`}`;
  }
  /* tcpmux 不是真端口：客户端要用 HTTP CONNECT 去 frps 的 tcpmux 端口上认领这个域名。
   * 直接标成 http://域名 会让人以为浏览器能打开，所以带上协议说明。 */
  if (proxy.type === 'tcpmux') {
    const domain = firstDomainOf(proxy);
    return domain ? `http-connect://${domain}` : '';
  }
  return '';
}

/* vhost 端口是 frps 侧的配置，客户端只能听用户说。缺省按 80/443。 */
function vhostPortOf(type, options = {}) {
  const raw = type === 'https' ? options.vhostHttpsPort : options.vhostHttpPort;
  const port = Number(raw);
  if (Number.isInteger(port) && port > 0 && port < 65536) return port;
  return type === 'https' ? 443 : 80;
}

/* 连通性检查到底往哪儿打。
 * http：连 serverAddr:vhostHTTPPort，用 Host 头带上绑定域名。
 *   直接按域名访问往往在“客户端这台机器”上根本解析不到（内网 DNS、测试域名、
 *   CDN 只对公网生效），结果是隧道明明通着，界面却永久报“公网不可达”。
 * https：连 serverAddr:vhostHTTPSPort，SNI 填绑定域名、rejectUnauthorized 关掉证书校验。
 *   健康检查只关心“流量能不能被 frps 按域名路由过去”，不关心证书是不是
 *   浏览器信任的（自签、过期、域名不一致都不该影响“隧道通不通”的判定）。
 * tcp/udp：连 serverAddr:remotePort。 */
function probeTargetFor(model, proxy, options = {}) {
  if (!model.serverAddr) return null;
  const type = proxy.type || 'tcp';
  if (type === 'http' || type === 'https') {
    const domain = firstDomainOf(proxy);
    if (!domain) return null;
    /* 方案 Y：公网入口是 nginx 的 443（终止 TLS 后转 frps vhostHTTPPort），
     * frps 自己的 vhost 端口（8080/8443）只是内网。健康检查必须走真实入口，
     * 否则会出现「探测 8443 全绿、浏览器经 nginx 打开是 404」的假绿。 */
    if (options.nginxProxyEnabled) {
      return {
        kind: 'http',
        url: `https://${model.serverAddr}/`,
        host: domain,
        servername: domain,
        rejectUnauthorized: false,
        port: 443,
        display: publicAddressFor(model, proxy, options),
      };
    }
  }
  if (type === 'http') {
    const domain = firstDomainOf(proxy);
    if (!domain) return null;
    const port = vhostPortOf('http', options);
    return { kind: 'http', url: `http://${model.serverAddr}:${port}/`, host: domain, port, display: publicAddressFor(model, proxy, options) };
  }
  if (type === 'https') {
    const domain = firstDomainOf(proxy);
    if (!domain) return null;
    const port = vhostPortOf('https', options);
    return {
      kind: 'http',
      url: `https://${model.serverAddr}:${port}/`,
      /* Host 头也要带上域名：frps 做 TLS 终止（https2http/https2https）时会按 Host
       * 校验请求是不是发给这个代理的，只填 SNI、不填 Host 会得到 421。 */
      host: domain,
      servername: domain,
      rejectUnauthorized: false,
      port,
      display: publicAddressFor(model, proxy, options),
    };
  }
  if (HOST_TYPES.includes(type) && proxy.remotePort) {
    return { kind: 'tcp', host: model.serverAddr, port: Number(proxy.remotePort), display: publicAddressFor(model, proxy, options) };
  }
  return null;
}

function makeProxy(input, options = {}) {
  const type = String(input.type || 'tcp').toLowerCase();
  const base = {
    name: String(input.name || '').trim(),
    type,
    localIP: String(input.localIP || '127.0.0.1').trim() || '127.0.0.1',
    localPort: toInt(input.localPort, null),
  };
  // remotePort 只有 tcp/udp 认。tcpmux 写进去 frpc 会直接拒绝整份配置
  // （unmarshal ProxyConfig error: json: unknown field "remotePort"）。
  if (HOST_TYPES.includes(type)) base.remotePort = toInt(input.remotePort, null);
  if (type === 'http' || type === 'https' || type === 'tcpmux') {
    const domains = Array.isArray(input.customDomains)
      ? input.customDomains
      : String(input.customDomains || '').split(/[,，\s]+/);
    const cleaned = domains.map((d) => String(d).trim()).filter(Boolean);
    if (cleaned.length) base.customDomains = cleaned;
    if (input.subdomain) base.subdomain = String(input.subdomain).trim();
  }
  if (type === 'tcpmux') base.multiplexer = String(input.multiplexer || 'httpconnect').trim() || 'httpconnect';
  if (type === 'http' || type === 'https') {
    const plugin = normalizePlugin(input.plugin);
    if (plugin) {
      base.plugin = plugin;
      // https2http / https2https 只在 https 类型下有效：它们让 frps 终止 TLS，
      // 而 type=http 会注册到 vhostHTTPPort，frps 收到明文 HTTP 会报
      // 「Client sent an HTTP request to an HTTPS server」。这里把类型纠正成 https。
      base.type = 'https';
    }
    /* 方案 Y：同 normalizeProxy 里的理由 —— nginx 已统一终止 TLS，
     * http/https 一律纯 http、不带插件，否则注册到内网 vhostHTTPSPort，
     * 浏览器经 nginx 访问是 404。 */
    if (options.nginxProxyEnabled) {
      base.type = 'http';
      delete base.plugin;
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

/* http/https 代理的 TLS 终止插件（frp 的 https2http / https2https）。
 * 只认这两个：别的 plugin 类型（如 http_proxy、static_file）不在这里暴露，
 * 用户手改配置写进去的其它 plugin 会经 normalizeProxy 原样保留。 */
function normalizePlugin(input) {
  if (!isPlainObject(input)) return null;
  const type = String(input.type || '').trim().toLowerCase();
  if (!['https2http', 'https2https'].includes(type)) return null;
  const plugin = { type };
  const str = (v) => String(v || '').trim();
  if (str(input.localAddr)) plugin.localAddr = str(input.localAddr);
  if (str(input.crtPath)) plugin.crtPath = str(input.crtPath);
  if (str(input.keyPath)) plugin.keyPath = str(input.keyPath);
  if (str(input.hostHeaderRewrite)) plugin.hostHeaderRewrite = str(input.hostHeaderRewrite);
  return plugin;
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
  writeRawConfig,
  backupConfig,
  listBackups,
  restoreBackup,
  probeTargetFor,
  firstDomainOf,
  vhostPortOf,
  ensureAdmin,
  suggestRemotePort,
  randomRemotePort,
  portInAllowList,
  formatAllowPorts,
  publicAddressFor,
  makeProxy,
};
