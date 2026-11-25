'use strict';
/* 非当前连接的配置缓存不能永久缓存：手动改了它的 frpc.toml（或别的工具改过），
 * 界面里这条连接的代理数/健康检查目标要跟着变 —— 否则用户看到的是「改了没反应」。 */
const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  id: 'parked-config-refresh',
  title: '外部改了非当前连接的配置，界面里的代理数会跟着变',
  needs: ['app'],
  async run(ctx) {
    const inst = await ctx.startApp({
      cdpOffset: 15,
      seed: (dir) => {
        const ud = path.join(dir, 'frp-console-data');
        fs.mkdirSync(ud, { recursive: true });
        const aToml = path.join(dir, 'a.toml');
        const bToml = path.join(dir, 'b.toml');
        const proxy = (name, port) => [
          '[[proxies]]',
          `name = "${name}"`,
          'type = "tcp"',
          'localIP = "127.0.0.1"',
          `localPort = 18080`,
          `remotePort = ${port}`,
          '',
        ].join('\n');
        fs.writeFileSync(aToml, ['serverAddr = ""', 'serverPort = 7000', '', proxy('a-one', 25001)].join('\n'), 'utf8');
        fs.writeFileSync(bToml, ['serverAddr = ""', 'serverPort = 7000', '', proxy('b-one', 25002)].join('\n'), 'utf8');
        fs.writeFileSync(
          path.join(ud, 'settings.json'),
          JSON.stringify(
            {
              version: 2,
              runMode: 'managed',
              adminPort: 7431,
              configPath: aToml,
              logPath: path.join(ud, 'frpc.log'),
              connections: [
                { id: 'c-aaa1', name: 'A 机', configPath: aToml, logPath: path.join(dir, 'a.log'), adminPort: 7431, enabled: true },
                { id: 'c-bbb2', name: 'B 机', configPath: bToml, logPath: path.join(dir, 'b.log'), adminPort: 7432, enabled: true },
              ],
              activeConnectionId: 'c-aaa1',
            },
            null,
            2,
          ),
          'utf8',
        );
      },
    });

    const read = () => inst.eval(`(async () => {
      const r = await FRP.refresh(); const d = r.data || r;
      return { active: d.activeConnectionId, list: (d.connections || []).map((c) => ({ name: c.name, total: (c.counts && c.counts.total) || 0 })) };
    })()`);

    try {
      const before = await read();
      const b = (before.list || []).find((c) => /B 机/.test(c.name)) || {};
      ctx.check('先读到 B 机的代理数', Number(b.total) === 1, JSON.stringify(before.list));

      /* 外部往 B 机的配置里加一条代理 */
      const bToml = path.join(inst.dir, 'b.toml');
      fs.appendFileSync(
        bToml,
        '\n[[proxies]]\nname = "b-two"\ntype = "tcp"\nlocalIP = "127.0.0.1"\nlocalPort = 18081\nremotePort = 25003\n',
        'utf8',
      );

      const after = await ctx.waitFor(
        async () => {
          const now = await read();
          const cur = (now.list || []).find((c) => /B 机/.test(c.name)) || {};
          return Number(cur.total) > Number(b.total) ? cur : null;
        },
        (v) => !!v,
        { timeout: 20000, label: 'B 机代理数跟上外部改动' },
      );
      ctx.check('外部改动后 B 机的代理数变成 2', Number(after.total) === 2, `${b.total} -> ${after.total}`);

      /* 反向也要成立：把代理删掉，界面跟着减 */
      fs.writeFileSync(
        bToml,
        ['serverAddr = ""', 'serverPort = 7000', '', '[[proxies]]', 'name = "b-one"', 'type = "tcp"', 'localIP = "127.0.0.1"', 'localPort = 18080', 'remotePort = 25002', ''].join('\n'),
        'utf8',
      );
      const back = await ctx.waitFor(
        async () => {
          const now = await read();
          const cur = (now.list || []).find((c) => /B 机/.test(c.name)) || {};
          return Number(cur.total) === 1 ? cur : null;
        },
        (v) => !!v,
        { timeout: 20000, label: 'B 机代理数跟上删除' },
      );
      ctx.check('删掉后 B 机的代理数回到 1', Number(back.total) === 1, back.total);
    } finally {
      inst.stop();
    }
  },
};
