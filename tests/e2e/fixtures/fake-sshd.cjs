// 本地假 SSH 服务器：只回放固定输出，用来在没有 Linux 机器的情况下跑通「服务器」页。
// 用法：node .e2e/lab/fake-sshd.cjs [port] [mode]
//   mode = mixed（默认，同时有 frpc.service 与 frps.service，且 frpc 排在前面）
//        | frponly（只有一个名字含糊的 frp.service，ExecStart 指向 frps）
//        | nosystemd（只有进程，没有 systemd unit）
const crypto = require('node:crypto');
const { Server } = require('ssh2');

const port = Number(process.argv[2] || 2222);
const mode = process.argv[3] || 'mixed';
const hostname = process.argv[4] || 'lab-server';
const token = process.argv[5] || 'labtoken-1234567890';
const nginxVersion = process.argv[6] || '';   // 非空 = 假装装了 nginx（用于验证 nginx 卡片刷新）
const firewallMode = !!process.argv[7];        // 非空 = 假装装了 ufw 且 active（用于验证防火墙放行）
/* argv[8]：`ss -lnt/-lun` 里“正在监听”的端口（逗号分隔），端口矩阵的 S1 信号用它；
 * 留空 = 不回报监听（矩阵里 listen 为「—」）。 */
const listenTcp = (process.argv[8] || '').split(',').map((s) => s.trim()).filter(Boolean);
/* argv[9]：初始 ufw 规则（逗号分隔，支持 7000/tcp、1:65535/tcp），用来构造 fw-blocked / cloud-blocked 场景。 */
const seedRules = (process.argv[9] || '').split(',').map((s) => s.trim()).filter(Boolean);
/* argv[10]：frps 的 bindPort。默认 7000，但 e2e runner 起的真 frps 在 17000，
 * 两边不一致时「bindPort 自检」就会既说“服务器在听”又连不上——那个检查要的是
 * 「服务器说在听 + 客户端真能连上」两条同时成立，所以这里必须跟 runner 对齐，
 * 否则场景就偷偷依赖本机恰好有别的东西占着 7000。 */
const bindPort = Number(process.argv[10]) || 7000;
/* argv[11]：frps -v 回什么版本号（用来验证「服务器 frps 与本机 frpc 版本不一致」的提示）。 */
const frpsVersion = process.argv[11] || '0.61.0';
const fwRules = firewallMode
  ? new Set(seedRules.length ? seedRules : ['22/tcp', '7000/tcp', '7000/udp', '28487/tcp', '1:65535/tcp'])
  : new Set();
const USER = 'root';
const PASS = 'labpass';

const hostKey = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;

const SERVICE_LINES = {
  mixed: [
    '  frpc.service          loaded active running frp client for this host',
    '  frps.service          loaded active running frp server',
  ],
  frponly: [
    '  frp.service           loaded active running frp',
  ],
  nosystemd: [],
};

function inspectScript() {
  if (mode === 'empty') {
    // 模拟「服务器上还没有 frps」：无进程、无二进制、无配置、无 unit。
    return [
      '@@HOSTNAME', hostname,
      '@@OS', 'Debian GNU/Linux 12 (bookworm)',
      '@@KERNEL', '6.1.0-18-amd64',
      '@@ARCH', 'x86_64',
      '@@UPTIME', 'up 1 day, 2 hours',
      '@@SERVICE',
      '@@PROCESS',
      '@@BIN',
      '@@LISTEN',
      '@@DOCKER',
      '@@CONFIG',
      '',
    ].join('\n');
  }
  const service = SERVICE_LINES[mode] || [];
  return [
    '@@HOSTNAME',
    hostname,
    '@@OS',
    'Debian GNU/Linux 12 (bookworm)',
    '@@KERNEL',
    '6.1.0-18-amd64',
    '@@ARCH',
    'x86_64',
    '@@UPTIME',
    'up 3 days, 2 hours',
    '@@SERVICE',
    ...service,
    '@@PROCESS',
    '1234 /usr/local/bin/frps -c /etc/frp/frps.toml',
    '@@BIN',
    '/usr/local/bin/frps',
    '@@LISTEN',
    `LISTEN 0 4096 0.0.0.0:${bindPort} 0.0.0.0:* users:(("frps",pid=1234,fd=5))`,
    'LISTEN 0 4096 0.0.0.0:7500 0.0.0.0:* users:(("frps",pid=1234,fd=7))',
    '@@DOCKER',
    '@@CONFIG',
    '/etc/frp/frps.toml',
    '',
  ].join('\n');
}

