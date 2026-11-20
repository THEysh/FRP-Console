'use strict';
/* 真机「卸载 frps → 从零初始化」剧本（破坏性，默认不进 CI，也不默认执行）。
 *
 * 会做的事：停 frps、删 /usr/local/bin/frps、删 systemd unit、把配置备份后删除，
 * 然后用产品自己的 server:bootstrap 重新装回来。**期间服务器上的隧道会断**，
 * 所以必须显式加 --yes 才会真的跑：
 *
 *   FRP_REAL_HOST=... FRP_REAL_PASS=... FRP_REAL_TOKEN=... FRP_REAL_DASH_PASS=... \
 *     node tests/real/reinstall.cjs --yes
 *
 * 收尾会核对：四个端口都在听、配置文件权限 600、token 与传入值一致、unit 已 enable。
 */
const cdp = require('../../.e2e/lab/cdp.cjs');
const { Client: SshClient } = require('ssh2');

const HOST = process.env.FRP_REAL_HOST || '';
const PASS = process.env.FRP_REAL_PASS || '';
const TOKEN = process.env.FRP_REAL_TOKEN || '';
const DASH_PASS = process.env.FRP_REAL_DASH_PASS || '';
const PORT = Number(process.env.CDP_PORT || 9349);
const YES = process.argv.includes('--yes');

if (!HOST || !PASS || !TOKEN) {
  console.error('缺参数：FRP_REAL_HOST / FRP_REAL_PASS / FRP_REAL_TOKEN（本脚本会卸载并重装服务器上的 frps）');
  process.exit(2);
}
if (!YES) {
  console.error('这是破坏性剧本：会先卸载服务器上的 frps（隧道中断几十秒）。确认要跑请追加 --yes');
  process.exit(2);
}

function ssh(cmd, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const c = new SshClient();
    c.on('ready', () => c.exec(cmd, { timeout: timeoutMs }, (err, s) => {
      if (err) { c.end(); return reject(err); }
      let out = '';
      s.on('data', (d) => (out += d));
      s.stderr.on('data', (d) => (out += d));
      s.on('close', () => { c.end(); resolve(out.trim()); });
    })).on('error', reject).connect({ host: HOST, port: 22, username: 'root', password: PASS, readyTimeout: 20000 });
  });
}

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail: String(detail).slice(0, 300) });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

