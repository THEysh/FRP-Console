'use strict';
/* 切到另一条连接后，所有「当前那份配置」的写操作必须落到**那条连接的** frpc.toml 上：
 * 代理增删改、管理 API 端口补写、访问路径…一旦还写在旧连接的文件里，就是「改了 A 却在 B 生效」
 * 这类最难查的错乱。 */
const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  id: 'active-write-routing',
  title: '切换当前连接后，代理的增删改落在新连接自己的配置文件里',
  needs: ['app'],
  async run(ctx) {
    let aToml = '';
    let bToml = '';
    const inst = await ctx.startApp({
      cdpOffset: 18,
      seed: (dir) => {
        const ud = path.join(dir, 'frp-console-data');
        fs.mkdirSync(ud, { recursive: true });
        aToml = path.join(dir, 'a.toml');
        bToml = path.join(dir, 'b.toml');
        const cfg = (name, remotePort, adminPort) => [
          /* 有地址才能通过校验（本场景不启动隧道，指向哪里无所谓）。 */
          'serverAddr = "127.0.0.1"',
          'serverPort = 1',
          '',
          '[webServer]',
          'addr = "127.0.0.1"',
          `port = ${adminPort}`,
          'user = "admin"',
          'password = "route-test-123456"',
          '',
          '[[proxies]]',
          `name = "${name}"`,
          'type = "tcp"',
          'localIP = "127.0.0.1"',
          'localPort = 18080',
          `remotePort = ${remotePort}`,
          '',
        ].join('\n');
        fs.writeFileSync(aToml, cfg('a-keep', 26101, 7461), 'utf8');
        fs.writeFileSync(bToml, cfg('b-keep', 26102, 7462), 'utf8');
        fs.writeFileSync(
          path.join(ud, 'settings.json'),
          JSON.stringify(
            {
              version: 2,
              runMode: 'managed',
              adminPort: 7461,
              adminUser: 'admin',
              adminPassword: 'route-test-123456',
              configPath: aToml,
              logPath: path.join(ud, 'frpc.log'),
              connections: [
                { id: 'c-rt1', name: 'A 机', configPath: aToml, logPath: path.join(dir, 'a.log'), adminPort: 7461, enabled: true },
                { id: 'c-rt2', name: 'B 机', configPath: bToml, logPath: path.join(dir, 'b.log'), adminPort: 7462, enabled: true },
              ],
              activeConnectionId: 'c-rt1',
            },
            null,
            2,
          ),
          'utf8',
        );
      },
    });

    const names = (text) => (text.match(/^name = "(.+)"$/gm) || []).map((l) => l.slice(8, -1));

    try {
      /* 1) 切到 B 机 */
      const switched = await inst.eval(`(async () => { const r = await FRP.connectionActive('c-rt2'); return { ok: !!(r && r.ok), err: (r && r.error) || '' }; })()`);
      ctx.check('切到 B 机成功', switched.ok === true, JSON.stringify(switched));

      const view = await inst.eval(`(async () => {
        const r = await FRP.refresh(); const d = r.data || r;
        return { active: d.activeConnectionId, proxies: (d.config && d.config.proxies || []).map((p) => p.name), serverAddr: (d.config || {}).serverAddr };
      })()`);
      ctx.check('当前连接变成 B 机', view.active === 'c-rt2', JSON.stringify(view.active));
      ctx.check('界面里的代理是 B 机那条', JSON.stringify(view.proxies) === JSON.stringify(['b-keep']), JSON.stringify(view.proxies));

      /* 2) 在 B 机上新增一条代理 */
      const added = await inst.eval(`(async () => {
        const r = await FRP.saveProxy('add', '', { name: 'b-new', type: 'tcp', localIP: '127.0.0.1', localPort: 18080, remotePort: 26103 });
        return { ok: !!(r && r.ok), err: (r && r.error) || '' };
      })()`);
      ctx.check('在 B 机上新增代理成功', added.ok === true, JSON.stringify(added));

      const aAfter = names(fs.readFileSync(aToml, 'utf8'));
      const bAfter = names(fs.readFileSync(bToml, 'utf8'));
      ctx.check('新代理写进了 B 机的配置文件', bAfter.includes('b-new'), JSON.stringify(bAfter));
      ctx.check('A 机的配置文件一个字节没动', JSON.stringify(aAfter) === JSON.stringify(['a-keep']), JSON.stringify(aAfter));
      ctx.check('B 机文件里原有的代理还在', bAfter.includes('b-keep'), JSON.stringify(bAfter));

      /* 3) 删除也落在 B 机 */
      const removed = await inst.eval(`(async () => { const r = await FRP.deleteProxy('b-new'); return { ok: !!(r && r.ok), err: (r && r.error) || '' }; })()`);
      ctx.check('删除 B 机上的代理成功', removed.ok === true, JSON.stringify(removed));
      ctx.check('删除后 B 机文件里没有 b-new', !names(fs.readFileSync(bToml, 'utf8')).includes('b-new'), 'b.toml');
      ctx.check('删除后 A 机文件仍是原样', JSON.stringify(names(fs.readFileSync(aToml, 'utf8'))) === JSON.stringify(['a-keep']), 'a.toml');

      /* 4) 切回 A 机，界面立刻回到 A 的那条 */
      const back = await inst.eval(`(async () => { const r = await FRP.connectionActive('c-rt1'); return { ok: !!(r && r.ok) }; })()`);
      ctx.check('切回 A 机成功', back.ok === true, JSON.stringify(back));
      const view2 = await inst.eval(`(async () => { const r = await FRP.refresh(); const d = r.data || r; return { active: d.activeConnectionId, proxies: (d.config && d.config.proxies || []).map((p) => p.name) }; })()`);
      ctx.check('切回后界面是 A 机那条代理', JSON.stringify(view2.proxies) === JSON.stringify(['a-keep']), JSON.stringify(view2.proxies));
    } finally {
      inst.stop();
    }
  },
};
