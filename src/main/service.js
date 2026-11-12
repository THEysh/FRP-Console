'use strict';

const { execFileP, powershell } = require('./util');

const STATE_MAP = {
  1: 'stopped',
  2: 'start_pending',
  3: 'stop_pending',
  4: 'running',
  5: 'continue_pending',
  6: 'pause_pending',
  7: 'paused',
};

const START_TYPE_MAP = {
  AUTO_START: 'auto',
  DEMAND_START: 'demand',
  DISABLED: 'disabled',
  BOOT_START: 'boot',
  SYSTEM_START: 'system',
};

let elevatedCache = null;

async function isElevated() {
  if (elevatedCache !== null) return elevatedCache;
  const r = await powershell(
    '$p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent()); $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    { timeout: 15000 },
  );
  elevatedCache = r.ok && /True/i.test(r.stdout);
  return elevatedCache;
}

function parseQuery(stdout) {
  const stateMatch = /STATE\s*:\s*(\d+)\s+([A-Z_]+)/.exec(stdout);
  const pidMatch = /PID\s*:\s*(\d+)/.exec(stdout);
  return {
    stateCode: stateMatch ? Number(stateMatch[1]) : null,
    state: stateMatch ? STATE_MAP[Number(stateMatch[1])] || stateMatch[2].toLowerCase() : 'unknown',
    pid: pidMatch ? Number(pidMatch[1]) : null,
  };
}

function parseQc(stdout) {
  const startMatch = /START_TYPE\s*:\s*(\d+)\s+([A-Z_]+)/.exec(stdout);
  const binMatch = /BINARY_PATH_NAME\s*:\s*(.*)/.exec(stdout);
  const displayMatch = /DISPLAY_NAME\s*:\s*(.*)/.exec(stdout);
  return {
    startType: startMatch ? START_TYPE_MAP[startMatch[2]] || startMatch[2].toLowerCase() : 'unknown',
    binaryPath: binMatch ? binMatch[1].trim() : '',
    displayName: displayMatch ? displayMatch[1].trim() : '',
  };
}

async function queryService(name) {
  if (!name) return { installed: false, state: 'missing', name };
  const r = await execFileP('sc.exe', ['query', name], { timeout: 10000 });
  const text = `${r.stdout}\n${r.stderr}`;
  if (r.code === 1060 || /1060|does not exist|指定的服务|不存在/i.test(text) && !/STATE/.test(text)) {
    return { installed: false, state: 'missing', name, error: '服务未安装' };
  }
  if (!/STATE\s*:\s*\d+/.test(text)) {
    return { installed: false, state: 'unknown', name, error: text.trim().split('\n')[0] || '无法读取服务状态' };
  }
  const qc = await execFileP('sc.exe', ['qc', name], { timeout: 10000 });
  return {
    installed: true,
    name,
    ...parseQuery(text),
    ...parseQc(qc.stdout),
  };
}

async function detectServiceName(preferred = 'frpc') {
  const q = await queryService(preferred);
  if (q.installed) return preferred;
  const script = [
    "$list = Get-CimInstance Win32_Service | Where-Object { $_.PathName -match 'frp' -or ($_.PathName -match 'nssm(.exe)?' -and $_.PathName -notmatch 'frp_console') }",
    "$list | Select-Object -First 6 Name,State,PathName | ConvertTo-Json -Compress",
  ].join('; ');
  const r = await powershell(script, { timeout: 20000 });
  if (!r.ok || !r.stdout.trim()) return preferred;
  try {
    const parsed = JSON.parse(r.stdout);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const match = list.find((s) => s && s.Name);
    return match ? match.Name : preferred;
  } catch {
    return preferred;
  }
}

