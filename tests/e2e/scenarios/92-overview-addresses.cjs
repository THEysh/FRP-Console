'use strict';
/* 1.2.218：概览的「公网地址」要列出所有连接的代理。
 *
 * 以前只列当前连接 —— 多连接时会让人以为「我的代理就这些」；
 * 代理页 1.2.190 起已经是全量视图，概览这张卡一直没有跟上。
 *
 * 断言：两条连接各一条代理时，概览地址行是两条、都带连接名小标；
 * 只有一条连接时仍是一条、且不出现连接名小标（单连接界面保持原样）。 */
const fs = require('fs');
const path = require('path');

function seedTwo(dir) {
  const ud = path.join(dir, 'frp-console-data');
  fs.mkdirSync(ud, { recursive: true });
  const make = (id, name, serverAddr, port, proxy, remotePort) => {
    const cfg = path.join(ud, `${id}.toml`);
    fs.writeFileSync(
      cfg,
      [
        `serverAddr = "${serverAddr}"`,
        'serverPort = 7000',
        '',
        '[[proxies]]',
        `name = "${proxy}"`,
        'type = "tcp"',
        'localIP = "127.0.0.1"',
        'localPort = 18080',
        `remotePort = ${remotePort}`,
        '',
      ].join('\n'),
      'utf8',
    );
    return { id, name, configPath: cfg, adminPort: port, host: serverAddr, port: 22, username: 'root' };
  };
  return {
    connections: [
      make('c-default', '日本', '10.9.9.9', 7495, 'addr-a', 24901),
      make('c-bbbb', '广州', '10.9.9.8', 7496, 'addr-b', 24902),
    ],
  };
}