const JOURNAL = [
  'Nov 13 20:00:01 lab-server frps[1234]: start frps success',
  `Nov 13 20:00:01 lab-server frps[1234]: frps tcp listen on 0.0.0.0:${bindPort}`,
  'Nov 13 20:00:02 lab-server frps[1200]: [lab] login success',
  'Nov 13 20:00:09 lab-server frps[1200]: [lab] start proxy success',
  '',
].join('\n');

const EXEC_START = {
  frps: 'ExecStart=/usr/local/bin/frps -c /etc/frp/frps.toml',
  frpc: 'ExecStart=/usr/local/bin/frpc -c /etc/frp/frpc.toml',
  frp: 'ExecStart=/usr/local/bin/frps -c /etc/frp/frps.toml',
};

const FRPS_TOML = [
  'bindAddr = "0.0.0.0"',
  `bindPort = ${bindPort}`,
  '',
  'auth.method = "token"',
  'auth.token = "' + token + '"',
  /* 用 FAKE_VHOST_PORTS="8080,8443" 造「服务器已开 vhost 端口」的场景（部署证书时不用改写 frps.toml） */
  ...(() => {
    const raw = process.env.FAKE_VHOST_PORTS;
    if (!raw) return [];
    const [http, https] = String(raw).split(',');
    return [
      Number(http) > 0 ? `vhostHTTPPort = ${Number(http)}` : '',
      Number(https) > 0 ? `vhostHTTPSPort = ${Number(https)}` : '',
    ].filter(Boolean);
  })(),
  /* 用 FAKE_SUB_DOMAIN_HOST="frp.example.com" 造「服务器开了 subdomain」的场景 */
  ...(process.env.FAKE_SUB_DOMAIN_HOST ? [`subDomainHost = "${process.env.FAKE_SUB_DOMAIN_HOST}"`] : []),
  '',
  /* 用 FAKE_FRPS_WEB="addr:port:user:password" 造「面板暴露」这类场景 */
  ...(() => {
    const raw = process.env.FAKE_FRPS_WEB;
    if (!raw) return ['webServer.addr = "127.0.0.1"', 'webServer.port = 7500', 'webServer.user = "admin"', 'webServer.password = "labpass"'];
    const [addr, port, user, ...rest] = raw.split(':');
    return [
      `webServer.addr = "${addr}"`,
      `webServer.port = ${Number(port) || 7500}`,
      `webServer.user = "${user || 'admin'}"`,
      `webServer.password = "${rest.join(':')}"`,
    ];
  })(),
  /* 用 FAKE_ALLOW_PORTS="20000,20001" 造「服务器只允许这几个公网端口」的场景：
   * frps 的 allowPorts 会限制 frpc 能用哪些 remotePort，端口建议/随机必须尊重它。 */
  ...(() => {
    const raw = process.env.FAKE_ALLOW_PORTS;
    if (!raw) return [];
    const parts = raw
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
    if (!parts.length) return [];
    return ['', 'allowPorts = [' + parts.join(', ') + ']'];
  })(),
  '',
].join('\n');

