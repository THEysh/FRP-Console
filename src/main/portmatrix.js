'use strict';
/* 端口矩阵：四信号交叉判定（v1.2.56）
 *
 * S1 服务器在监听（ss） / S2 服务器本机防火墙规则 / S3 从本机实测可达 / S4 防火墙是否启用
 * 只有把 S1·S2·S3 交叉起来，才能回答「到底拦在哪一层」：
 *   S1✓ S2✓ S3✗ → 服务器内已放行仍连不上，只可能是云安全组/中间设备（本机防火墙管不到的那层）
 *   S1✓ S2✗ S3✗ → 服务器内防火墙没放行
 *   S1✗        → 程序没监听，跟防火墙无关（最容易误判的一种）
 * 纯函数模块：便于单测（.e2e/lab/test-port-matrix.cjs）。
 */

/* 解析一条防火墙规则原文（`7000/tcp`、`39000:40000/tcp`、`1-65535/udp`）成区间。 */
function parseRuleSpec(spec) {
  const m = /^(\d{1,5})(?::(\d{1,5})|-(\d{1,5}))?\/(tcp|udp)$/i.exec(String(spec || '').trim());
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2] || m[3] || m[1]);
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  return { start, end, proto: m[4].toLowerCase() };
}

/* 单行判定。listen / rule / reachable 允许为 null（未知），此时给保守结论。 */
function judgePortRow({ label, port, proto, listen, rule, reachable, fwActive, group, tunnelActive }) {
  const row = { label: label || '', port: Number(port), proto: proto || 'tcp', group: group || 'frps', listen, rule, reachable, code: 'ok', tone: 'ok', text: '', action: '' };
  if (listen === false) {
    /* 代理端口由 frps 代表监听：本机隧道没连这台服务器时，这些端口当然没人听，
     * 这属于「隧道没跑」而不是「端口有问题」，不能刷成一片红色告警。 */
    if (row.group === 'proxy' && tunnelActive === false) {
      return { ...row, code: 'tunnel-stopped', tone: 'warn', text: '隧道没连这台服务器，frps 还没注册这个端口', action: '' };
    }
    return { ...row, code: 'not-listening', tone: 'bad', text: '没有程序在这个端口监听', action: 'service' };
  }
  if (!fwActive) {
    if (reachable === false) {
      return { ...row, code: 'cloud-blocked', tone: 'bad', text: '服务器没有本机防火墙，外面却连不上 → 云安全组/网络层拦截', action: 'cloud' };
    }
    if (reachable === true) return { ...row, code: 'ok', tone: 'ok', text: '正常（未启用防火墙）', action: '' };
    return { ...row, code: 'ok', tone: 'ok', text: '未启用防火墙，不拦截', action: '' };
  }
  if (row.proto === 'udp') {
    if (rule) return { ...row, code: 'ok', tone: 'ok', text: '规则已放行（UDP 无握手，无法实测）', action: '' };
    return { ...row, code: 'likely-fw-blocked', tone: 'bad', text: '规则未放行，UDP 代理很可能被拦', action: 'open' };
  }
  if (rule) {
    if (reachable === true) return { ...row, code: 'ok', tone: 'ok', text: '正常', action: '' };
    if (reachable === false) return { ...row, code: 'cloud-blocked', tone: 'bad', text: '服务器已监听、防火墙也放行了，外面连不上 → 云安全组/中间设备拦截', action: 'cloud' };
    return { ...row, code: 'ok', tone: 'ok', text: '规则已放行（实测未知）', action: '' };
  }
  if (reachable === true) return { ...row, code: 'rule-missing-reachable', tone: 'warn', text: '规则没写但实测通（云层已放行），可忽略', action: '' };
  return { ...row, code: 'fw-blocked', tone: 'bad', text: '服务器内防火墙没放行这个端口', action: 'open' };
}

/* 组装整张矩阵：按 frps / proxy / system 三组去重后逐行判定。
 * tunnelActive=false 表示本机隧道没连这台服务器（代理端口因此不会在 frps 上注册）。 */