module.exports = {
  id: 'overview-addresses',
  title: '概览公网地址：多连接时列出所有连接的代理',
  needs: ['app'],
  async run(ctx) {
    const inst = await ctx.startApp({
      cdpOffset: 14,
      seed: (dir) => {
        const ud = path.join(dir, 'frp-console-data');
        fs.mkdirSync(ud, { recursive: true });
        const two = seedTwo(dir);
        fs.writeFileSync(
          path.join(ud, 'settings.json'),
          JSON.stringify(
            { version: 2, frpcPath: path.join(dir, 'frpc.exe'), connections: two.connections, activeConnectionId: 'c-default' },
            null,
            2,
          ),
          'utf8',
        );
      },
    });

    try {
      await ctx.waitFor(
        () => inst.eval(`document.querySelectorAll('.addr-row').length`),
        (v) => Number(v) >= 2,
        { timeout: 30000, label: '概览地址行渲染' },
      );

      const multi = JSON.parse(
        await inst.eval(`(function() {
          const rows = [...document.querySelectorAll('.addr-row')];
          const title = [...document.querySelectorAll('.section-title')]
            .find((el) => (el.querySelector('strong') || {}).textContent === '公网地址');
          const sub = title ? title.querySelector('span') : null;
          return JSON.stringify({
            count: rows.length,
            names: rows.map((r) => (r.querySelector('.ar-name') || {}).textContent || ''),
            addrs: rows.map((r) => (r.querySelector('.ar-addr') || {}).textContent || ''),
            conns: rows.map((r) => (r.querySelector('.ar-conn') || {}).textContent || ''),
            subtitle: sub ? sub.textContent.trim() : '',
          });
        })()`),
      );

      ctx.check('两条连接的两条代理都列出来了', multi.count === 2, JSON.stringify(multi.names));
      /* 连接名小标就在 .ar-name 里，textContent 会把两段拼起来，用前缀判断 */
      ctx.check('两条代理名字都在', multi.names.some((n) => n.startsWith('addr-a')) && multi.names.some((n) => n.startsWith('addr-b')), JSON.stringify(multi.names));
      ctx.check(
        '每条地址用的是它自己那台服务器',
        multi.addrs.some((a) => a.includes('10.9.9.9')) && multi.addrs.some((a) => a.includes('10.9.9.8')),
        JSON.stringify(multi.addrs),
      );
      ctx.check('每行带连接名小标', multi.conns.includes('日本') && multi.conns.includes('广州'), JSON.stringify(multi.conns));
      ctx.check('副标题说明「含所有连接」', /含所有连接/.test(multi.subtitle), multi.subtitle);

      const metrics = JSON.parse(
        await inst.eval(`(function(){
          const cards = [...document.querySelectorAll('.metrics .metric')].map((c) => ({
            label: (c.querySelector('.metric-label') || {}).textContent.trim(),
            value: (c.querySelector('.metric-value') || {}).textContent.replace(/\s+/g, ' ').trim(),
            foot: (c.querySelector('.metric-foot span') || {}).textContent.trim(),
          }));
          return JSON.stringify(cards);
        })()`),
      );
      ctx.check(
        '多连接时指标卡标题不再标「（当前连接）」',
        metrics.every((m) => !String(m.label || '').includes('（当前连接）')),
        JSON.stringify(metrics.map((m) => m.label)),
      );
      /* 两条连接各一条代理 → 全量口径下「代理总数」是 2（改动前这里只会显示 1） */
      ctx.check(
        '多连接时代理总数按所有连接统计',
        String((metrics[0] || {}).value) === '2',
        JSON.stringify(metrics[0] || null),
      );
      ctx.check(
        '多连接时脚注写明「含所有连接」',
        /含所有连接/.test(String((metrics[0] || {}).foot || '')),
        String((metrics[0] || {}).foot || ''),
      );
    } finally {
      inst.stop();
    }

    /* 单连接：保持原样（一条地址、没有连接名小标） */
    const single = await ctx.startApp({
      cdpOffset: 15,
      seed: (dir) => {
        const ud = path.join(dir, 'frp-console-data');
        fs.mkdirSync(ud, { recursive: true });
        const cfg = path.join(ud, 'frpc.toml');
        fs.writeFileSync(
          cfg,
          ['serverAddr = "10.9.9.7"', 'serverPort = 7000', '', '[[proxies]]', 'name = "solo"', 'type = "tcp"', 'localIP = "127.0.0.1"', 'localPort = 18080', 'remotePort = 24903', ''].join('\n'),
          'utf8',
        );
        fs.writeFileSync(
          path.join(ud, 'settings.json'),
          JSON.stringify({ version: 2, frpcPath: path.join(dir, 'frpc.exe'), configPath: cfg }, null, 2),
          'utf8',
        );
      },
    });
    try {
      await ctx.waitFor(
        () => single.eval(`document.querySelectorAll('.addr-row').length`),
        (v) => Number(v) >= 1,
        { timeout: 30000, label: '单连接地址行' },
      );
      const one = JSON.parse(
        await single.eval(`(function() {
          const rows = [...document.querySelectorAll('.addr-row')];
          const title = [...document.querySelectorAll('.section-title')]
            .find((el) => (el.querySelector('strong') || {}).textContent === '公网地址');
          const sub = title ? title.querySelector('span') : null;
          return JSON.stringify({
            count: rows.length,
            tag: rows[0] ? !!rows[0].querySelector('.ar-conn') : null,
            subtitle: sub ? sub.textContent.trim() : '',
          });
        })()`),
      );
      ctx.check('单连接只列一条', one.count === 1, String(one.count));
      ctx.check('单连接不显示连接名小标', one.tag === false, String(one.tag));
      ctx.check('单连接副标题不提「含所有连接」', !/含所有连接/.test(one.subtitle), one.subtitle);

      const singleMetrics = JSON.parse(
        await single.eval(`(function(){
          const c = document.querySelector('.metrics .metric');
          return JSON.stringify({
            value: (c.querySelector('.metric-value') || {}).textContent.trim(),
            foot: (c.querySelector('.metric-foot span') || {}).textContent.trim(),
          });
        })()`),
      );
      ctx.check('单连接时代理总数仍是 1', String(singleMetrics.value) === '1', JSON.stringify(singleMetrics));
      ctx.check('单连接时脚注不提「含所有连接」', !/含所有连接/.test(String(singleMetrics.foot || '')), String(singleMetrics.foot || ''));
    } finally {
      single.stop();
    }
  },
};
