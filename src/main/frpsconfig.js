'use strict';

const { parse, stringify } = require('smol-toml');

const DEFAULT_FIELDS = {
  bindAddr: '0.0.0.0',
  bindPort: 7000,
  authEnabled: true,
  token: '',
  webEnabled: true,
  webAddr: '0.0.0.0',
  webPort: 4096,
  webUser: 'admin',
  webPassword: '',
  vhostHTTPEnabled: false,
  vhostHTTPPort: 80,
  vhostHTTPSEnabled: false,
  vhostHTTPSPort: 443,
  allowPortsText: '',
};

/* Dashboard（frps 面板）默认监听 0.0.0.0:4096，也就是公网可达。
 * 空密码等于「谁扫到谁能进」——面板里能看到 token、代理列表，还能改配置。
 * 所以密码留空时自动生成一个，而不是带着空密码上线。 */
function randomDashboardPassword(length = 20) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = require('node:crypto').randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function parseConfig(text) {
  try {
    const data = parse(String(text || ''));
    return { ok: true, data: data || {} };
  } catch (error) {
    return { ok: false, error: friendlyTomlError(error) };
  }
}

function friendlyTomlError(error) {
  const message = String((error && error.message) || error || 'TOML 解析失败');
  return message.replace(/^.*?:\s*/, '').trim() || 'TOML 解析失败';
}

function parseAllowPorts(text) {
  const raw = String(text || '').trim();
  if (!raw) return { ok: true, value: null };
  const items = [];
  for (const part of raw.split(/[,，\s]+/).filter(Boolean)) {
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    const single = /^(\d+)$/.exec(part);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start < 1 || end > 65535 || start > end) return { ok: false, error: `端口范围无效：${part}` };
      items.push({ start, end });
    } else if (single) {
      const port = Number(single[1]);
      if (port < 1 || port > 65535) return { ok: false, error: `端口无效：${part}` };
      items.push({ single: port });
    } else {
      return { ok: false, error: `无法识别端口范围：${part}（示例 2000-3000,3001）` };
    }
  }
  return { ok: true, value: items };
}

/* frps 的 allowPorts 在 TOML 里可能写成 [20000, "3000-4000"]，
 * 读进来要统一成 { single } / { start, end }，否则上层判断一条都匹配不上。 */
function normalizeAllowPorts(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const entry of list) {
    if (entry && typeof entry === 'object') {
      if (entry.single != null) out.push({ single: Number(entry.single) });
      else if (entry.start != null && entry.end != null) out.push({ start: Number(entry.start), end: Number(entry.end) });
      continue;
    }
    const parsed = parseAllowPorts(String(entry));
    if (parsed.ok && Array.isArray(parsed.value)) out.push(...parsed.value);
  }
  return out.filter((e) => (e.single >= 1 && e.single <= 65535) || (e.start >= 1 && e.end <= 65535 && e.start <= e.end));
}

function allowPortsToText(list) {
  if (!Array.isArray(list)) return '';
  return list
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return '';
      if (entry.single != null) return String(entry.single);
      if (entry.start != null && entry.end != null) return `${entry.start}-${entry.end}`;
      return '';
    })
    .filter(Boolean)
    .join(',');
}

function summary(data) {
  const source = data && typeof data === 'object' ? data : {};
  const auth = source.auth && typeof source.auth === 'object' ? source.auth : {};
  const web = (source.webServer && typeof source.webServer === 'object')
    ? source.webServer
    : (source.dashboard && typeof source.dashboard === 'object' ? source.dashboard : {});
  return {
    bindAddr: source.bindAddr || '0.0.0.0',
    bindPort: Number(source.bindPort) || 7000,
    authMethod: auth.method || (auth.token ? 'token' : 'none'),
    authEnabled: !!(auth.method === 'token' || auth.token),
    token: auth.token || '',
    webEnabled: !!(web.port || web.addr),
    webAddr: web.addr || '0.0.0.0',
    webPort: Number(web.port) || 0,
    webUser: web.user || 'admin',
    webPassword: web.password || '',
    vhostHTTPPort: Number(source.vhostHTTPPort) || 0,
    vhostHTTPSPort: Number(source.vhostHTTPSPort) || 0,
    /* 以下三个是「可选监听端口」：没配就没有对应监听，绝不能当成需要放行的端口，
     * 否则防火墙清单里会出现一个永远「没程序监听」的假告警。 */
    kcpBindPort: Number(source.kcpBindPort) || 0,
    quicBindPort: Number(source.quicBindPort) || 0,
    tcpmuxHTTPConnectPort: Number(source.tcpmuxHTTPConnectPort) || 0,
    allowPorts: normalizeAllowPorts(source.allowPorts),
    allowPortsText: allowPortsToText(source.allowPorts),
    extraKeys: Object.keys(source).filter((key) => !['bindAddr', 'bindPort', 'auth', 'webServer', 'dashboard', 'vhostHTTPPort', 'vhostHTTPSPort', 'allowPorts', 'kcpBindPort', 'quicBindPort', 'tcpmuxHTTPConnectPort'].includes(key)),
  };
}

