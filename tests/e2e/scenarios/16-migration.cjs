'use strict';
/* 老版本数据升级矩阵。
 *
 * 1.2.x 一路改下来，「属于某台服务器的事实」被从全局 settings 搬进了服务器档案：
 *   - 1.2.3 时代只有一个 settings.server（单档案）
 *   - nginxProxyEnabled / vhostHttpPort / vhostHttpsPort 曾是全局开关
 *   - 密码库曾是单密码 server-secret.json 的 legacy 字段
 *   - runMode 可以有已经下线的 'service'
 * 这些迁移都在启动时跑，一旦写错就是「升级后代理乱、公网地址错、密码丢了」，
 * 而用户只会看到“升级完就不好用了”。所以这里在**应用启动前**摆一份老数据，
 * 再断言升级结果。
 */
const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  id: '16-migration',
  title: '老版本数据升级：settings v1 → v2、全局开关归档、老密码迁移',
  needs: [],
  async run(ctx) {
    /* 老密码是 DPAPI 密文，只有同一台机器同一个用户才能解 —— 直接从共享实例的
     * 密码库里借一条（前面的场景连假 sshd 时存过），这样迁移链路才是真的。 */
    let legacyEnc = '';
    try {
      const store = JSON.parse(
        fs.readFileSync(path.join(ctx.dataDir, 'frp-console-data', 'server-secret.json'), 'utf8'),
      );
      const first = Object.values(store.items || {})[0];
      if (first && first.enc) legacyEnc = String(first.enc);
    } catch {
      /* 共享实例没存过密码就跳过密码那部分断言 */
    }

    const own = await ctx.startApp({
      seed: (dir) => {
        const userData = path.join(dir, 'frp-console-data');
        fs.mkdirSync(userData, { recursive: true });
        const configPath = path.join(userData, 'frpc.toml');
        fs.writeFileSync(
          configPath,
          [
            'serverAddr = "10.0.0.9"',
            'serverPort = 7000',
            'auth.method = "token"',
            'auth.token = "legacy-token-1234567890"',
            '',
            '[[proxies]]',
            'name = "old-tcp"',
            'type = "tcp"',
            'localIP = "127.0.0.1"',
            'localPort = 18080',
            'remotePort = 23001',
            '',
            '[[proxies]]',
            'name = "old-http"',
            'type = "http"',
            'localIP = "127.0.0.1"',
            'localPort = 18080',
            'customDomains = ["old.example.com"]',
            '',
          ].join('\n'),
          'utf8',
        );
        /* 1.2.3 时代的 settings：version 1、单 server、全局 nginx/vhost 开关、
         * 已经下线的 runMode=service、以及老版本允许写进来的 pollIntervalMs=0。 */
        fs.writeFileSync(
          path.join(userData, 'settings.json'),
          JSON.stringify(
            {
              version: 1,
              frpcPath: path.join(dir, 'frpc.exe'),
              configPath,
              logPath: path.join(userData, 'frpc.log'),
              runMode: 'service',
              adminPort: 7400,
              pollIntervalMs: 0,
              logBuffer: 600,
              /* 老数据里 SSH 主机与隧道目标是同一台机器（最常见的情况）：
               * ensureClientServerProfile 会按 host 复用这条档案，而不是再建一条。 */
              server: { host: '10.0.0.9', port: 22, username: 'root' },
              nginxProxyEnabled: true,
              vhostHttpPort: 8080,
              vhostHttpsPort: 8443,
              frpsDashboardUrl: 'http://10.0.0.9:7500',
            },
            null,
            2,
          ),
          'utf8',
        );
        if (legacyEnc) {
          fs.writeFileSync(
            path.join(userData, 'server-secret.json'),
            JSON.stringify({ v: 2, items: {}, legacy: { enc: legacyEnc, at: Date.now() } }, null, 2),
            'utf8',
          );
        }
      },
    });

    try {
      ctx.check('老数据实例能启动', own.ready === true);
      const raw = await own.eval(
        '(async () => { const r = await FRP.init(); return r && r.data ? r.data : r; })()',
      );
      const state = (raw && raw.state) || raw;
      const settings = (state && state.settings) || {};
      const servers = settings.servers || [];
      const profile = servers[0] || {};

      ctx.check('settings 升到 version 2', Number(settings.version) === 2, `version=${settings.version}`);
      ctx.check('单档案迁移成 1 条服务器档案（隧道目标复用同一条，不再新建）', servers.length === 1, `servers=${servers.length}`);
      ctx.check(
        '隧道目标被记成 clientPort，没有覆盖 SSH 端口',
        Number(profile.clientPort) === 7000 && Number(profile.port) === 22,
        `port=${profile.port} clientPort=${profile.clientPort}`,
      );
      /* 界面拿到的档案是脱敏过的（settingsForState 会剥掉 clientToken 只留 hasToken），
       * 所以 Token 要回磁盘上核对。 */
      ctx.check('界面只看到 hasToken（Token 不随状态外泄）', profile.hasToken === true, `hasToken=${profile.hasToken}`);
      ctx.check('clientServerId 指向这条档案', !!profile.id && settings.clientServerId === profile.id, `clientServerId=${settings.clientServerId}`);
      ctx.check(
        '档案主机/端口/用户跟着迁移',
        String(profile.host) === '10.0.0.9' && Number(profile.port) === 22 && String(profile.username) === 'root',
        `${profile.host}:${profile.port} ${profile.username}`,
      );
      ctx.check('全局 nginx 开关归到档案上', profile.nginxProxyEnabled === true, `nginxProxyEnabled=${profile.nginxProxyEnabled}`);
      ctx.check(
        '全局 vhost 端口归到档案上',
        Number(profile.vhostHttpPort) === 8080 && Number(profile.vhostHttpsPort) === 8443,
        `${profile.vhostHttpPort}/${profile.vhostHttpsPort}`,
      );
      ctx.check('已下线的 runMode=service 归一到 auto', settings.runMode === 'auto', `runMode=${settings.runMode}`);
      const names = (state.proxies || []).map((p) => p.name).sort();
      ctx.check(
        '老配置里的代理没丢',
        names.length === 2 && names[0] === 'old-http' && names[1] === 'old-tcp',
        names.join(','),
      );
      ctx.check(
        '配置路径沿用老值（没有被重定位）',
        String(settings.configPath).endsWith(path.join('frp-console-data', 'frpc.toml')),
        String(settings.configPath),
      );

      /* 迁移必须落盘：重启一次还是一样的档案数（否则每次启动都“重新迁移”）。 */
      const onDisk = JSON.parse(fs.readFileSync(path.join(own.dir, 'frp-console-data', 'settings.json'), 'utf8'));
      ctx.check('迁移结果写回磁盘 version=2', Number(onDisk.version) === 2, `version=${onDisk.version}`);
      ctx.check('磁盘上不再有老的 server 字段', !('server' in onDisk), Object.keys(onDisk).join(','));
      ctx.check('磁盘上档案数 1', (onDisk.servers || []).length === 1, `servers=${(onDisk.servers || []).length}`);
      ctx.check(
        '隧道 Token 跟着记进档案（磁盘）',
        String((onDisk.servers || [])[0] && (onDisk.servers || [])[0].clientToken) === 'legacy-token-1234567890',
        String((onDisk.servers || [])[0] && (onDisk.servers || [])[0].clientToken),
      );

      if (legacyEnc) {
        const secretRaw = fs.readFileSync(path.join(own.dir, 'frp-console-data', 'server-secret.json'), 'utf8');
        const secret = JSON.parse(secretRaw);
        ctx.check('老单密码已迁到档案上', !secret.legacy && Object.keys(secret.items || {}).length === 1, secretRaw.slice(0, 120));
        ctx.check('档案标记为有密码', profile.hasPassword === true, `hasPassword=${profile.hasPassword}`);
        const serverState = await own.eval('(async () => (await FRP.serverState()).data)()');
        ctx.check(
          '主进程能取到这条密码',
          !!serverState && serverState.savedCredential === true,
          JSON.stringify(serverState && serverState.savedCredential),
        );
      }
    } finally {
      own.stop();
    }
  },
};
