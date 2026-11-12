'use strict';

const { execFileP, powershell } = require('./util');

/**
 * 列出本机 TCP 监听端口。
 * 结果同时带上进程名与监听地址，前端可直接用于“一键发布代理”。
 */
async function listListeners() {
  const netstat = await execFileP('netstat.exe', ['-ano', '-p', 'tcp'], { timeout: 15000 });
  if (!netstat.ok) return { ok: false, error: '无法读取本机端口列表', listeners: [] };

  const entries = new Map();
  for (const line of netstat.stdout.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    if (!/LISTENING|侦听/i.test(parts[3])) continue;
    const local = parts[1];
    const portMatch = /:(\d+)$/.exec(local);
    if (!portMatch) continue;
    const port = Number(portMatch[1]);
    if (!port) continue;
    const pid = Number(parts[4]) || 0;
    const host = local.slice(0, local.length - String(port).length - 1);
    if (!entries.has(port)) {
      entries.set(port, { port, hosts: new Set(), pid });
    }
    entries.get(port).hosts.add(host);
  }

  // 用 PowerShell 按 PID 精确取进程名。tasklist 在部分受限进程环境下会漏进程，
  // Get-Process 走系统 API，结果更完整。
  const pidToName = new Map();
  const pids = [...new Set([...entries.values()].map((item) => item.pid).filter(Boolean))];
  if (pids.length) {
    const script = `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id)=$($_.ProcessName)" }`;
    const r = await powershell(script, { timeout: 12000 });
    if (r.ok) {
      for (const line of r.stdout.split(/\r?\n/)) {
        const match = /^(\d+)=(.+)$/.exec(line.trim());
        if (match) pidToName.set(Number(match[1]), match[2]);
      }
    }
  }

  const listeners = [...entries.values()].map((item) => {
    const hosts = [...item.hosts].sort();
    return {
      port: item.port,
      pid: item.pid,
      process: pidToName.get(item.pid) || '',
      hosts,
      address: hosts.join(', '),
      loopbackOnly: hosts.every((h) => /^(127\.0\.0\.1|::1)$/.test(h)),
    };
  });
  listeners.sort((a, b) => a.port - b.port);
  return { ok: true, listeners };
}

module.exports = { listListeners };