function buildPortMatrix({ cfgPorts, proxyPorts, sysPorts, allowed, fwActive, listenPorts, tunnelActive = null }) {
  const listenTcp = (listenPorts && listenPorts.tcp) || null;
  const listenUdp = (listenPorts && listenPorts.udp) || null;
  const known = (set, port) => (set ? set.has(Number(port)) : null);
  const covered = (port, proto) => (allowed || []).some((a) => {
    const r = parseRuleSpec(a.spec || `${a.port}/${a.proto}`);
    return r && r.proto === proto && Number(port) >= r.start && Number(port) <= r.end;
  });
  const rows = [];
  const push = (group, list) => {
    for (const p of list || []) {
      if (!p || !p.port) continue;
      rows.push({
        group,
        label: p.label || '',
        port: Number(p.port),
        proto: p.proto || 'tcp',
        reachable: p.proto === 'tcp' && typeof p.reachable === 'boolean' ? p.reachable : null,
      });
    }
  };
  push('frps', cfgPorts);
  push('proxy', proxyPorts);
  push('system', sysPorts);
  const seen = new Set();
  const uniq = [];
  for (const r of rows) {
    const key = `${r.group}:${r.proto}:${r.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(r);
  }
  return uniq.map((r) => judgePortRow({
    ...r,
    listen: known(r.proto === 'udp' ? listenUdp : listenTcp, r.port),
    rule: covered(r.port, r.proto),
    reachable: r.reachable,
    fwActive,
    tunnelActive,
  }));
}

/* 把矩阵汇总成一句人话 + 各类计数。 */
function summarizeMatrix(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const by = (code) => list.filter((r) => r.code === code);
  const cloudBlocked = by('cloud-blocked');
  const fwBlocked = [...by('fw-blocked'), ...by('likely-fw-blocked')];
  const notListening = by('not-listening');
  const tunnelStopped = by('tunnel-stopped');
  const needsWork = cloudBlocked.length + fwBlocked.length + notListening.length;
  let text = '全部需要放行的端口都通';
  let level = 'ok';
  if (needsWork) {
    const parts = [];
    if (cloudBlocked.length) parts.push(`${cloudBlocked.length} 个在云安全组/网络层`);
    if (fwBlocked.length) parts.push(`${fwBlocked.length} 个在服务器防火墙`);
    if (notListening.length) parts.push(`${notListening.length} 个没有程序监听`);
    text = `${needsWork} 个端口有问题 —— ${parts.join('，')}`;
    level = (cloudBlocked.length || fwBlocked.length) ? 'bad' : 'warn';
  } else if (tunnelStopped.length) {
    text = `没有端口阻塞；但隧道没连这台服务器，${tunnelStopped.length} 个代理端口还没注册`;
    level = 'warn';
  }
  return {
    level,
    text,
    cloudBlocked: cloudBlocked.length,
    fwBlocked: fwBlocked.length,
    notListening: notListening.length,
    tunnelStopped: tunnelStopped.length,
    ok: list.length - needsWork - tunnelStopped.length,
    total: list.length,
  };
}

/* 生成「照抄到云控制台」的规则文本：精确清单 + 全放行两条。 */
function buildRuleTexts(cfgPorts, proxyPorts, sysPorts, sshPort) {
  const all = [...(cfgPorts || []), ...(proxyPorts || []), ...(sysPorts || [])];
  const seen = new Set();
  const lines = ['入方向（允许）：'];
  for (const p of all) {
    if (!p || !p.port) continue;
    const key = `${p.proto}:${p.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`${String(p.proto || 'tcp').toUpperCase()}  ${p.port}  0.0.0.0/0  允许   # ${p.label || ''}`.trim());
  }
  if (sshPort && !seen.has(`tcp:${sshPort}`)) lines.push(`TCP  ${sshPort}  0.0.0.0/0  允许   # SSH`);
  return {
    exact: lines.join('\n'),
    wide: '入方向（允许）：\nTCP  1-65535  0.0.0.0/0  允许   # 全端口（自用/测试，谨慎）\nUDP  1-65535  0.0.0.0/0  允许   # 全端口（自用/测试，谨慎）',
  };
}

module.exports = { parseRuleSpec, judgePortRow, buildPortMatrix, summarizeMatrix, buildRuleTexts };
