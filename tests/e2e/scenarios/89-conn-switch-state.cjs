'use strict';
/* 侧栏连接切换器：下拉里每条连接都要带状态（1.2.215）。
 *
 * 以前只有名字（最多加个「· 在线」），切换前看不出「哪条在跑、几个代理在线」；
 * 现在统一写成「<名字> · <未启动 / 连接中 x/y / 在线 x/y>」。 */
const fs = require('fs');
const path = require('path');

module.exports = {
  id: 'conn-switch-state',
  title: '侧栏连接切换器：每个选项都带状态',
  needs: ['app'],
  async run(ctx) {
    const inst = await ctx.startApp({
      cdpOffset: 11,
      seed: (dir) => {
        const ud = path.join(dir, 'frp-console-data');
        fs.mkdirSync(ud, { recursive: true });
        const mk = (id, name, port) => {
          const cfg = path.join(ud, `${id}.toml`);
          fs.writeFileSync(
            cfg,
            ['serverAddr = ""', 'serverPort = 7000', `# ${name}`, ''].join('\n'),
            'utf8',
          );
          return { id, name, configPath: cfg, adminPort: port, host: '127.0.0.1', port: 22, username: 'root' };
        };
        const a = mk('c-default', '日本', 7485);
        const b = mk('c-bbbb', '广州', 7486);
        fs.writeFileSync(
          path.join(ud, 'settings.json'),
          JSON.stringify(
            { version: 2, frpcPath: path.join(dir, 'frpc.exe'), connections: [a, b], activeConnectionId: 'c-default' },
            null,
            2,
          ),
          'utf8',
        );
      },
    });

    try {
      await ctx.waitFor(
        () => inst.eval(`document.querySelectorAll('#conn-switch .cs-item').length`),
        (v) => Number(v) >= 2,
        { timeout: 20000, label: '侧栏服务器列表渲染' },
      );

      const opts = JSON.parse(
        await inst.eval(`(function() {
          const items = [...document.querySelectorAll('#conn-switch .cs-item')];
          const active = document.querySelector('#conn-switch .cs-item.active');
          return JSON.stringify({
            hidden: document.querySelector('#conn-switch').hidden,
            items: items.map((el) => ({
              name: ((el.querySelector('.cs-name') || {}).textContent || '').trim(),
              state: ((el.querySelector('.cs-state') || {}).textContent || '').trim(),
              toggle: ((el.querySelector('.cs-toggle') || {}).textContent || '').trim(),
            })),
            activeName: active ? ((active.querySelector('.cs-name') || {}).textContent || '').trim() : '',
            activeState: active ? ((active.querySelector('.cs-state') || {}).textContent || '').trim() : '',
          });
        })()`),
      );

      ctx.check('侧栏服务器列表可见', opts.hidden === false, String(opts.hidden));
      ctx.check('列表里两条服务器都在且各有独立启停按钮', opts.items.length === 2 && opts.items.every((x) => x.toggle === '启动' || x.toggle === '停止'), JSON.stringify(opts.items));

      const stateless = opts.items.filter((x) => !/^(未启动|连接中\s*\d+\/\d+|在线\s*\d+\/\d+)$/.test(x.state));
      ctx.check('每条服务器都带状态（未启动 / 连接中 x/y / 在线 x/y）', stateless.length === 0, JSON.stringify(opts.items));

      ctx.check('默认高亮第一台服务器且标为未启动', opts.activeName === '日本' && opts.activeState === '未启动', JSON.stringify(opts));
    } finally {
      inst.stop();
    }
  },
};