function validateFields(fields) {
  const f = { ...DEFAULT_FIELDS, ...(fields || {}) };
  const errors = [];
  const warnings = [];
  const port = (value, label) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      errors.push(`${label} 必须是 1-65535 的整数`);
      return 0;
    }
    return n;
  };
  const bindPort = port(f.bindPort, 'bindPort');
  if (f.authEnabled) {
    if (!String(f.token || '').trim()) errors.push('已启用鉴权，但 auth.token 为空');
    else if (String(f.token).length < 8) warnings.push('token 少于 8 个字符，建议使用更长的随机值');
  }
  let webPort = 0;
  if (f.webEnabled) {
    webPort = port(f.webPort, 'Dashboard 端口');
    if (webPort && webPort === bindPort) errors.push('Dashboard 端口不能与 bindPort 相同');
    if (!String(f.webUser || '').trim()) errors.push('已启用 Dashboard，但用户名为空');
    if (!String(f.webPassword || '').trim()) warnings.push('Dashboard 密码为空，公网暴露时风险较高');
  }
  const vhttp = f.vhostHTTPEnabled ? port(f.vhostHTTPPort, 'vhostHTTPPort') : 0;
  const vhttps = f.vhostHTTPSEnabled ? port(f.vhostHTTPSPort, 'vhostHTTPSPort') : 0;
  if (vhttp && vhttp === bindPort) errors.push('vhostHTTPPort 不能与 bindPort 相同');
  if (vhttps && vhttps === bindPort) errors.push('vhostHTTPSPort 不能与 bindPort 相同');
  if (vhttp && vhttp === webPort) warnings.push('vhostHTTPPort 与 Dashboard 端口相同，可能冲突');
  const allow = parseAllowPorts(f.allowPortsText);
  if (!allow.ok) errors.push(allow.error);
  return { ok: errors.length === 0, errors, warnings, allowPorts: allow.value };
}

function fieldsFromData(baseData) {
  const d = baseData && typeof baseData === 'object' ? baseData : {};
  const auth = d.auth && typeof d.auth === 'object' ? d.auth : {};
  const web = (d.webServer && typeof d.webServer === 'object') ? d.webServer : {};
  return {
    bindAddr: d.bindAddr || DEFAULT_FIELDS.bindAddr,
    bindPort: Number(d.bindPort) || DEFAULT_FIELDS.bindPort,
    authEnabled: !!d.auth,
    token: auth.token || '',
    webEnabled: !!d.webServer,
    webAddr: web.addr || DEFAULT_FIELDS.webAddr,
    webPort: Number(web.port) || DEFAULT_FIELDS.webPort,
    webUser: web.user || DEFAULT_FIELDS.webUser,
    webPassword: web.password || '',
    vhostHTTPEnabled: Number(d.vhostHTTPPort) > 0,
    vhostHTTPPort: Number(d.vhostHTTPPort) || DEFAULT_FIELDS.vhostHTTPPort,
    vhostHTTPSEnabled: Number(d.vhostHTTPSPort) > 0,
    vhostHTTPSPort: Number(d.vhostHTTPSPort) || DEFAULT_FIELDS.vhostHTTPSPort,
    allowPortsText: allowPortsToText(d.allowPorts),
  };
}

