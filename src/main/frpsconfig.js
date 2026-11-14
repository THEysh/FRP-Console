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
    allowPorts: Array.isArray(source.allowPorts) ? source.allowPorts : [],
    allowPortsText: allowPortsToText(source.allowPorts),
    extraKeys: Object.keys(source).filter((key) => !['bindAddr', 'bindPort', 'auth', 'webServer', 'dashboard', 'vhostHTTPPort', 'vhostHTTPSPort', 'allowPorts'].includes(key)),
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
  const check = validateFields(f);
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
  return { ok: true, text, data, warnings: check.warnings };
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
};
