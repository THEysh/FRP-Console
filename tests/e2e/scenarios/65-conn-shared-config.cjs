'use strict';
/* 两条连接不能共用同一份 frpc.toml：那样管理端口会互相覆盖、写配置会互相踩，
 * 用户看到的是「改 A 的代理，B 也跟着变」这种莫名现象。 */
const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  id: 'conn-shared-config',
  title: '两条连接不能指向同一份配置文件',
  needs: ['app'],
  async run(ctx) {
    const inst = await ctx.startApp({
      cdpOffset: 19,
      seed: (dir) => {
        const ud = path.join(dir, 'frp-console-data');
        fs.mkdirSync(ud, { recursive: true });
        const aToml = path.join(dir, 'a.toml');
        const bToml = path.join(dir, 'b.toml');
        const cfg = (name, adminPort) => [
          'serverAddr = "127.0.0.1"',
          'serverPort = 1',
          '',
          '[webServer]',
          'addr = "127.0.0.1"',
          `port = ${adminPort}`,
          'user = "admin"',
          'password = "shared-test-123456"',
          '',
          '[[proxies]]',
          `name = "${name}"`,
          'type = "tcp"',
          'localIP = "127.0.0.1"',
          'localPort = 18080',
          'remotePort = 26201',
          '',
        ].join('\n');
        fs.writeFileSync(aToml, cfg('a-one', 7471), 'utf8');
        fs.writeFileSync(bToml, cfg('b-one', 7472), 'utf8');
        fs.writeFileSync(
          path.join(ud, 'settings.json'),
          JSON.stringify(
            {
              version: 2,
              runMode: 'managed',
              adminPort: 7471,
              adminUser: 'admin',
              adminPassword: 'shared-test-123456',
              configPath: aToml,
              logPath: path.join(ud, 'frpc.log'),
              connections: [
                { id: 'c-sh1', name: 'A 机', configPath: aToml, logPath: path.join(dir, 'a.log'), adminPort: 7471, enabled: true },
                { id: 'c-sh2', name: 'B 机', configPath: bToml, logPath: path.join(dir, 'b.log'), adminPort: 7472, enabled: true },
              ],
              activeConnectionId: 'c-sh1',
            },
            null,
            2,
          ),
          'utf8',
        );
      },
    });

    try {
      const aPath = path.join(inst.dir, 'a.toml');
      const share = await inst.eval(`(async () => {
        const r = await FRP.connectionUpdate({ id: 'c-sh2', configPath: ${JSON.stringify(path.join(inst.dir, 'a.toml'))} });
        return { ok: !!(r && r.ok), err: (r && r.error) || '' };
      })()`);
      ctx.check('把 B 指向 A 的配置文件被拒绝', share.ok === false, JSON.stringify(share));
      ctx.check('拒绝原因点明被哪条连接占着', /A 机|已被|占用/.test(share.err), share.err);

      /* 反向：新建连接时直接传一个已被占用的路径（走 add 的 update 流程前先确认 add 不接受路径） */
      const dup = await inst.eval(`(async () => {
        const r = await FRP.connectionAdd({ name: 'C 机' });
        if (!r || !r.ok) return { ok: false, err: (r && r.error) || '', step: 'add' };
        const id = r.data && r.data.connection && r.data.connection.id;
        const u = await FRP.connectionUpdate({ id, configPath: ${JSON.stringify(aPath)} });
        return { ok: !!(u && u.ok), err: (u && u.error) || '', step: 'update' };
      })()`);
      ctx.check('新建连接后指到已占用的路径也被拒绝', dup.ok === false, JSON.stringify(dup));

      /* settings:save 改当前连接的配置路径，也不能撞到别的连接 */
      const bPathLiteral = JSON.stringify(path.join(inst.dir, 'b.toml'));
      const viaSettings = await inst.eval(`(async () => {
        const r = await FRP.saveSettings({ configPath: ${bPathLiteral} });
        return { ok: !!(r && r.ok), err: (r && r.error) || '' };
      })()`);
      ctx.check('设置里把当前连接的配置指到别人的文件也被拒绝', viaSettings.ok === false, JSON.stringify(viaSettings));

      /* 还原检查：B 还是自己的路径 */
      const list = await inst.eval(`(async () => { const r = await FRP.connections(); const d = r.data || r; return (d.connections || d || []).map((c) => ({ name: c.name, configPath: c.configPath })); })()`);
      const b = (list || []).find((c) => /B 机/.test(c.name)) || {};
      ctx.check('B 机的配置路径没被改掉', String(b.configPath || '').endsWith('b.toml'), b.configPath);
    } finally {
      inst.stop();
    }
  },
};
