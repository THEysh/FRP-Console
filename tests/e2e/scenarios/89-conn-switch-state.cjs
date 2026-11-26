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
        () => inst.eval(`document.querySelectorAll('#conn-select option').length`),
        (v) => Number(v) >= 2,
        { timeout: 20000, label: '侧栏连接下拉渲染' },
      );

      const opts = JSON.parse(
        await inst.eval(`(function() {
          const sel = document.querySelector('#conn-select');
          return JSON.stringify({
            hidden: document.querySelector('#conn-switch').hidden,
            options: [...sel.options].map((o) => o.textContent.trim()),
            selected: sel.selectedOptions[0] ? sel.selectedOptions[0].textContent.trim() : '',
          });
        })()`),
      );

      ctx.check('侧栏连接切换器可见', opts.hidden === false, String(opts.hidden));
      ctx.check('下拉里两条连接都在', opts.options.length === 2, JSON.stringify(opts.options));

      const stateless = opts.options.filter((t) => !/·\s*(未启动|连接中\s*\d+\/\d+|在线\s*\d+\/\d+)$/.test(t));
      ctx.check('每个选项都带状态（未启动 / 连接中 x/y / 在线 x/y）', stateless.length === 0, JSON.stringify(opts.options));

      ctx.check('当前选中的是默认连接且标为未启动', /日本 · 未启动/.test(opts.selected), opts.selected);
    } finally {
      inst.stop();
    }
  },
};