// 每条都是 [正则, 处理函数]；命令里可能带引号，正则按子串匹配即可。
const RULES = [
  // 先匹配“整段脚本”类命令：inspect 那条里也含 cat/frps.toml 字样，
  // 顺序错了会被下面的 cat 规则截胡。
  [/@@HOSTNAME/, () => [0, inspectScript()]],
  /* readListenPorts（端口矩阵 S1 信号）：命令以 `echo @@TCP` 开头，必须排在通用 ss 规则之前。 */
  [/echo @@TCP/, () => [0, ['@@TCP', ...listenTcp.map((p) => `0.0.0.0:${p}`), '@@UDP', ''].join('\n')]],
  // 组合脚本（用例按 @@ 分段解析的那几条）
  [/@@ACTIVE/, () => [0, ['@@ACTIVE', 'active', '@@ENABLED', 'enabled', '@@PROC', '/proc/1234', '@@DOCKER', ''].join('\n')]],
  [/@@SS/, () => [0, ['@@SS', `LISTEN 0 4096 0.0.0.0:${bindPort} 0.0.0.0:*`, ''].join('\n')]],
  [/^echo ok/, () => [0, 'ok\n']],
  /* 配置体检（1.2.72 checkNginxHealth）回放：
   * - grep 那条列出所有 ssl_certificate 引用（FAKE_CERT_MISSING 里列的路径当作「文件不存在」）
   * - 批量 test -e 那条按同一份名单回 MISSING
   * - cat 我们的 frp-console.conf 要给出一份带 443 块的配置，修复链路才有东西可摘 */
  [/grep -rnoE .*ssl_certificate/, () => {
    const missing = (process.env.FAKE_CERT_MISSING || '').split(',').map((s) => s.trim()).filter(Boolean);
    /* 只属于「别人家配置」的悬空引用（验证 1.2.73 的查看 / 注释掉这条引用）。 */
    const foreignMissing = (process.env.FAKE_CERT_FOREIGN_MISSING || '').split(',').map((s) => s.trim()).filter(Boolean);
    const lines = [
      '/etc/nginx/conf.d/frp-console.conf:12:    ssl_certificate /etc/nginx/ssl/ok.local/fullchain.pem;',
      '/etc/nginx/conf.d/frp-console.conf:13:    ssl_certificate_key /etc/nginx/ssl/ok.local/key.pem;',
    ];
    for (const p of missing) {
      lines.push(`/etc/nginx/conf.d/frp-console.conf:20:    ssl_certificate ${p};`);
      lines.push(`/etc/nginx/conf.d/frp-console.conf:21:    ssl_certificate_key ${p.replace(/fullchain\.pem$/, 'key.pem')};`);
    }
    for (const p of foreignMissing) {
      lines.push(`/www/server/panel/vhost/nginx/bt.local.conf:9:  ssl_certificate ${p};`);
    }
    if (process.env.FAKE_CERT_FOREIGN === '1') {
      lines.push('/www/server/panel/vhost/nginx/bt.local.conf:9:  ssl_certificate /www/server/panel/vhost/cert/bt.local/fullchain.pem;');
    }
    return [0, `${lines.join('\n')}\n`];
  }],
  /* 别家配置内容（readConfAround 用） */
  [/^cat '.*bt\.local\.conf'/, () => [0, [
    'server {',
    '    listen 443 ssl;',
    '    server_name bt.local;',
    '    ssl_certificate /www/server/panel/vhost/cert/bt.local/fullchain.pem;',
    '    ssl_certificate_key /www/server/panel/vhost/cert/bt.local/key.pem;',
    '    location / { proxy_pass http://127.0.0.1:8080; }',
    '}',
    '',
  ].join('\n')]],
  [/\[ -e '/, (cmd) => {
    const missing = new Set(`${process.env.FAKE_CERT_MISSING || ''},${process.env.FAKE_CERT_FOREIGN_MISSING || ''}`
      .split(',').map((s) => s.trim()).filter(Boolean)
      .flatMap((p) => [p, p.replace(/fullchain\.pem$/, 'key.pem')]));
    const paths = [...String(cmd).matchAll(/-e '([^']+)'/g)].map((m) => m[1]);
    const out = paths.filter((p) => missing.has(p)).map((p) => `MISSING ${p}`).join('\n');
    return [0, `${out}${out ? '\n' : ''}`];
  }],
  /* 写前校验（1.2.72 writeNginxProxyConfig）：FAKE_CERT_FILES_MISSING=1 时假装证书文件不在 */
  [/CERT_OK/, () => (process.env.FAKE_CERT_FILES_MISSING === '1'
    ? [0, 'CERT_MISSING\nKEY_MISSING\n']
    : [0, 'CERT_OK\nKEY_OK\n'])],
  [/^cat '.*frp-console\.conf'/, () => [0, [
    'server {',
    '    listen 80;',
    '    server_name ok.local;',
    '    location / { proxy_pass http://127.0.0.1:8080; }',
    '}',
    '',
    'server {',
    '    listen 443 ssl;',
    '    server_name ok.local;',
    '    ssl_certificate /etc/nginx/ssl/ok.local/fullchain.pem;',
    '    ssl_certificate_key /etc/nginx/ssl/ok.local/key.pem;',
    '    location / { proxy_pass http://127.0.0.1:8080; }',
    '}',
    '',
    ...(process.env.FAKE_CERT_MISSING || '').split(',').map((s) => s.trim()).filter(Boolean).flatMap((p) => [
      'server {',
      '    listen 443 ssl;',
      '    server_name gone.local;',
      `    ssl_certificate ${p};`,
      `    ssl_certificate_key ${p.replace(/fullchain\.pem$/, 'key.pem')};`,
      '    location / { proxy_pass http://127.0.0.1:8080; }',
      '}',
    ]),
    '',
  ].join('\n')]],
  // readConfig 用的是 `cat '<path>'`
  [/^cat '/, () => [0, FRPS_TOML]],
  [/systemctl cat .*frpc/, () => [0, `${EXEC_START.frpc}\n`]],
  [/systemctl cat .*frps/, () => [0, `${EXEC_START.frps}\n`]],
  [/systemctl cat .*frp/, () => [0, `${EXEC_START.frp}\n`]],
  [/systemctl is-active/, () => (mode === 'nosystemd' ? [1, ''] : [0, 'active\n'])],
  [/systemctl is-enabled/, () => [0, 'enabled\n']],
  /* 被 mask 的单元：systemctl list-units 不会列出来，只有 list-unit-files 里能看到 'masked'。
   * 用 FAKE_MASKED_UNIT=frps.service 造这个场景（配合 mode=empty，即机器上没有可用的 unit）。 */
  [/list-unit-files/, () => [0, process.env.FAKE_MASKED_UNIT ? `${process.env.FAKE_MASKED_UNIT} masked\n` : '']],
  [/systemctl daemon-reload|systemctl enable|systemctl restart|systemctl start/, () => [0, '']],
  [/journalctl -u/, () => [0, JOURNAL]],
  // nginx 检测（detectNginx 用）：nginxVersion 非空时假装已装并占 80/443，否则装没装。
  [/command -v nginx/, () => (nginxVersion ? [0, '/usr/sbin/nginx\n'] : [1, ''])],
  [/nginx -v/, () => (nginxVersion ? [0, `nginx version: ${nginxVersion}\n`] : [1, ''])],
  [/ss -lntp .*80\|443|ss -lntp/, () => {
    if (!nginxVersion) return [0, ''];
    /* FAKE_NGINX_HTTP_ONLY=1：装了 nginx 但只监听 80（没有配 https），
     * 用来验证 1.2.73「443 未启用」不该被当成故障。 */
    if (process.env.FAKE_NGINX_HTTP_ONLY === '1') {
      return [0, 'LISTEN 0 128 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=888,fd=6))\n'];
    }
    return [0, 'LISTEN 0 128 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=888,fd=6))\nLISTEN 0 128 0.0.0.0:443 0.0.0.0:* users:(("nginx",pid=888,fd=7))\n'];
  }],
  [/-f '?\/etc\/frp\/frps\.toml'?/, () => [0, 'yes\n']],
  // 「command -v frps && frps -v」这条要排在 command -v 前面，否则会被当成“只查路径”
  [/frps['" ]*(-v|verify)/, () => (mode === 'empty' ? [1, ''] : [0, `${frpsVersion}\n`])],
  [/command -v frps/, () => (mode === 'empty' ? [1, ''] : [0, '/usr/local/bin/frps\n'])],
  [/test -f /, () => [0, 'yes\n']],
  [/\[ -d \/run\/systemd\/system \]/, () => (mode === 'nosystemd' ? [1, ''] : [0, 'yes\n'])],
  [/id -u/, () => [0, '0\n']],
  [/sudo -n true/, () => [0, '']],
  [/date \+%/, () => [0, '20261113-210000\n']],
  /* 「从服务器删除证书」链路（deleteRemoteCert）：
   * FAKE_CERT_REFS=1 时假装有站点引用（验证拒绝分支），否则回空（走真删分支）。
   * 注意 grep 引用检查用的是 `grep -RnFI -e '<path>'`，grep server_name 是第二条命令。 */
  [/grep -RnFI -e/, (cmd) => {
    const mode = process.env.FAKE_CERT_REFS || '';
    if (!mode) return [0, ''];
    const p = (/'([^']+)'/.exec(cmd) || [])[1] || '/etc/nginx/ssl/x/fullchain.pem';
    /* bak：只在我们自己生成的备份/停用文件里出现引用 —— 这些不该算「站点还在用」。 */
    if (mode === 'bak') {
      return [0, `/etc/nginx/conf.d/site.conf.disabled-frpconsole-20260101120000:12:    ssl_certificate ${p};\n/etc/nginx/conf.d/site.conf.bak-frpconsole-20260101120000:12:    ssl_certificate ${p};\n`];
    }
    return [0, `/etc/nginx/conf.d/site.conf:12:    ssl_certificate ${p};\n`];
  }],
  /* 真机上这条命令会先 echo "@@F <文件>" 再吐 server_name，回放要照抄这个形状，
   * 否则调用方解析不出站点名（只回裸 server_name 会被当成「没有文件段」丢掉）。 */
  [/grep -hoE .*server_name/, (cmd) => {
    const m = /for f in '([^']+)'/.exec(cmd);
    const f = m ? m[1] : '/etc/nginx/conf.d/site.conf';
    return [0, `@@F ${f}\nserver_name site.local;\n`];
  }],
  [/mkdir -p \/tmp\/frp-console-cert-trash/, () => [0, '']],
  /* 「换证书」链路的备份与改写（replaceCertReference）：cp -p 备份 + sed -i 替换。 */
  [/^\S*cp -p /, () => [0, '']],
  [/^\S*sed -i /, () => [0, '']],
  [/^\S*mv -f /, () => [0, '']],
  [/rmdir /, () => [0, '']],
  /* FAKE_NGINX_BAD=1 时让 nginx -t 失败，用来验证「删除后重载失败 → 自动搬回」的回滚分支。 */
  [/nginx -t/, () => (process.env.FAKE_NGINX_BAD === '1'
    ? [1, 'nginx: [emerg] unknown directive "ssl_certificate" in /etc/nginx/conf.d/x.conf:18\n']
    : [0, 'nginx: configuration file /etc/nginx/nginx.conf test is successful\n'])],
  [/systemctl reload nginx/, () => [0, '']],
  // 防火墙检测/安装回放（installFirewall / detectFirewall / openFirewallPortsManual / closeFirewallRules 用）
  [/cat \/etc\/os-release/, () => [0, 'ID=debian\n']],
  // readFirewallAllowed 用「不带 head 的 ufw status」，返回当前规则集（可增可删，验证 UI 会真实刷新）；
  // detectFirewall 用「| head -n 1」走下面泛化规则
  [/ufw status 2>\/dev\/null \|\| true$/, () => (firewallMode ? [0, `Status: active\n\nTo                         Action      From\n--                         ------      ----\n${[...fwRules].map((r) => `${r.padEnd(26)}ALLOW       Anywhere`).join('\n')}${fwRules.size ? '\n' : ''}${[...fwRules].map((r) => `${r} (v6)                ALLOW       Anywhere (v6)`).join('\n')}${fwRules.size ? '\n' : ''}`] : [1, ''])],
  [/ufw status/, () => (firewallMode ? [0, 'Status: active\n'] : [1, ''])],
  [/command -v ufw/, () => (firewallMode ? [0, '/usr/sbin/ufw\n'] : [1, ''])],
  [/command -v firewall-cmd/, () => [1, '']],
  [/command -v iptables/, () => (firewallMode ? [0, '/usr/sbin/iptables\n'] : [1, ''])],
  [/ufw delete allow (\S+)/, (cmd) => {
    if (!firewallMode) return [1, ''];
    const m = /ufw delete allow (\S+)/.exec(cmd); // handler 收到的是命令字符串，匹配要自己做
    const spec = m && m[1];
    if (spec && fwRules.has(spec)) { fwRules.delete(spec); return [0, 'Rule deleted\n']; }
    return [1, 'ERROR: Could not find matching rule\n'];
  }],
  [/ufw allow (\S+)/, (cmd) => {
    if (!firewallMode) return [1, ''];
    const m = /ufw allow (\S+)/.exec(cmd);
    if (m && m[1]) fwRules.add(m[1]);
    return [0, 'Rule added\n'];
  }],
  [/ufw --force enable/, () => [0, 'Firewall is active and enabled on system startup\n']],
  [/firewall-cmd --permanent --add-port/, () => [0, 'success\n']],
  [/firewall-cmd --reload/, () => [0, 'success\n']],
  [/iptables -(C|I) INPUT/, () => [0, '']],
  [/install |cp -p |mkdir -p|rm -f |base64 -d|kill /, () => [0, '']],
];