(async () => {
  await cdp.waitReady(PORT);

  const conn = await cdp.evalIn(PORT, `(async () => {
    /* adoptProfile: false —— 传的地址与「当前选中的服务器档案」经常对不上（档案可能停在另一台机器上），
     * 不指定的话主进程会以「输入的地址与所选档案不一致」拒绝连接。 */
    const r = await FRP.serverConnect({ host: ${JSON.stringify(HOST)}, port: 22, username: 'root', password: ${JSON.stringify(PASS)}, adoptProfile: false });
    return { ok: !!r.ok, err: String(r.error || '') };
  })()`);
  check('连上服务器', conn.ok === true, conn.err);
  if (!conn.ok) throw new Error('连不上服务器，后面的步骤无法进行');
  await new Promise((r) => setTimeout(r, 1200));

  const un = await cdp.evalIn(PORT, `(async () => { const r = await FRP.serverUninstall(); return { ok: !!r.ok, err: String(r.error || '').slice(0, 200) }; })()`, 120000);
  check('卸载 frps', un.ok === true, un.err);

  const after = await ssh('systemctl is-active frps 2>&1 | head -1; test -f /usr/local/bin/frps && echo bin-yes || echo bin-no; test -f /etc/systemd/system/frps.service && echo unit-yes || echo unit-no');
  check('卸载后服务停了', /inactive|failed|unknown/.test(after), after.replace(/\n/g, ' | '));
  check('卸载后二进制已删除', after.includes('bin-no'), after.replace(/\n/g, ' | '));
  check('卸载后 unit 已删除', after.includes('unit-no'), after.replace(/\n/g, ' | '));

  const fields = {
    bindAddr: '0.0.0.0', bindPort: 7000, authEnabled: true, token: TOKEN,
    webEnabled: true, webAddr: '0.0.0.0', webPort: 4096, webUser: 'admin', webPassword: DASH_PASS,
    vhostHTTPEnabled: true, vhostHTTPPort: 8080, vhostHTTPSEnabled: true, vhostHTTPSPort: 8443, allowPortsText: '',
  };
  const started = Date.now();
  const boot = await cdp.evalIn(PORT, `(async () => {
    const r = await FRP.serverBootstrap(${JSON.stringify(fields)}, { syncLocal: false });
    return { ok: !!r.ok, err: String(r.error || '').slice(0, 300), genToken: (r.data && r.data.generatedToken) || '', genPass: (r.data && r.data.generatedPassword) || '' };
  })()`, 300000);
  check('从零初始化成功', boot.ok === true, `${boot.err}（${((Date.now() - started) / 1000).toFixed(1)}s）`);

  await new Promise((r) => setTimeout(r, 1500));
  const state = await ssh('systemctl is-active frps; systemctl is-enabled frps; ss -lnt | grep -cE ":(7000|4096|8080|8443) "; stat -c %a /etc/frp/frps.toml; grep -c ' + TOKEN + ' /etc/frp/frps.toml');
  const [active, enabled, ports, mode, tokenHit] = state.split('\n').map((s) => s.trim());
  check('初始化后服务在跑', active === 'active', active);
  check('初始化后开机自启', enabled === 'enabled', enabled);
  check('四个端口都在听', Number(ports) === 4, `ports=${ports}`);
  check('配置权限 600', mode === '600', `mode=${mode}`);
  check('token 与传入值一致', Number(tokenHit) >= 1, `hit=${tokenHit}`);
  check('没有悄悄改用户给的 token', boot.genToken === '', `generatedToken=${boot.genToken}`);

  await ssh('systemctl restart frps; sleep 2; systemctl is-active frps').then((v) => check('重启后仍然 active', v.trim() === 'active', v.trim()));

  /* 重装后配置必须「只有一份、值不跑偏」：bindPort 是 7000（历史上被故障注入脚本留过 7001），
   * vhost 两个端口都在，面板口令是这次传进去的那个（1.2.103 之后空口令会自动生成，
   * 所以「口令被悄悄换掉」和「口令为空」都要能发现）。 */
  const after2 = await ssh('grep -E "^(bindPort|vhostHTTPPort|vhostHTTPSPort|subDomainHost) " /etc/frp/frps.toml; grep -c "' + DASH_PASS + '" /etc/frp/frps.toml; ls -1 /etc/frp/frps.toml* | wc -l');
  const lines = after2.split(/\r?\n/).map((s) => s.trim());
  const kv = {};
  for (const l of lines) { const m = /^(bindPort|vhostHTTPPort|vhostHTTPSPort|subDomainHost)\s*=\s*(.+)$/.exec(l); if (m) kv[m[1]] = m[2].replace(/"/g, ''); }
  const passHit = Number(lines.find((l) => /^\d+$/.test(l)) || 0);
  check('bindPort 仍是 7000（没被别的实验带偏）', String(kv.bindPort || '') === '7000', `bindPort=${kv.bindPort}`);
  check('vhost 两个端口都写进去了', String(kv.vhostHTTPPort || '') === '8080' && String(kv.vhostHTTPSPort || '') === '8443', JSON.stringify(kv));
  check('面板口令就是这次传进去的那个', passHit >= 1, `matched=${passHit}`);
  const fileCount = Number(lines[lines.length - 1]) || 0;
  check('配置备份不会被无限堆积（≤10 份）', fileCount >= 1 && fileCount <= 11, `含备份共 ${fileCount} 个文件`);

  const dash = await ssh('curl -s -o /dev/null -w "%{http_code}" -u admin:' + DASH_PASS + ' http://127.0.0.1:4096/api/serverinfo; echo; curl -s -o /dev/null -w "%{http_code}" -u admin:wrong-pass http://127.0.0.1:4096/api/serverinfo');
  const [ok401, okWrong] = dash.split(/\s+/);
  check('面板用新口令能登录', ok401 === '200', `200? ${ok401}`);
  check('面板用错误口令被拒', okWrong === '401', `401? ${okWrong}`);

  await cdp.evalIn(PORT, `(async () => { await FRP.serverDisconnect(); return 1; })()`).catch(() => {});

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n合计 ${checks.length}：通过 ${checks.length - failed.length} / 失败 ${failed.length}`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('ERR', String((e && e.message) || e).slice(0, 300));
  process.exit(1);
});