function applyWizard(baseData, fields, { includeMeta = false } = {}) {
  // 字段未显式给出时，从现有配置继承：否则「只改个 bindPort / 密码」也会按
  // DEFAULT_FIELDS 的 token 为空、vhost 关闭来重写，把服务器上已配好的 token、
  // vhostHTTPPort / vhostHTTPSPort 悄悄删掉。
  const f = { ...fieldsFromData(baseData), ...(fields || {}) };
  /* 面板密码留空 = 公网无认证：自动生成一个，并在提示里原样告诉用户。 */
  let generatedPassword = '';
  if (f.webEnabled && !String(f.webPassword || '').trim()) {
    generatedPassword = randomDashboardPassword();
    f.webPassword = generatedPassword;
  }
  const check = validateFields(f);
  if (generatedPassword) {
    check.warnings = [
      ...(check.warnings || []),
      `Dashboard 密码原来是空的，已自动生成：${generatedPassword}（请记下，登录面板时要用）`,
    ];
  }
  if (!check.ok) return { ok: false, errors: check.errors, warnings: check.warnings };

  const data = structuredClone(baseData && typeof baseData === 'object' ? baseData : {});
  data.bindAddr = String(f.bindAddr || '0.0.0.0');
  data.bindPort = Number(f.bindPort);

  if (f.authEnabled) {
    data.auth = { ...(data.auth && typeof data.auth === 'object' ? data.auth : {}), method: 'token', token: String(f.token) };
  } else {
    delete data.auth;
  }

  if (f.webEnabled) {
    data.webServer = {
      addr: String(f.webAddr || '0.0.0.0'),
      port: Number(f.webPort),
      user: String(f.webUser || 'admin'),
      password: String(f.webPassword || ''),
    };
    delete data.dashboard;
  } else {
    delete data.webServer;
    delete data.dashboard;
  }

  if (f.vhostHTTPEnabled) data.vhostHTTPPort = Number(f.vhostHTTPPort);
  else delete data.vhostHTTPPort;
  if (f.vhostHTTPSEnabled) data.vhostHTTPSPort = Number(f.vhostHTTPSPort);
  else delete data.vhostHTTPSPort;

  if (check.allowPorts) data.allowPorts = check.allowPorts;
  else delete data.allowPorts;

  const text = includeMeta ? buildText(data, f, check) : stringify(data);
  return { ok: true, text, data, warnings: check.warnings, generatedPassword };
}

function buildText(data, fields, check) {
  // smol-toml 的 stringify 已能生成合法 TOML；这里只补一行来源注释，便于在服务器上辨认。
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const header = `# generated by FRP 控制台 ${stamp}\n# 修改后保存前会自动检查语法并备份原文件\n\n`;
  return `${header}${stringify(data)}${check.warnings.length ? `\n# 提示：${check.warnings.join('；')}\n` : ''}`;
}

function preview(content, fields) {
  const parsed = parseConfig(content);
  if (!parsed.ok) return { ok: false, error: `现有配置无法解析：${parsed.error}` };
  return applyWizard(parsed.data, fields, { includeMeta: true });
}

function validateText(text) {
  const parsed = parseConfig(text);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const value = summary(parsed.data);
  if (!value.bindPort) return { ok: false, error: '缺少 bindPort' };
  if (value.bindPort < 1 || value.bindPort > 65535) return { ok: false, error: 'bindPort 无效' };
  return { ok: true, summary: value };
}

/* 在 TOML 文本里设置一个「顶层」整型键（如 vhostHTTPPort / vhostHTTPSPort）。
 * 语义：
 *  - 已存在该键 → 原地替换数值（保留其它行原样）；
 *  - 不存在 → 插到第一个 [table] 之前（TOML 顶层键写在表之后会变成该表的字段，必须前置）；
 *  - 找不到表头 → 追加到末尾（并跳过尾部空行）。
 * 只做文本级修改，不重新序列化，避免把用户的注释、顺序、格式打乱。 */
function setTopLevelInt(content, key, value) {
  const text = String(content == null ? '' : content);
  const lines = text.split(/\r?\n/);
  const re = new RegExp(`^\\s*${key}\\s*=`);
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) {
      lines[i] = `${key} = ${value}`;
      return lines.join('\n');
    }
  }
  let idx = lines.findIndex((line) => /^\s*\[/.test(line));
  if (idx < 0) idx = lines.length;
  while (idx > 0 && !lines[idx - 1].trim()) idx -= 1;
  lines.splice(idx, 0, `${key} = ${value}`);
  return lines.join('\n');
}

/* 把 frps.toml 里 [webServer] 的口令换成新值，两种写法都认：
 *   [webServer] + password = "…"，以及点号写法 webServer.password = "…"
 * 段落存在但没有 password 行时补一行；没有该段也没有点号写法时返回 null。 */