const server = new Server({ hostKeys: [hostKey], keepaliveInterval: 0, ident: 'fake-sshd' }, (client) => {
  client.on('error', (e) => console.log(JSON.stringify({ clientError: String((e && e.message) || e) })));
  client.on('authentication', (ctx) => {
    if (ctx.method === 'password' && ctx.username === USER && ctx.password === PASS) ctx.accept();
    else ctx.reject(['password']);
  });
  client.on('ready', () => {
    client.on('session', (accept) => {
      const session = accept();
      // 交互式终端回放：accept 后发一个提示符，并把用户输入原样回显 + 换提示符。
      // 只求让 xterm / openShell / shellWrite / resize 走通；不做真正的命令解析。
      // ssh2 服务端：pty-req 没有处理器时会被自动拒绝，client.shell() 就会报
      // "Unable to request a pseudo-terminal"——所以这里必须先 accept pty。
      session.on('pty', (acceptPty, rejectPty, info) => {
        try { acceptPty(); } catch { /* ignore */ }
      });
      session.on('window-change', (acceptWc, rejectWc, info) => {
        try { acceptWc(); } catch { /* ignore */ }
      });
      session.on('shell', (accept2, reject2) => {
        const stream = accept2();
        const prompt = `root@${hostname}:~# `;
        console.log('[shell] opened');
        stream.write(`Welcome to fake-sshd (${hostname})\r\n${prompt}`);
        let line = '';
        stream.on('data', (chunk) => {
          const text = chunk.toString('utf8');
          for (const ch of text) {
            if (ch === '\r' || ch === '\n') {
              const cmd = line.trim();
              stream.write('\r\n');
              if (cmd === 'exit' || cmd === 'logout') {
                stream.write('logout\r\n');
                stream.end();
                return;
              }
              if (cmd === 'uname -a') stream.write(`Linux ${hostname} 6.1.0-18-amd64 #1 SMP Debian GNU/Linux 12 (bookworm) x86_64 GNU/Linux\r\n`);
              else if (cmd) stream.write(`fake-sshd: ${cmd}: 命令已收到（回放模式，不执行）\r\n`);
              stream.write(prompt);
              line = '';
            } else if (ch === '\u007f' || ch === '\b') {
              line = line.slice(0, -1);
              stream.write('\b \b');
            } else if (ch >= ' ') {
              line += ch;
              stream.write(ch);
            }
          }
        });
        stream.on('close', () => console.log('[shell] closed'));
      });
      session.on('exec', (accept2, reject2, info) => {
        const stream = accept2();
        const command = info.command || '';
        console.log(`[exec] ${command.replace(/\s+/g, ' ').slice(0, 100)}`);
        let handled = false;
        for (const [pattern, handler] of RULES) {
          if (!pattern.test(command)) continue;
          const [code, out] = handler(command);
          handled = true;
          if (out) stream.write(out);
          stream.exit(code);
          stream.end();
          break;
        }
        if (!handled) {
          // 不认识的命令：让调用方看到“命令未实现”，而不是静默成功
          stream.stderr.write(`fake-sshd: 未实现的命令: ${command.slice(0, 120)}\n`);
          stream.exit(127);
          stream.end();
        }
      });
    });
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({ ok: true, port, mode, user: USER }));
});
