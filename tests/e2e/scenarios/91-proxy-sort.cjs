'use strict';
/* 1.2.217：代理表表头可点排序。
 *
 * 之前只能搜索、只能按配置里的顺序看；200+ 条时想「按名字看」「按状态把异常的挑出来」做不到。
 * 现在点表头按该列升序、再点切降序，箭头标在当前列。 */
const fs = require('fs');
const path = require('path');

module.exports = {
  id: 'proxy-sort',
  title: '代理表：点表头排序（升序 / 降序）',
  needs: ['app'],
  async run(ctx) {
    const inst = await ctx.startApp({
      cdpOffset: 14,
      seed: (dir) => {
        const ud = path.join(dir, 'frp-console-data');
        fs.mkdirSync(ud, { recursive: true });
        const cfg = path.join(ud, 'frpc.toml');
        const proxy = (name, port) =>
          [
            '[[proxies]]',
            `name = "${name}"`,
            'type = "tcp"',
            'localIP = "127.0.0.1"',
            `localPort = ${port}`,
            `remotePort = ${port + 1000}`,
            '',
          ].join('\n');
        /* 故意让配置里的顺序是 b、a、c，方便验证「排序真的改变了顺序」 */
        fs.writeFileSync(
          cfg,
          'serverAddr = ""\nserverPort = 7000\n\n' + proxy('b-proxy', 18081) + proxy('a-proxy', 18082) + proxy('c-proxy', 18083),
          'utf8',
        );
        fs.writeFileSync(
          path.join(ud, 'settings.json'),
          JSON.stringify({ version: 2, frpcPath: path.join(dir, 'frpc.exe'), configPath: cfg }, null, 2),
          'utf8',
        );
      },
    });
    const ev = (expr) => inst.eval(expr);
    const names = () =>
      ev(`JSON.parse(JSON.stringify([...document.querySelectorAll('.proxy-table tbody tr')].map((tr) => {
        const cell = tr.querySelector('td .pname, td strong, td');
        return (cell ? cell.textContent : '').trim().split('\\n')[0].trim();
      })))`);

    try {
      await ctx.waitFor(
        () => ev(`!!document.querySelector('.nav-item[data-view="proxies"]')`),
        (v) => v === true,
        { timeout: 30000, label: '侧栏就绪' },
      );
      await ev(`(function(){ document.querySelector('.nav-item[data-view="proxies"]').click(); return 1; })()`);
      await ctx.waitFor(
        () => ev(`document.querySelectorAll('.proxy-table tbody tr').length`),
        (v) => Number(v) === 3,
        { timeout: 20000, label: '三条代理渲染' },
      );

      const before = await names();
      ctx.check('默认按配置里的顺序（b / a / c）', JSON.stringify(before) === JSON.stringify(['b-proxy', 'a-proxy', 'c-proxy']), JSON.stringify(before));

      await ev(`(function(){ document.querySelector('.sort-th[data-key="name"]').click(); return 1; })()`);
      await ctx.waitFor(() => names(), (v) => v[0] === 'a-proxy', { timeout: 15000, label: '按名称升序' });
      const asc = await names();
      ctx.check('点「名称」后按字母升序', JSON.stringify(asc) === JSON.stringify(['a-proxy', 'b-proxy', 'c-proxy']), JSON.stringify(asc));

      const arrow = await ev(`(document.querySelector('.sort-th[data-key="name"] .sort-arrow') || {}).textContent || ''`);
      ctx.check('当前排序列显示升序箭头', String(arrow).includes('↑'), String(arrow));

      await ev(`(function(){ document.querySelector('.sort-th[data-key="name"]').click(); return 1; })()`);
      await ctx.waitFor(() => names(), (v) => v[0] === 'c-proxy', { timeout: 15000, label: '再点切降序' });
      const desc = await names();
      ctx.check('再点一次切降序', JSON.stringify(desc) === JSON.stringify(['c-proxy', 'b-proxy', 'a-proxy']), JSON.stringify(desc));

      const arrow2 = await ev(`(document.querySelector('.sort-th[data-key="name"] .sort-arrow') || {}).textContent || ''`);
      ctx.check('箭头跟着变成降序', String(arrow2).includes('↓'), String(arrow2));
    } finally {
      inst.stop();
    }
  },
};
