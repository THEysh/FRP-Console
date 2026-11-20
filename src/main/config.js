'use strict';

const fs = require('node:fs');
const net = require('node:net');
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
  /* [::1] 这种带方括号的写法也允许（用户从浏览器地址栏复制来的） */
  const bare = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text;
  /* IPv4 / IPv6 都交给 net.isIP 判定；注意 999.1.1.1 会返回 0，仍要走下面的严格检查 */
  if (net.isIP(bare)) return true;
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

function typeNameOf(value) {
  if (Array.isArray(value)) return '数组';
  if (isPlainObject(value)) return '表';
  if (value === null) return 'null';
  if (typeof value === 'string') return '字符串';
  if (typeof value === 'number') return '数字';
  if (typeof value === 'boolean') return '布尔值';
  return typeof value;
}

function normalize(raw, options = {}) {
  const src = isPlainObject(raw) ? raw : {};
  const extras = {};
  for (const [key, value] of Object.entries(src)) {
    if (!KNOWN_TOP_LEVEL.has(key)) extras[key] = value;
  }
  /* frpc 用 Go 的 TOML 反序列化，类型是严格匹配的：proxies 写成字符串、auth 写成布尔，
   * frpc 启动时直接报 `cannot unmarshal … into Go value of type …`。
   * 我们这边以前会把这类字段当"没有"静默吞掉 —— 界面上代理列表空白、看着一切正常，
   * 一启动却蹦出 Go 原文。这里把类型不符记下来，交给 validate() 明确报错。 */
  const shapeErrors = [];
  const expect = (key, label, ok, wanted) => {
    const value = src[key];
    /* null 代表"这段没写"（normalize 出来的模型会带 null，TOML 本身没有 null），不算类型错 */
    if (value === undefined || value === null || ok(value)) return;
    shapeErrors.push(`${label} 的类型不对：应该是${wanted}，当前是${typeNameOf(value)}（frpc 会拒绝整份配置）`);
  };
  expect('proxies', 'proxies', Array.isArray, '数组（每段用 [[proxies]] 开头）');
  expect('visitors', 'visitors', Array.isArray, '数组（每段用 [[visitors]] 开头）');
  expect('auth', 'auth', isPlainObject, '「[auth] 表」');
  expect('log', 'log', isPlainObject, '「[log] 表」');
  expect('webServer', 'webServer', isPlainObject, '「[webServer] 表」');
  expect('transport', 'transport', isPlainObject, '「[transport] 表」');
  const model = {
    /* frpc 会把 serverAddr 当成「主机」直接拼端口：写 [::1] 会变成 [[::1]]:7000 连不上。
     * 模型里统一存裸地址（::1），方括号在 loadConfigFromDisk 里会从文件中去掉。 */
    serverAddr: typeof src.serverAddr === 'string' ? src.serverAddr.trim().replace(/^\[([^\]]+)\]$/, '$1') : '',
    serverPort: toInt(src.serverPort, 7000) ?? 7000,
    loginFailExit: src.loginFailExit !== false,
    auth: normalizeAuth(src.auth),
    log: normalizeLog(src.log),
    webServer: normalizeWebServer(src.webServer),
    transport: isPlainObject(src.transport) ? { ...src.transport } : null,
    proxies: Array.isArray(src.proxies) ? src.proxies.map((p) => normalizeProxy(p, options)) : [],
    visitors: Array.isArray(src.visitors) ? src.visitors.map((v) => (isPlainObject(v) ? { ...v } : v)) : [],
    _extra: extras,
    _shapeErrors: shapeErrors,
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

/* frpc 顶层 start = ["a","b"] 是「只启动这些代理」的白名单。
 * 它不在 KNOWN_TOP_LEVEL 里，所以原样留在 _extra 中（保存时会写回去），
 * 这里只负责把它读出来，给校验与健康检查用。 */
function startNamesOf(model) {
  const raw = model && model._extra && model._extra.start;
  if (!Array.isArray(raw)) return [];
  return raw.map((name) => String(name == null ? '' : name).trim()).filter(Boolean);
}

function validate(model, options = {}) {
  const errors = [];
  const warnings = [];
  const push = (level, field, message) => (level === 'error' ? errors : warnings).push({ field, message });
  const allowPorts = options.allowPorts || [];

  if (!model.serverAddr) push('error', 'serverAddr', '服务器地址不能为空');
  else if (/\s/.test(model.serverAddr)) push('error', 'serverAddr', '服务器地址不能包含空格');
  else if (/^[a-z]+:\/\//i.test(model.serverAddr)) push('error', 'serverAddr', '服务器地址只填主机名或 IP，不要带 http:// 前缀');
  else if (model.serverAddr.includes(':') && !net.isIP(model.serverAddr.replace(/^\[|\]$/g, ''))) {
    /* 带冒号但不是 IPv6 字面量：多半是把端口一起填进来了 */
    push('error', 'serverAddr', '服务器地址只填主机名或 IP，不要带 :端口（端口填到"服务器端口"）');
  } else if (!isHostLike(model.serverAddr)) {
    push('warn', 'serverAddr', '服务器地址看起来不是常见的主机名或 IP');
  }
  // 顶层字段类型不对（proxies = "oops" 这种）：frpc 会整份拒绝，界面上却像是"没有代理"
  for (const message of (model && model._shapeErrors) || []) push('error', 'config', message);
  if (!Number.isInteger(model.serverPort) || model.serverPort < 1 || model.serverPort > 65535) {
    push('error', 'serverPort', '服务器端口必须在 1 - 65535 之间');
  }
  if (!model.auth.token) push('warn', 'auth.token', 'auth.token 为空；如果服务器未启用 token 校验可以忽略');

  const names = new Map();
  const remotePorts = new Map();
  /* 域名归属：同一个域名只能给一条 http/https/tcpmux 代理 */
  const domainOwners = new Map();
  /* frpc 顶层的 start = [...] 是「只启动列出的这些代理」的白名单（手改配置时常见）。
   * 只要某个代理不在列表里，frpc 根本不会去连它 —— 界面上以前只会显示「隧道未建立」，
   * 用户在本地端口、token、防火墙上查一圈也查不出来。这里提前说清楚。 */
  const startNames = startNamesOf(model);
  for (const [index, proxy] of model.proxies.entries()) {
    const label = proxy.name || `第 ${index + 1} 个代理`;
    if (!proxy.name) {
      push('error', `proxies[${index}].name`, '代理名称不能为空');
    } else {
      if (/\s|[[\]]/.test(proxy.name)) push('error', `proxies[${index}].name`, `代理名称「${proxy.name}」不能包含空格或方括号`);
      /* frpc 的 admin 接口把整份配置文本塞进 HTML 模板（/api/reload 等），名称里出现 < 会让
       * html/template 直接报错、返回 400 —— 表现是「配置保存了但热重载永远失败」，
       * 而且同一份配置里其它代理也一起不生效。所以在写入前就拦住，而不是等 frpc 报 Go 原文。 */
      if (/[<>]/.test(proxy.name)) {
        push('error', `proxies[${index}].name`, `代理名称「${proxy.name}」不能包含尖括号 < >：frpc 的管理接口用 HTML 模板渲染配置，这类名称会让热重载被拒绝（HTTP 400），保存后隧道里的代理不会更新`);
      }
      /* 零宽空格（U+200B）、BOM、方向标记这类「格式/控制字符」肉眼看不见，也不被 \s 拦住。
       * 实测 frpc 本身能接受这种名字（代理照样 running），但列表里它和去掉不可见字符后的名字
       * 长得一模一样，排查时几乎必然认错，所以给一条警告而不是错误。 */
      if (/[\p{Cc}\p{Cf}]/u.test(proxy.name)) {
        const shown = proxy.name.replace(/[\p{Cc}\p{Cf}]/gu, '?');
        const plain = proxy.name.replace(/[\p{Cc}\p{Cf}]/gu, '');
        push('warn', `proxies[${index}].name`, `代理名称「${shown}」里含不可见字符（零宽空格、BOM、控制符等）：frpc 能用，但在列表里它和「${plain}」长得一模一样，容易认错，建议删掉`);
      }
      if (proxy.name.length > 64) {
        push('warn', `proxies[${index}].name`, `代理名称「${proxy.name.slice(0, 12)}…」有 ${proxy.name.length} 个字符，列表里会换行显示，建议缩短到 64 个字符以内`);
      }
      if (names.has(proxy.name)) push('error', `proxies[${index}].name`, `代理名称「${proxy.name}」与「${names.get(proxy.name)}」重复`);
      else {
        /* 只差大小写的两个名字 frpc 认为不同、都能注册，但人在列表里几乎分不出来，
         * 而且我们自己的「访问路径」是按名字存的，改的时候容易改错那一条。 */
        const sameIgnoringCase = [...names.keys()].find((n) => n.toLowerCase() === proxy.name.toLowerCase());
        if (sameIgnoringCase) {
          push('warn', `proxies[${index}].name`, `代理名称「${proxy.name}」与「${sameIgnoringCase}」只差大小写：frpc 当作两条不同代理，但列表里几乎分不出来，建议改个能区分的名字`);
        }
        names.set(proxy.name, label);
      }

      if (startNames.length && !startNames.includes(proxy.name)) {
        const listed = startNames.slice(0, 4).join('、') + (startNames.length > 4 ? ` 等 ${startNames.length} 个` : '');
        push('warn', `proxies[${index}].name`, `${label} 不在配置的 start 列表里（start = [${listed}]），frpc 只启动列表里的代理，这个代理不会生效；在一个编辑器里删掉 start 或把「${proxy.name}」加进去即可`);
      }
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
          push('warn', `proxies[${index}].remotePort`, `${label} 的公网端口与服务器端口（${model.serverPort}）相同——frps 自己占着这个端口，起不来，请换一个公网端口`);
        }
        if (BROWSER_UNSAFE_PORTS.has(proxy.remotePort)) {
          push('warn', `proxies[${index}].remotePort`, `${label} 的公网端口 ${proxy.remotePort} 是浏览器（Chrome/Edge）的禁用端口，浏览器会拒绝访问（ERR_UNSAFE_PORT），建议换一个端口`);
        }
        /* 1024 以下是特权端口：frps 以 root 跑才绑得上。
         * 不提示的话，用户配完、隧道也连上了，只是这条代理永远 start error。 */
        if (proxy.remotePort < 1024) {
          push('warn', `proxies[${index}].remotePort`, `${label} 的公网端口 ${proxy.remotePort} 是特权端口（<1024），需要 frps 以 root 运行才能绑定；非 root 时这条代理会启动失败，服务器端会报 permission denied`);
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
      /* 两条都填时 frp 仍然要求服务器开启 subdomain：只要 subdomain 非空，
       * frps 没配 subDomainHost 就会回 "subdomain is not supported"。 */
      if (domains.length && proxy.subdomain) {
        push('warn', `proxies[${index}].subdomain`, `${label} 同时填了自定义域名和 subdomain：frp 仍会按 subdomain 注册，服务器没配 subDomainHost 时这条代理起不来。只想用完整域名就把 subdomain 清空`);
      }
      for (const domain of domains) {
        // 带 http:// 或者带端口的域名会让 frpc 启动失败，但报错信息完全看不出是这个原因
        if (!isDomainLike(domain)) {
          push('error', `proxies[${index}].customDomains`, `${label} 的域名「${domain}」不合法：只填域名本身，不要带 http://、端口或路径`);
        } else {
          /* isDomainLike 允许「*」开头的泛域名（frps 确实支持：*.a.com 能匹配 x.a.com），
           * 但「.a.com」「a..com」「a.com.」这种成不了形的写法它放过了，而 frps 永远匹配不到——
           * 结果是代理看着 running、公网怎么都 404，排查很久才知道是域名写错。 */
          const shaped = String(domain || '').trim();
          if (/^\./.test(shaped) || /\.$/.test(shaped) || /\.\./.test(shaped)) {
            push('error', `proxies[${index}].customDomains`, `${label} 的域名「${domain}」不成形：不能以点开头或结尾，也不能有连续的点（泛域名请写成 *.example.com）`);
          } else if (shaped.length > 253) {
            /* 253 是 DNS 名字的总长上限；更长的域名根本解析不出来，frps 也永远匹配不到。 */
            push('error', `proxies[${index}].customDomains`, `${label} 的域名太长（${shaped.length} 字符，域名最长 253）：${shaped.slice(0, 40)}…`);
          }
        }
        /* 同一个域名在**同一种类型**里只能给一条代理用：撞了以后 frps 会给后来者
         * 返回 router config conflict，界面上只会显示「未同步」，很难看出真实原因。
         * 但 http 与 https 走的是两个不同的 vhost 端口（vhostHTTPPort / vhostHTTPSPort），
         * 「同一站点同时开 http 和 https」是很常见的配置，不能当成冲突拦掉。 */
        const key = `${proxy.type}:${domain.toLowerCase()}`;
        if (domainOwners.has(key)) {
          push('error', `proxies[${index}].customDomains`, `域名「${domain}」已经被「${domainOwners.get(key)}」占用：同一种类型的代理（http/https/tcpmux）里，一个域名只能用一次（http 与 https 走不同端口，可以各配一条）`);
        } else {
          domainOwners.set(key, label);
        }
      }
      if (proxy.subdomain) {
        const key = `${proxy.type}:*.${String(proxy.subdomain).toLowerCase()}`;
        if (domainOwners.has(key)) {
          push('error', `proxies[${index}].subdomain`, `子域名「${proxy.subdomain}」已经被「${domainOwners.get(key)}」占用（同一类型内不能重复）`);
        } else {
          domainOwners.set(key, label);
        }
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

/* 保存时写在文件头的“最近保存”时间戳不属于配置内容，
 * 比较时必须先抹掉，否则每分钟第一次保存都会判定“内容变了”，
 * 于是备份目录被相同的副本迅速灌满，真正的改动反而被挤出去。 */
const STAMP_LINE = /^# 最近保存：.*$/m;

function configContentKey(text) {
  return String(text || '').replace(STAMP_LINE, '').replace(/\r\n/g, '\n').trim();
}

/* 写盘失败的统一措辞：把 EPERM/EACCES/EBUSY/ENOSPC 翻译成用户能行动的话。
 * 只做措辞，不改变「抛异常」还是「返回失败」的语义 —— 由调用方决定。 */
function explainWriteError(configPath, error) {
  const code = String((error && error.code) || '');
  const detail = String((error && error.message) || error);
  if (code === 'EPERM' || code === 'EACCES') {
    return `配置文件写入失败：${configPath} 不可写（可能是只读文件，或被其它程序占用）`;
  }
  if (code === 'EBUSY') return `配置文件写入失败：${configPath} 正被其它程序占用`;
  if (code === 'ENOSPC') return '配置文件写入失败：磁盘空间不足';
  if (code === 'ENOENT') return `配置文件写入失败：目录不存在（${configPath}）`;
  return `配置文件写入失败：${detail}`;
}

function writeConfig(configPath, model) {
  const text = serialize(model);
  const previous = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : null;
  if (previous !== null && configContentKey(previous) === configContentKey(text)) {
    return { changed: false, backup: null, text: previous };
  }
  const backup = previous !== null ? backupConfig(configPath) : null;
  const tmp = `${configPath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, configPath);
  } catch (error) {
    /* 临时文件留着只会让人以为写了一半，能删就删 */
    try { fs.unlinkSync(tmp); } catch {}
    return { changed: false, backup: null, text: previous, ok: false, error: explainWriteError(configPath, error) };
  }
  return { changed: true, backup, text, ok: true };
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
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, configPath);
  } catch (error) {
    /* 临时文件留着只会让人以为写了一半，能删就删 */
    try { fs.unlinkSync(tmp); } catch {}
    return { changed: false, backup: null, text: previous, ok: false, error: explainWriteError(configPath, error) };
  }
  return { changed: true, backup, text, ok: true };
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
    if (entry == null) return false;
    /* 容错：数字或 "3000-4000" 这种写法也认（TOML 里两种都常见），
     * 不能因为形状不对就把所有端口判成「不在白名单」。 */
    if (typeof entry === 'number') return n === entry;
    if (typeof entry === 'string') {
      const range = /^(\d+)\s*-\s*(\d+)$/.exec(entry.trim());
      if (range) return n >= Number(range[1]) && n <= Number(range[2]);
      return n === Number(entry);
    }
    if (typeof entry !== 'object') return false;
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

/* subdomain 只用「标签」，真实域名要靠服务器的 subDomainHost 补后缀：
 * 服务器配了 demo.sub.example.com，客户端填的 demo 才能被路由到。
 * 不知道后缀时返回 ''（由调用方决定怎么显示），不要拼出一个打不开的裸标签地址。 */
function subdomainHostOf(proxy, options = {}) {
  const sub = String(proxy.subdomain || '').trim();
  if (!sub) return '';
  const suffix = String(options.subDomainHost || '').trim().replace(/^\./, '');
  return suffix ? `${sub}.${suffix}` : '';
}

/* 真正用来做 Host/SNI 的域名：优先 customDomains，其次 subdomain + 服务器后缀。 */
function effectiveDomainOf(proxy, options = {}) {
  const domains = Array.isArray(proxy.customDomains) ? proxy.customDomains : [];
  if (domains.length) return String(domains[0]);
  return subdomainHostOf(proxy, options) || String(proxy.subdomain || '');
}

function publicAddressFor(model, proxy, options = {}) {
  if (!model.serverAddr) return '';
  if (HOST_TYPES.includes(proxy.type)) {
    return proxy.remotePort ? `${model.serverAddr}:${proxy.remotePort}` : '';
  }
  if (proxy.type === 'http' || proxy.type === 'https') {
    const domains = Array.isArray(proxy.customDomains) ? proxy.customDomains : [];
    /* 只填了 subdomain：必须用服务器的 subDomainHost 补后缀才是一个真地址。
     * 不知道后缀时不要拼 http://demo:28080 —— 那看起来像个能打开的主机名，
     * 复制出去必然打不开，反而误导。 */
    if (!domains.length && proxy.subdomain) {
      const full = subdomainHostOf(proxy, options);
      if (!full) return `subdomain:${proxy.subdomain}`;
    }
    const domain = effectiveDomainOf(proxy, options);
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
  /* 访问路径：很多服务根路径回 404、真正入口在 /panel/ 这类子路径上。
   * 探测必须打到真正入口，否则「隧道通、页面 404」和「一切正常」看起来一样。 */
  const openPath = (() => {
    const raw = String(proxy.openPath || '').trim();
    if (!raw) return '/';
    return (raw.startsWith('/') ? raw : `/${raw}`).replace(/\/{2,}/g, '/');
  })();
  const openPathLabel = openPath === '/' ? '' : openPath;
  if (type === 'http' || type === 'https') {
    const domain = effectiveDomainOf(proxy, options);
    if (!domain) return null;
    /* 方案 Y：公网入口是 nginx 的 443（终止 TLS 后转 frps vhostHTTPPort），
     * frps 自己的 vhost 端口（8080/8443）只是内网。健康检查必须走真实入口，
     * 否则会出现「探测 8443 全绿、浏览器经 nginx 打开是 404」的假绿。 */
    if (options.nginxProxyEnabled) {
      return {
        kind: 'http',
        url: `https://${model.serverAddr}${openPath}`,
        host: domain,
        servername: domain,
        rejectUnauthorized: false,
        port: 443,
        openPath: openPathLabel,
        display: publicAddressFor(model, proxy, options),
      };
    }
  }
  if (type === 'http') {
    const domain = effectiveDomainOf(proxy, options);
    if (!domain) return null;
    const port = vhostPortOf('http', options);
    return {
      kind: 'http',
      url: `http://${model.serverAddr}:${port}${openPath}`,
      host: domain,
      port,
      openPath: openPathLabel,
      display: publicAddressFor(model, proxy, options),
    };
  }
  if (type === 'https') {
    const domain = effectiveDomainOf(proxy, options);
    if (!domain) return null;
    const port = vhostPortOf('https', options);
    return {
      kind: 'http',
      url: `https://${model.serverAddr}:${port}${openPath}`,
      /* Host 头也要带上域名：frps 做 TLS 终止（https2http/https2https）时会按 Host
       * 校验请求是不是发给这个代理的，只填 SNI、不填 Host 会得到 421。 */
      host: domain,
      servername: domain,
      rejectUnauthorized: false,
      port,
      openPath: openPathLabel,
      display: publicAddressFor(model, proxy, options),
    };
  }
  if (HOST_TYPES.includes(type) && proxy.remotePort) {
    return { kind: 'tcp', host: model.serverAddr, port: Number(proxy.remotePort), openPath: openPathLabel, display: publicAddressFor(model, proxy, options) };
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
    const plugin = normalizePlugin(input.plugin, input);
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
function normalizePlugin(input, owner) {
  if (!isPlainObject(input)) return null;
  const type = String(input.type || '').trim().toLowerCase();
  if (!['https2http', 'https2https'].includes(type)) return null;
  const plugin = { type };
  const str = (v) => String(v || '').trim();
  if (str(input.localAddr)) plugin.localAddr = str(input.localAddr);
  /* localAddr 不填时按 localIP:localPort 兜底 —— frpc 对 https2http/https2https 要求
   * 必须给 localAddr，缺了它会拒绝加载整份配置，所有代理一起起不来。 */
  if (!plugin.localAddr && isPlainObject(owner)) {
    const host = str(owner.localIP) || '127.0.0.1';
    const port = Number(owner.localPort);
    if (Number.isInteger(port) && port > 0) plugin.localAddr = `${host}:${port}`;
  }
  if (str(input.crtPath)) plugin.crtPath = str(input.crtPath);
  if (str(input.keyPath)) plugin.keyPath = str(input.keyPath);
  if (str(input.hostHeaderRewrite)) plugin.hostHeaderRewrite = str(input.hostHeaderRewrite);
  return plugin;
}

/* 连接参数指纹：只取影响「连哪台 frps」的几项。
 * 隧道跑着的时候改了服务器地址/端口/token，frpc 仍然连着旧的那台 ——
 * 界面必须能看出来，否则「已连接」是假的（真机全剧本就这么假绿过一次）。 */
function connFingerprint(model) {
  if (!model) return '';
  const auth = (model && model.auth) || {};
  return JSON.stringify({
    a: String((model && model.serverAddr) || ''),
    p: Number((model && model.serverPort) || 0),
    t: String(auth.token || ''),
    m: String(auth.method || ''),
  });
}

module.exports = {
  explainWriteError,
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
  probeTargetFor,
  connFingerprint,
  firstDomainOf,
  vhostPortOf,
  ensureAdmin,
  suggestRemotePort,
  randomRemotePort,
  portInAllowList,
  formatAllowPorts,
  startNamesOf,
  publicAddressFor,
  makeProxy,
};
