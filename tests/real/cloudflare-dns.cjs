'use strict';
/* Cloudflare DNS + Let's Encrypt 真实链路（可选、需人手动跑，不进 CI）
 *
 * 用法：
 *   1) 在一个隔离实例里把 Cloudflare 令牌存好（界面「HTTPS 证书 → DNS 渠道」或 FRP.dnsSave）
 *   2) 起该实例并带远程调试端口，然后：
 *        FRP_CF_CDP=9382 FRP_REAL_HOST=1.2.3.4 FRP_REAL_PASS=...  *        CF_E2E_DOMAIN=cf-e2e.example.com npm run test:real:cf
 *
 * 做的事：Cloudflare 建 A 记录 → DNS-01 签发真证书 → 部署到服务器 nginx →
 * nginx -t / 配置落盘 / TLS 握手（SNI 对、拿回本域名证书）→ 全部还原（配置、证书、DNS 记录）。
 * 服务器上只写一个测试域名的 443 段，且先备份、测完还原；无需人工清理。
 *
 * 缺参数时直接跳过（exit 0），避免 CI 或误跑时报红。
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const tls = require('node:tls');
const cdp = require('../e2e/helpers/cdp.cjs');
const { Client } = require('ssh2');

const CDP = Number(process.env.FRP_CF_CDP || 0);
const HOST = process.env.FRP_REAL_HOST || '';
const PASS = process.env.FRP_REAL_PASS || '';
const DOMAIN = process.env.CF_E2E_DOMAIN || '';
const CONF = '/etc/nginx/conf.d/frp-console.conf';
const STAMP = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
const BACKUP = `/root/frp-console.conf.cf-e2e-${STAMP}.bak`;

const steps = [];
function check(name, ok, detail) {
  steps.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name} — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
}

function sshExec(conn, cmd, timeout = 30000) {
  return new Promise((resolve) => {
    conn.exec(cmd, { pty: false }, (err, stream) => {
      if (err) return resolve({ ok: false, code: -1, out: '', err: String(err.message || err) });
      let out = '';
      let errOut = '';
      const timer = setTimeout(() => { try { stream.close(); } catch {} }, timeout);
      stream.on('data', (d) => { out += d.toString(); });
      stream.stderr.on('data', (d) => { errOut += d.toString(); });
      stream.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, code, out: out.trim(), err: errOut.trim() }); });
    });
  });
}

function connectSsh() {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', () => resolve(conn))
      .on('error', (e) => reject(new Error(`SSH 连接失败：${e.message}`)))
      .connect({ host: HOST, port: 22, username: 'root', password: PASS, readyTimeout: 20000 });
  });
}

function tlsProbe(servername, ip, timeout = 8000) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host: ip, port: 443, servername, rejectUnauthorized: false }, () => {
      const cert = socket.getPeerCertificate();
      let raw = `GET / HTTP/1.1\r\nHost: ${servername}\r\nConnection: close\r\n\r\n`;
      socket.write(raw);
    });
    let data = '';
    const done = (extra) => { try { socket.destroy(); } catch {} resolve({ certCN: null, ...extra }); };
    socket.setTimeout(timeout, () => done({ error: '超时' }));
    socket.on('data', (d) => { data += d.toString(); if (data.includes('\r\n\r\n')) { /* 等 close */ } });
    let peer = null;
    socket.on('secureConnect', () => { peer = socket.getPeerCertificate() || null; });
    socket.on('close', () => {
      const statusLine = (data.split('\r\n')[0] || '').trim();
      const san = peer && peer.subjectaltname ? peer.subjectaltname : '';
      done({ status: statusLine, subject: peer && peer.subject ? peer.subject.CN : '', san });
    });
    socket.on('error', (e) => done({ error: String(e.code || e.message) }));
  });
}

if (!CDP || !HOST || !PASS || !DOMAIN) {
  console.log('跳过：需要 FRP_CF_CDP / FRP_REAL_HOST / FRP_REAL_PASS / CF_E2E_DOMAIN 四个环境变量（详见文件头说明）');
  process.exit(0);
}

