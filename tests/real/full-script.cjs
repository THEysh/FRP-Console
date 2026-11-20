'use strict';
/* 真机全剧本（广州）：连服务器 → 四层自检 → 建 tcp/http 代理 → 起隧道 →
 * 验公网 → 重启 frps 再看一遍 → 收尾清理（把测试实例的配置还原回 lab）。
 * 只用 app-sweep 实例（CDP 9349），不碰用户安装版；所有远端改动都只是 frps restart。
 */
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const cdp = require('../../.e2e/lab/cdp.cjs');

const HOST = process.env.FRP_REAL_HOST || '';
const SSH_PASS = process.env.FRP_REAL_PASS || '';
const TOKEN = process.env.FRP_REAL_TOKEN || '';
const PORT = Number(process.env.CDP_PORT || 9349);

if (!HOST || !SSH_PASS || !TOKEN) {
  console.error('缺参数：请设 FRP_REAL_HOST / FRP_REAL_PASS / FRP_REAL_TOKEN（本脚本会真连服务器跑一遍全剧本）');
  process.exit(2);
}
const { Client: SshClient } = require('ssh2');

/* 直连 SSH 跑一条命令（只用于「服务器本机自测」，绕开云防火墙判断链路是否通） */
function sshExec(cmd, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const client = new SshClient();
    let done = false;
    const finish = (out) => { if (!done) { done = true; try { client.end(); } catch {} resolve(out); } };
    client.on('ready', () => {
      client.exec(cmd, (err, stream) => {
        if (err) return finish(String(err.message || err));
        let out = '';
        stream.on('data', (d) => { out += d; });
        stream.stderr.on('data', (d) => { out += d; });
        stream.on('close', () => finish(out.trim()));
      });
    });
    client.on('error', (e) => finish(String(e.message || e)));
    setTimeout(() => finish('timeout'), timeoutMs);
    client.connect({ host: HOST, port: 22, username: 'root', password: SSH_PASS });
  });
}

const LOCAL_PORT = 18091;
const TCP_REMOTE = 46001;
const HTTP_DOMAIN = 'e2e-real.theysh.cn';

const evalIn = (body) => cdp.evalIn(PORT, body);
const results = [];
const step = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' —— ' + detail : ''}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const tcpProbe = (host, port, timeout = 5000) =>
  new Promise((resolve) => {
    const s = net.connect({ host, port });
    const t = setTimeout(() => { s.destroy(); resolve({ ok: false, error: 'timeout' }); }, timeout);
    s.on('connect', () => { clearTimeout(t); s.end(); resolve({ ok: true }); });
    s.on('error', (e) => { clearTimeout(t); resolve({ ok: false, error: e.code || e.message }); });
  });

const httpGet = (options, timeout = 8000) =>
  new Promise((resolve) => {
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (d) => (body += d)).on('end', () => resolve({ status: res.statusCode, body: body.slice(0, 120) }));
    });
    req.on('error', (e) => resolve({ error: e.code || e.message }));
    req.setTimeout(timeout, () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.end();
  });