function rotateWebPassword(text, pass) {
  const src = String(text || '');
  if (!src) return null;
  const lines = src.split(/\r?\n/);
  const value = '"' + String(pass).replace(/"/g, '') + '"';
  let inWeb = false;
  let start = -1;
  let end = -1;
  let replaced = false;
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (/^\[/.test(trimmed)) {
      if (inWeb) {
        end = i;
        inWeb = false;
      }
      if (/^\[webServer\]$/.test(trimmed)) {
        inWeb = true;
        start = i;
        end = lines.length;
      }
      continue;
    }
    if (inWeb && /^password\s*=/.test(trimmed)) {
      lines[i] = 'password = ' + value;
      replaced = true;
    } else if (!inWeb && /^webServer\.password\s*=/.test(trimmed)) {
      lines[i] = 'webServer.password = ' + value;
      replaced = true;
    }
  }
  if (replaced) return lines.join('\n');
  if (start >= 0) {
    let insertAt = end;
    while (insertAt > start + 1 && lines[insertAt - 1].trim() === '') insertAt -= 1;
    lines.splice(insertAt, 0, 'password = ' + value);
    return lines.join('\n');
  }
  let lastWeb = -1;
  for (let i = 0; i < lines.length; i += 1) if (/^webServer\./.test(lines[i].trim())) lastWeb = i;
  if (lastWeb >= 0) {
    lines.splice(lastWeb + 1, 0, 'webServer.password = ' + value);
    return lines.join('\n');
  }
  return null;
}

/* frps 起不来常见原因是「某个端口被占」，但报错只说「这个端口被占用」，
 * 而 frps 有 4 类端口（bindPort / Dashboard / vhostHTTPPort / vhostHTTPSPort）。
 * 日志里其实带着具体端口号，这里按当前配置把端口号翻译成「是哪个键」。 */
function refineStartError(text, summary) {
  const msg = String(text || '');
  if (!msg || !/address already in use/i.test(msg)) return msg;
  /* 只认「报 address already in use 的那一行」里的端口号。
   * 以前用一条带可选分支的正则去抓，遇到「Nov 20 20:42:34 … listen tcp 0.0.0.0:4096: bind」
   * 这种行会先咬到时间里的数字，结果把 4096 说成 42 端口。 */
  const line = String(msg).split(/\r?\n/).find((l) => /address already in use/i.test(l)) || '';
  const nums = [...line.matchAll(/:([0-9]{2,5})(?=[:\s]|$)/g)].map((m) => Number(m[1]));
  const configured = [summary && summary.bindPort, summary && summary.webPort, summary && summary.vhostHTTPPort, summary && summary.vhostHTTPSPort]
    .map(Number).filter(Boolean);
  const port = nums.find((n) => configured.includes(n)) || nums[0] || 0;
  const s = summary || {};
  const table = [
    ['bindPort', '连接端口（bindPort，客户端连它）'],
    ['webPort', 'Dashboard 面板端口（webServer.port）'],
    ['vhostHTTPPort', 'HTTP 域名穿透端口（vhostHTTPPort）'],
    ['vhostHTTPSPort', 'HTTPS 域名穿透端口（vhostHTTPSPort）'],
  ];
  const hit = port ? table.find(([k]) => Number(s[k]) === port) : null;
  const tail = hit
    ? `；被占的是 ${port} 端口——它是 frps 的 ${hit[1]}。要么在服务器上停掉占用它的程序（ss -lntp | grep ${port}），要么在「配置文件」里把对应的键改成空闲端口。`
    : (port ? `；被占的是 ${port} 端口——在服务器上执行 ss -lntp | grep ${port} 看是谁在用，或把对应配置项换成空闲端口。` : '');
  if (!tail) return msg;
  /* 原来的尾巴一律说「把 bindPort 换成空闲端口」，对 Dashboard/vhost 端口是错的 */
  return msg.replace(/；这个端口已经被别的程序占用了[^。]*。?/g, '').replace(/\s*$/, '') + tail;
}

module.exports = {
  DEFAULT_FIELDS,
  parseConfig,
  summary,
  validateFields,
  applyWizard,
  preview,
  validateText,
  parseAllowPorts,
  allowPortsToText,
  setTopLevelInt,
  randomDashboardPassword,
  normalizeAllowPorts,
  rotateWebPassword,
  refineStartError,
};