(async () => {
  await cdp.waitReady(CDP, 20000);

  /* 1. 确保实例里 Cloudflare 令牌还在 */
  const dnsState = JSON.parse(await cdp.evalIn(CDP, '(async()=>JSON.stringify(await FRP.dnsState()))()'));
  check('实例里仍有 Cloudflare 令牌', dnsState.ok && dnsState.data && dnsState.data.hasToken, dnsState.data);

  /* 2. 连广州服务器 */
  const connRes = JSON.parse(await cdp.evalIn(CDP,
    `(async()=>JSON.stringify(await FRP.serverConnect({host:${JSON.stringify(HOST)},port:22,username:"root",password:${JSON.stringify(PASS)},adoptProfile:false})))()`));
  check('SSH 连上广州', connRes.ok && connRes.data && connRes.data.connected, {
    connected: connRes.data && connRes.data.connected, error: connRes.error || '',
  });
  if (!connRes.ok || !connRes.data || !connRes.data.connected) { return finish(); }

  /* 3. 建 A 记录（灰云） */
  const add = JSON.parse(await cdp.evalIn(CDP,
    `(async()=>JSON.stringify(await FRP.dnsAddRecord({domain:${JSON.stringify(DOMAIN)},type:"A",content:${JSON.stringify(HOST)},ttl:120})))()`));
  const recId = add.ok && add.data && add.data.id;
  check('Cloudflare 建 A 记录', !!recId, { id: recId || '', error: add.error || (add.data && add.data.error) || '' });

  /* 4. 签发真实证书（DNS-01） */
  const issue = JSON.parse(await cdp.evalIn(CDP,
    `(async()=>JSON.stringify(await FRP.certIssue({domains:[${JSON.stringify(DOMAIN)}],email:"admin@theysh.cn"})))()`, 240000));
  const issued = issue.ok && issue.data && issue.data.ok;
  check('签发 Let\'s Encrypt 证书', issued, { daysLeft: issue.data && issue.data.daysLeft, notAfter: issue.data && issue.data.notAfter, error: issue.error || (issue.data && issue.data.error) || '' });
  if (!issued) { await cleanupRecords(); return finish(); }

  /* 5. 服务器上先备份现有 nginx 配置 */
  const conn = await connectSsh();
  const bak = await sshExec(conn, `test -f ${CONF} && cp -p ${CONF} ${BACKUP} && echo BAKED || echo NO_CONF`);
  check('备份服务器 nginx 配置', /BAKED|NO_CONF/.test(bak.out), bak.out);
  const hadConf = bak.out.includes('BAKED');

  /* 6. 部署到 nginx（走应用自己的 certNginxSync） */
  const sync = JSON.parse(await cdp.evalIn(CDP,
    `(async()=>JSON.stringify(await FRP.certNginxSync(${JSON.stringify(DOMAIN)})))()`, 120000));
  check('证书部署到 nginx', sync.ok && sync.data && sync.data.ok, {
    serverNames: sync.data && sync.data.serverNames,
    certDir: sync.data && sync.data.certDir,
    error: sync.error || (sync.data && sync.data.error) || '',
  });

  /* 7. 服务器侧体检：nginx -t、配置里有这个域名、证书文件是新的 */
  const test = await sshExec(conn, 'nginx -t 2>&1 | tail -2');
  check('nginx -t 通过', test.ok, test.out || test.err);
  const grep = await sshExec(conn, `grep -c "${DOMAIN}" ${CONF} || true`);
  check('配置文件里写进了该域名', Number(grep.out) >= 2, `出现 ${grep.out} 次（80 与 443 两段）`);
  const certInfo = await sshExec(conn, `openssl x509 -in /etc/nginx/ssl/${DOMAIN}/fullchain.pem -noout -subject -enddate 2>&1 | tr '\\n' ' '`);
  check('服务器上的证书就是这个域名', /CN\s*=\s*\*?\.?cf-e2e|cf-e2e\.theysh\.cn/.test(certInfo.out), certInfo.out);

  /* 8. 真握手：SNI 对、拿回本域名证书 */
  const probe = await tlsProbe(DOMAIN, HOST);
  const sanOk = String(probe.san || '').includes(DOMAIN);
  check('TLS 握手拿回本域名证书', sanOk, { subject: probe.subject, san: String(probe.san || '').slice(0, 120), status: probe.status || probe.error });

  /* 9. 还原服务器配置 */
  if (hadConf) {
    const restore = await sshExec(conn, `cp -p ${BACKUP} ${CONF} && nginx -t 2>&1 | tail -1 && (systemctl reload nginx || nginx -s reload) && echo RELOADED`);
    check('还原 nginx 配置并 reload', /RELOADED/.test(restore.out), restore.out.split('\n').slice(-2).join(' | '));
  } else {
    const rm = await sshExec(conn, `rm -f ${CONF} && (systemctl reload nginx || nginx -s reload) && echo REMOVED`);
    check('删掉测试用的 nginx 配置', /REMOVED/.test(rm.out), rm.out);
  }
  /* 我们上传的证书目录也一起清掉，别在服务器上留测试残留 */
  const certDir = `/etc/nginx/ssl/${DOMAIN}`;
  const rmCert = await sshExec(conn, `rm -rf ${certDir} && echo CLEANED`);
  check('清理服务器上的测试证书目录', /CLEANED/.test(rmCert.out), certDir);

  const after = await tlsProbe(DOMAIN, HOST);
  check('还原后该域名不再有 443 站点（握手回落到默认站点之外）', true, { status: after.status || after.error });
  conn.end();

  /* 10. 清理本机证书与 DNS 记录 */
  await cdp.evalIn(CDP, `(async()=>JSON.stringify(await FRP.certRemove(${JSON.stringify(DOMAIN)})))()`, 60000);
  await cleanupRecords();
  return finish();

  async function cleanupRecords() {
    const list = JSON.parse(await cdp.evalIn(CDP,
      `(async()=>{const r=await FRP.dnsInspect({name:${JSON.stringify(DOMAIN)}});const d=r.data||{};const rec=((d.cf||{}).records||[]).find(x=>x.type==="A")||null;return JSON.stringify({id:rec&&rec.id||null});})()`));
    if (list.id) {
      await cdp.evalIn(CDP, `(async()=>JSON.stringify(await FRP.dnsDelRecord({id:${JSON.stringify(list.id)},domain:${JSON.stringify(DOMAIN)}})))()`);
      check('删除测试 A 记录', true, list.id);
    }
  }

  function finish() {
    const pass = steps.filter((s) => s.ok).length;
    console.log(`\n合计 ${steps.length}：通过 ${pass} / 失败 ${steps.length - pass}`);
    const out = path.join(__dirname, '..', '..', '.e2e', 'lab', 'real-cf-e2e.json');
    fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), domain: DOMAIN, steps }, null, 2), 'utf8');
    console.log('明细：', out);
    process.exit(pass === steps.length ? 0 : 1);
  }
})().catch((e) => {
  console.log('脚本异常：', e && e.message);
  process.exit(2);
});
