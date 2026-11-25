'use strict';
/* 1.2.193 回归：启动时加载配置 + 剪枝访问路径不能再崩。
 *
 * 背景（真 bug，1.2.190 引入）：pruneProxyOpenPaths() 里写成
 * `const [connId] = connectionsModule.splitKey(key)`，而 splitKey 返回的是对象
 * `{ connectionId, name }` —— 只要 proxyOpenPaths 里存在 `<connId>::<name>` 这种键，
 * 启动加载配置就会抛 `TypeError: object is not iterable`，界面挂出
 * 「配置解析失败：object is not iterable…」，配置被当成读不出来。
 *
 * 这条场景用 seed 直接造出「已经带连接前缀的访问路径」，启动后要求：
 * 1) configError 为空；2) 那条代理仍带着它自己的访问路径；3) 设置文件里的键还是带前缀的。
 */
const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  id: 'openpath-persist',
  title: '带连接前缀的访问路径在启动加载时不再报配置解析失败',
  needs: ['app'],
  async run(ctx) {
    const { check } = ctx;
    let inst = null;
    try {
      let work = '';
      inst = await ctx.startApp({
        cdpOffset: 6,
        seed: (dir) => {
          work = path.join(dir, 'op');
          fs.mkdirSync(work, { recursive: true });
          const cfg = path.join(work, 'a.toml');
          fs.writeFileSync(cfg, [
            'serverAddr = "127.0.0.1"',
            'serverPort = 18700',
            'loginFailExit = false',
            '',
            '[auth]',
            'method = "token"',
            'token = "op-token-1234567890"',
            '',
            '[webServer]',
            'addr = "127.0.0.1"',
            'port = 7455',
            'user = "admin"',
            'password = "admin"',
            '',
            '[[proxies]]',
            'name = "keep"',
            'type = "tcp"',
            'localIP = "127.0.0.1"',
            'localPort = 18080',
            'remotePort = 24401',
            '',
          ].join('\n'), 'utf8');
          const ud = path.join(dir, 'frp-console-data');
          fs.mkdirSync(ud, { recursive: true });
          fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({
            version: 2,
            runMode: 'managed',
            adminPort: 7455,
            adminUser: 'admin',
            adminPassword: 'op-admin-pass-1234',
            configPath: cfg,
            logPath: path.join(work, 'a.log'),
            connections: [{ id: 'c-default', name: '本地', host: '127.0.0.1', port: 22, username: 'root', configPath: cfg, logPath: path.join(work, 'a.log'), adminPort: 7455, enabled: true }],
            activeConnectionId: 'c-default',
            /* 关键：键已经带连接前缀（1.2.190 之后的形态） */
            proxyOpenPaths: { 'c-default::keep': '/panel/' },
          }, null, 2), 'utf8');
        },
      });

      const st = JSON.parse(await inst.eval(`(async()=>{
        const s = await FRP.refresh(); const d = s && s.data ? s.data : s;
        const p = (d.proxies || []).find((x) => x.name === 'keep') || {};
        return JSON.stringify({ configError: d.configError || '', openPath: p.openPath || '', openUrl: p.openUrl || '' });
      })()`));
      check('启动加载配置没有报错', st.configError === '', st.configError);
      check('访问路径仍在（没被剪枝成空）', st.openPath === '/panel/', JSON.stringify(st));
      check('公网地址带上了访问路径', /\/panel\/$/.test(String(st.openUrl || '')), st.openUrl);

      const disk = JSON.parse(fs.readFileSync(path.join(work, '..', 'frp-console-data', 'settings.json'), 'utf8'));
      check('设置文件里的键仍是带连接前缀的形态', !!disk.proxyOpenPaths['c-default::keep'], JSON.stringify(disk.proxyOpenPaths));
    } finally {
      if (inst) { try { await inst.stop(); } catch {} }
    }
  },
};