async function elevatedSc(args, timeout = 90000) {
  const quoted = args.map((arg) => `'${String(arg).replace(/'/g, "''")}'`).join(',');
  const script = [
    '$ErrorActionPreference = "Stop"',
    `try { $p = Start-Process -FilePath "$env:SystemRoot\\System32\\sc.exe" -ArgumentList @(${quoted}) -Verb RunAs -Wait -PassThru -WindowStyle Hidden } catch { Write-Error $_; exit 900 }`,
    'if ($null -eq $p) { exit 901 }',
    'exit $p.ExitCode',
  ].join('; ');
  const r = await powershell(script, { timeout });
  return {
    ...r,
    canceled: r.code === 900 || /canceled by the user|已取消|cancelled/i.test(`${r.stdout}${r.stderr}`),
    output: `${r.stdout}${r.stderr}`.trim(),
  };
}

function friendlyScError(r) {
  const text = `${r.stderr || ''}${r.stdout || ''}`.trim();
  const first = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(-1)[0] || '';
  if (r.canceled) return '操作已取消（未获得管理员授权）';
  if (r.code === 5 || /拒绝访问|Access is denied/i.test(text)) return '权限不足：该操作需要管理员权限';
  if (r.code === 1058 || /1058/.test(text)) return '服务已被禁用，无法启动';
  if (r.code === 1060 || /1060/.test(text)) return '服务不存在';
  return first || `sc 命令执行失败（代码 ${r.code}）`;
}

async function runSc(args, { allowElevate = true, timeout = 60000 } = {}) {
  const direct = await execFileP('sc.exe', args, { timeout });
  if (direct.ok) return { ok: true, via: 'direct', output: direct.stdout.trim(), code: 0 };
  if (!allowElevate) return { ok: false, via: 'direct', output: friendlyScError(direct), code: direct.code, raw: `${direct.stdout}${direct.stderr}` };
  const elevated = await elevatedSc(args);
  return {
    ok: elevated.code === 0,
    via: 'elevated',
    output: elevated.code === 0 ? elevated.output : friendlyScError(elevated),
    code: elevated.code,
    canceled: elevated.canceled,
    raw: elevated.output,
  };
}

async function waitForState(name, states, timeout = 18000) {
  const accepted = Array.isArray(states) ? states : [states];
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeout) {
    last = await queryService(name);
    if (accepted.includes(last.state)) return { ok: true, service: last };
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  return { ok: false, service: last, error: `等待服务进入 ${accepted.join('/')} 超时（当前 ${last ? last.state : 'unknown'}）` };
}

async function startService(name) {
  const current = await queryService(name);
  if (!current.installed) return { ok: false, error: '服务未安装' };
  if (current.state === 'running') return { ok: true, already: true };
  const r = await runSc(['start', name], { timeout: 90000 });
  if (!r.ok && !r.canceled) return { ok: false, error: r.output };
  const wait = await waitForState(name, ['running'], 20000);
  return wait.ok ? { ok: true, service: wait.service } : { ok: false, error: r.canceled ? '已取消管理员授权' : wait.error };
}

async function stopService(name) {
  const current = await queryService(name);
  if (!current.installed) return { ok: false, error: '服务未安装' };
  if (current.state === 'stopped') return { ok: true, already: true };
  const r = await runSc(['stop', name], { timeout: 90000 });
  if (!r.ok && !r.canceled) return { ok: false, error: r.output };
  const wait = await waitForState(name, ['stopped'], 20000);
  return wait.ok ? { ok: true, service: wait.service } : { ok: false, error: r.canceled ? '已取消管理员授权' : wait.error };
}

async function restartService(name) {
  const r = await stopService(name);
  if (!r.ok) return r;
  return startService(name);
}

async function setStartType(name, mode) {
  const value = mode === 'auto' ? 'auto' : mode === 'disabled' ? 'disabled' : 'demand';
  const r = await runSc(['config', name, 'start=', value], { timeout: 60000 });
  return r.ok ? { ok: true } : { ok: false, error: r.output };
}

module.exports = {
  isElevated,
  queryService,
  detectServiceName,
  startService,
  stopService,
  restartService,
  setStartType,
  friendlyScError,
};
