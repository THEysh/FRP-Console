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

  const { names: pidToName, error: processError } = await processNames();

  /* 覆盖率要报出来。
   * tasklist 在权限不足时会“成功”返回一个只有部分进程的列表：
   * 实测 105 个监听端口里只有 12 个能对上进程名，界面上却一句提示都没有，
   * 用户只会以为那些端口不属于任何程序。 */
  const pids = [...new Set([...entries.values()].map((item) => item.pid))].filter(Boolean);
  const missing = pids.filter((pid) => !pidToName.get(pid));
  const coverage = pids.length ? (pids.length - missing.length) / pids.length : 1;
  const coverageError = missing.length && coverage < 0.8
    ? `${missing.length} / ${pids.length} 个端口的进程名读不出来（权限不足时常见；以管理员身份运行可看到全部）`
    : '';

  const listeners = [...entries.values()].map((item) => {
    const hosts = [...item.hosts].sort();
    const scopes = [...new Set(hosts.map(classifyHost))].sort((a, b) => scopeRank(b) - scopeRank(a));
    return {
      port: item.port,
      pid: item.pid,
      process: pidToName.get(item.pid) || '',
      hosts,
      address: hosts.join(', '),
      loopbackOnly: hosts.every((h) => /^(127\.0\.0\.1|::1)$/.test(h)),
      scopes,
      scope: scopes[0] || 'other',
    };
  });
  listeners.sort((a, b) => a.port - b.port);
  return { ok: true, listeners, processError: coverageError || processError };
}

/* 把监听地址归成几类，前端好标注“这个服务到底是只给自己、还是整个局域网/公网都能连”。
 * 只按 IP 段做静态判断，不联网、不查 DNS。 */
function classifyHost(host) {
  const text = String(host || '').trim();
  if (!text) return 'other';
  // IPv4 映射的 IPv6 地址（::ffff:127.0.0.1）还原成 IPv4 再判。
  if (/^::ffff:/i.test(text)) return classifyHost(text.replace(/^::ffff:/i, ''));
  if (/^(127\.\d+\.\d+\.\d+|::1)$/.test(text)) return 'loopback';
  if (/^(0\.0\.0\.0|\[::\]|::)$/.test(text)) return 'all';
  // 172.17~172.31 是 Docker 默认网桥/自定义网络的惯用段，单独标出来，
  // 避免用户误以为这是自己局域网里的另一台机器。
  if (/^172\.(1[7-9]|2\d|3[01])\.\d+\.\d+$/.test(text)) return 'docker';
  if (/^(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+)$/.test(text)) return 'lan';
  return 'public';
}

/* “开放程度”排序：越靠前越说明这个端口暴露给越多的来源。
 * 有多个地址时取最开放的那个作为主标签。 */
function scopeRank(scope) {
  return { all: 5, public: 4, lan: 3, docker: 2, loopback: 1, other: 0 }[scope] || 0;
}

/**
 * PID → 进程名。
 * 注意：这里**不能用 Get-Process**。在 Electron（GUI 子系统、无控制台）里派生 powershell 时，
 * Get-Process 会直接以退出码 1 静默失败（没有 stdout、也没有错误记录），
 * 于是“进程”列永远显示“未知”。
 *
 * 而且单一来源会漏：.NET 的 GetProcesses() 只看得到 70 来个进程（另一个会话/权限更高的
 * 进程拿不到），tasklist 更全但个别受限进程会缺。两个来源合并，才能把监听端口对上号。
 */
async function processNames() {
  const names = new Map();
  const psError = [];

  const tasklist = await execFileP('tasklist.exe', ['/FO', 'CSV', '/NH'], { timeout: 15000 });
  if (tasklist.ok) {
    for (const line of tasklist.stdout.split(/\r?\n/)) {
      const cells = line.match(/"([^"]*)"/g);
      if (!cells || cells.length < 2) continue;
      const name = cells[0].replace(/"/g, '');
      const pid = Number(cells[1].replace(/"/g, ''));
      if (pid) names.set(pid, name.replace(/\.exe$/i, ''));
    }
  } else {
    psError.push('tasklist 不可用');
  }

  const script = '[System.Diagnostics.Process]::GetProcesses() | ForEach-Object { try { "$($_.Id)=$($_.ProcessName)" } catch { } }';
  const ps = await powershell(script, { timeout: 20000 });
  if (ps.ok) {
    for (const line of ps.stdout.split(/\r?\n/)) {
      const match = /^(\d+)=(.+)$/.exec(line.trim());
      if (match && !names.has(Number(match[1]))) names.set(Number(match[1]), match[2].trim());
    }
  } else {
    const reason = (ps.stderr || '').split(/\r?\n/).map((s) => s.trim())
      .filter((line) => line && !line.startsWith('#< CLIXML'))[0] || `退出码 ${ps.code}`;
    psError.push(reason.slice(0, 80));
  }

  return { names, error: names.size ? '' : `读不到进程名：${psError.join('；')}` };
}

module.exports = { listListeners, classifyHost };