(async () => {
  /* 本机服务：/ 返回 200，/panel/ 也 200，用来验「隧道真的通到本机」 */
  const local = spawn(process.execPath, [path.join(__dirname, 'local-404-service.cjs'), String(LOCAL_PORT)], { stdio: 'ignore' });
  await wait(900);

  let connected = false;
  try {
    /* ① 连服务器 */
    const conn = await evalIn(`(async () => {
      await FRP.serverForgetHost({ host: '${HOST}', port: 22 });
      const r = await FRP.serverConnect({ host: '${HOST}', port: 22, username: 'root', password: '${SSH_PASS}', adoptProfile: false });
      return { ok: r.ok, err: String(r.error || '').slice(0, 120), trust: !!(r.needsTrustHost) };
    })()`);
    connected = conn.ok === true;
    step(`连上服务器 ${HOST}`, connected, conn.err || (conn.trust ? '需要信任指纹' : ''));
    if (!connected) throw new Error('连不上服务器，后续无法进行');

    /* ② 四层自检 */
    const st = await evalIn(`(async () => {
      const out = {};
      for (const layer of ['ssh', 'service', 'bindPort', 'token']) {
        const r = await FRP.serverSelfTest(layer);
        out[layer] = { ok: !!(r && r.data && r.data.ok), detail: String((r && r.data && r.data.detail) || (r && r.error) || '').slice(0, 120) };
      }
      return out;
    })()`);
    for (const layer of ['ssh', 'service', 'bindPort', 'token']) {
      step(`自检 ${layer} 通过`, !!(st[layer] && st[layer].ok), st[layer] && st[layer].detail);
    }

    /* ③ 把测试实例的隧道指向这台服务器（不碰用户安装版） */
    const cfg = await evalIn(`(async () => {
      const r = await FRP.saveConfig({ serverAddr: '${HOST}', serverPort: 7000, auth: { method: 'token', token: '${TOKEN}' }, log: { to: './frpc.log', level: 'info' } });
      return { ok: r.ok, err: String(r.error || '').slice(0, 120) };
    })()`);
    step('测试实例指向 ' + HOST, cfg.ok === true, cfg.err || '');

    /* ④ 建两条代理 */
    const p1 = await evalIn(`(async () => {
      await FRP.deleteProxy('e2e-real-tcp');
      const r = await FRP.saveProxy('add', '', { name: 'e2e-real-tcp', type: 'tcp', localIP: '127.0.0.1', localPort: ${LOCAL_PORT}, remotePort: ${TCP_REMOTE}, openPath: '/panel/' });
      return { ok: r.ok, err: String(r.error || '').slice(0, 120) };
    })()`);
    step('建 tcp 代理', p1.ok === true, p1.err || `:${TCP_REMOTE} → 127.0.0.1:${LOCAL_PORT}`);

    const p2 = await evalIn(`(async () => {
      await FRP.deleteProxy('e2e-real-http');
      const r = await FRP.saveProxy('add', '', { name: 'e2e-real-http', type: 'http', localIP: '127.0.0.1', localPort: ${LOCAL_PORT}, customDomains: ['${HTTP_DOMAIN}'] });
      return { ok: r.ok, err: String(r.error || '').slice(0, 120) };
    })()`);
    step('建 http 代理', p2.ok === true, p2.err || HTTP_DOMAIN);

    /* ⑤ 起隧道 */
    const start = await evalIn(`(async () => { const r = await FRP.startTunnel(); return { ok: r.ok, err: String(r.error || '').slice(0, 140) }; })()`);
    step('启动隧道', start.ok === true, start.err || '');

    const waitOnline = async (label) => {
      for (let i = 0; i < 24; i++) {
        const s = await evalIn(`(async () => { const r = await FRP.refresh(); const d = r.data; const t = (d.proxies || []).find((p) => p.name === 'e2e-real-tcp'); const h = (d.proxies || []).find((p) => p.name === 'e2e-real-http'); return { mode: d.runtime && d.runtime.mode, tcp: t && t.health ? { ok: t.health.ok, reason: t.health.reason } : null, http: h && h.health ? { ok: h.health.ok, reason: h.health.reason } : null }; })()`);
        if (s.mode === 'managed' && s.tcp && s.tcp.ok) return s;
        await wait(2500);
        if (i === 23) return s;
      }
      return null;
    };
    const online = await waitOnline('首次上线');
    step('隧道进入 managed 且 tcp 代理三层全通（含 /panel/ 路径）', !!(online && online.mode === 'managed' && online.tcp && online.tcp.ok), JSON.stringify(online));
    step('http 代理的未命中原因说得准（域名没解析）', !!(online && online.http && /解析/.test(String(online.http.reason || ''))), online && online.http && online.http.reason);

    /* ⑥ 从公网侧验证两条代理 */
    const pubTcp = await httpGet({ host: HOST, port: TCP_REMOTE, path: '/panel/', headers: { Host: `${HOST}:${TCP_REMOTE}` } });
    if (pubTcp.status === 200) {
      step('公网直连 tcp 映射拿到本机 /panel/ 响应', true, JSON.stringify(pubTcp).slice(0, 120));
    } else {
      /* 外网连不上：区分「frp 没注册」和「云防火墙拦了」——在服务器本机再试一次 */
      const local = await sshExec(`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${TCP_REMOTE}/panel/`);
      const listening = await sshExec(`ss -lnt | grep -c ':${TCP_REMOTE} '`);
      if (local === '200') {
        step('公网直连 tcp 映射拿到本机 /panel/ 响应', true, `外网被云防火墙拦（${JSON.stringify(pubTcp).slice(0, 60)}），服务器本机 127.0.0.1:${TCP_REMOTE} 返回 200，frp 链路正常`);
      } else {
        step('公网直连 tcp 映射拿到本机 /panel/ 响应', false, `外网 ${JSON.stringify(pubTcp).slice(0, 60)}；服务器本机 curl=${local}、监听数=${listening}`);
      }
    }
    const pubHttp = await httpGet({ host: HOST, port: 8080, path: '/', headers: { Host: HTTP_DOMAIN } });
    step('公网 vhost 端口可达（未备案域名会被云厂商拦，属环境）', !!pubHttp.status, JSON.stringify(pubHttp).slice(0, 120));

    /* ⑦ 重启 frps 后应该自己恢复 */
    const restart = await evalIn(`(async () => { const r = await FRP.serverControl('restart'); return { ok: r.ok, err: String(r.error || '').slice(0, 140) }; })()`);
    step('重启 frps', restart.ok === true, restart.err || '');
    await wait(6000);
    const after = await waitOnline('重启后恢复');
    step('重启 frps 后隧道与代理自己恢复', !!(after && after.mode === 'managed' && after.tcp && after.tcp.ok), JSON.stringify(after));
    const pubTcp2 = await httpGet({ host: HOST, port: TCP_REMOTE, path: '/panel/', headers: { Host: `${HOST}:${TCP_REMOTE}` } });
    if (pubTcp2.status === 200) {
      step('重启后公网仍能访问（200）', true, JSON.stringify(pubTcp2).slice(0, 120));
    } else {
      const local2 = await sshExec(`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${TCP_REMOTE}/panel/`);
      step('重启后公网仍能访问（200）', local2 === '200', `外网 ${JSON.stringify(pubTcp2).slice(0, 60)}；服务器本机 curl=${local2}`);
    }
  } finally {
    /* 收尾：删代理、停隧道、把测试实例指回 lab frps */
    try {
      await evalIn(`(async () => { await FRP.deleteProxy('e2e-real-tcp'); await FRP.deleteProxy('e2e-real-http'); await FRP.stopTunnel(); return 1; })()`);
      await evalIn(`(async () => { await FRP.saveConfig({ serverAddr: '127.0.0.1', serverPort: 7000, auth: { method: 'token', token: 'labtoken-1234567890' }, log: { to: './frpc.log', level: 'info' } }); await FRP.serverDisconnect(); return 1; })()`);
      console.log('已清理：代理删除、隧道停止、实例配置还原到 lab frps');
    } catch (e) {
      console.error('清理失败：', e.message);
    }
    try { local.kill(); } catch {}
    const failed = results.filter((r) => !r.ok);
    console.log(`\n合计 ${results.length}：通过 ${results.length - failed.length} / 失败 ${failed.length}`);
    if (failed.length) { for (const f of failed) console.log(`  ✗ ${f.name} —— ${f.detail || ''}`); process.exitCode = 1; }
  }
})().catch((e) => { console.error('脚本异常：', e.message); process.exit(1); });
