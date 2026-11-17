'use strict';
/* 端口可达性探测原语（v1.2.56）
 *
 * 统一封装「从本机能不能连上某台服务器的某个端口」，并把底层错误归一成
 * 有限几种 kind，供判定引擎（index.js buildPortMatrix）区分：
 *   - refused：对方主机在线，但端口没有监听 / 被防火墙 REJECT
 *   - timeout：包被静默丢弃 —— 云安全组、网络 ACL、本机出网拦截的典型表现
 *   - reset  ：中间设备（云防火墙代答、企业代理）掐断
 *   - dns    ：地址解析失败
 * TCP 的结论是「确定的」；UDP 没有握手，只能给「疑似」，调用方必须按此措辞展示。
 */
const net = require('net');
const dgram = require('dgram');

function classifyNetError(err) {
  const text = String((err && (err.code || err.message)) || err || '');
  if (/ECONNREFUSED/i.test(text)) return 'refused';
  if (/ETIMEDOUT|ETIMEOUT|timeout|timed out/i.test(text)) return 'timeout';
  if (/ECONNRESET|EPIPE|reset by peer/i.test(text)) return 'reset';
  if (/ENOTFOUND|EAI_AGAIN|NXDOMAIN|getaddrinfo/i.test(text)) return 'dns';
  if (/EHOSTUNREACH|ENETUNREACH|network is unreachable|no route/i.test(text)) return 'unreachable';
  return 'unknown';
}

/* TCP 探测：连上即 ok。返回 { ok, ms, kind, error, certain:true } */
function probePort({ host, port, timeout = 2000 } = {}) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const target = String(host || '').trim();
    const num = Number(port);
    if (!target || !Number.isInteger(num) || num < 1 || num > 65535) {
      resolve({ ok: false, ms: 0, kind: 'invalid', error: '主机或端口无效', certain: true });
      return;
    }
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* 已断开 */ }
      resolve({ ms: Date.now() - startedAt, certain: true, ...payload });
    };
    const socket = net.connect({ host: target, port: num });
    socket.setTimeout(Math.max(300, Number(timeout) || 2000));
    socket.once('connect', () => finish({ ok: true, kind: 'open', error: '' }));
    socket.once('timeout', () => finish({ ok: false, kind: 'timeout', error: `连接超时（${Math.round((Date.now() - startedAt) / 1000)}s）` }));
    socket.once('error', (err) => finish({ ok: false, kind: classifyNetError(err), error: String((err && err.message) || err) }));
  });
}

/* UDP 探测：没有握手，只能「尽力而为」。
 * 收到 ICMP 端口不可达（ECONNREFUSED）→ 确定不通；否则一律 unconfirmed。
 * 返回 { ok, certain:false, kind:'unconfirmed'|'refused', note }
 */
function probeUdp({ host, port, timeout = 1200 } = {}) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const target = String(host || '').trim();
    const num = Number(port);
    if (!target || !Number.isInteger(num) || num < 1 || num > 65535) {
      resolve({ ok: false, ms: 0, kind: 'invalid', certain: false, note: '主机或端口无效' });
      return;
    }
    const socket = dgram.createSocket('udp4');
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      try { socket.close(); } catch { /* 已关闭 */ }
      resolve({ ms: Date.now() - startedAt, certain: false, ...payload });
    };
    socket.once('error', (err) => {
      const kind = classifyNetError(err);
      finish(kind === 'refused'
        ? { ok: false, kind: 'refused', note: '服务器回了「端口不可达」（ICMP），这个 UDP 端口确实没开' }
        : { ok: null, kind: 'unconfirmed', note: 'UDP 无法确认（对方可以静默丢弃）' });
    });
    socket.once('message', () => finish({ ok: true, kind: 'open', note: 'UDP 端口有响应' }));
    socket.connect(num, target, () => {
      try { socket.send(Buffer.from([0x00]), () => { /* 发出去就不再管 */ }); } catch { /* 已关闭 */ }
    });
    setTimeout(() => finish({ ok: null, kind: 'unconfirmed', note: 'UDP 无响应，无法确认是否被拦' }), Math.max(400, Number(timeout) || 1200));
  });
}

/* 把「SSH 连接失败」翻译成用户能动手的一句话。 */
function sshConnectHint(error) {
  const text = String(error || '');
  const kind = classifyNetError(new Error(text));
  if (kind === 'timeout' || /timed out|timeout/i.test(text)) {
    return `${text} · SSH 端口不可达：多半是云安全组没放行这个端口，或本机网络/VPN 拦了出站`;
  }
  if (kind === 'refused') {
    return `${text} · 对方主机在线但端口没开：sshd 没启动，或 SSH 端口不是这个`;
  }
  if (kind === 'reset') {
    return `${text} · 连接被中间设备重置：云防火墙/堡垒机/企业代理可能拦了 SSH`;
  }
  if (kind === 'dns') {
    return `${text} · 地址解析失败：检查 IP/域名是否写错，或本机 DNS 不可用`;
  }
  if (kind === 'unreachable') {
    return `${text} · 网络不可达：检查服务器地址、本机是否连了错误的网段`;
  }
  return text;
}

/* 把「本机出站失败」翻译成用户能动手的一句话（证书签发、DNS API、下载 frps、检查更新都会用到）。
 * 这些请求都是从本机往外连 443，被拦的位置和服务器防火墙无关。 */
function outboundHint(what) {
  const name = what || '请求';
  return `${name}失败时若报超时/连接被重置：先确认本机能不能出网（VPN、公司代理、杀毒软件的网络防护都可能拦 `
    + 'https 出站），必要时把这些域名加白：letsencrypt.org、api.cloudflare.com、github.com、api.github.com。';
}

module.exports = { probePort, probeUdp, classifyNetError, sshConnectHint, outboundHint };
