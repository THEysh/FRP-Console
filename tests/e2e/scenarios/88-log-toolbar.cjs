'use strict';
/* 日志页底部工具条（1.2.214）：
 * ① 没开筛选时不要再重复页头的「共缓存 N 条」；
 * ② 开了等级筛选要能看出「筛出来几条 / 一共几条」；
 * ③ 「清空显示」必须说清它不动磁盘上的日志文件。 */
const fs = require('fs');
const path = require('path');

module.exports = {
  id: 'log-toolbar',
  title: '日志页：计数只在筛选时出现，清空按钮说明不动磁盘文件',
  needs: ['app'],
  async run(ctx) {
    const inst = await ctx.startApp({
      cdpOffset: 10,
      seed: (dir) => {
        const ud = path.join(dir, 'frp-console-data');
        fs.mkdirSync(ud, { recursive: true });
        const cfg = path.join(ud, 'frpc.toml');
        const logFile = path.join(ud, 'frpc.log');
        fs.writeFileSync(
          cfg,
          ['serverAddr = ""', 'serverPort = 7000', '', '[log]', 'to = "./frpc.log"', 'level = "info"', ''].join('\n'),
          'utf8',
        );
        /* 三条不同等级，且带上 frpc 真实会写的前缀，好让 1.2.206 的剥离逻辑也走一遍 */
        fs.writeFileSync(
          logFile,
          [
            '2026-11-26 10:00:01.100 [I] [client/service.go:295] try to connect to server...',
            '2026-11-26 10:00:02.200 [W] [client/service.go:301] connect to server error: timeout',
            '2026-11-26 10:00:03.300 [E] [client/control.go:168] proxy [demo] start error',
            '',
          ].join('\n'),
          'utf8',
        );
        fs.writeFileSync(
          path.join(ud, 'settings.json'),
          JSON.stringify(
            {
              version: 2,
              frpcPath: path.join(dir, 'frpc.exe'),
              configPath: cfg,
              logPath: logFile,
              runMode: 'managed',
              adminPort: 7484,
              adminUser: 'admin',
              adminPassword: 'log-toolbar-123456',
            },
            null,
            2,
          ),
          'utf8',
        );
      },
    });

    try {
      await inst.eval(`(async () => {
        document.querySelector('.nav-item[data-view="logs"]').click();
        await new Promise((r) => setTimeout(r, 900));
        return true;
      })()`);

      const before = JSON.parse(
        await inst.eval(`(function() {
          const bar = document.querySelector('.log-toolbar');
          const clear = document.querySelector('[data-act="logs.clear"]');
          return JSON.stringify({
            barText: bar ? bar.textContent.replace(/\\s+/g, ' ').trim() : '',
            lines: document.querySelectorAll('#log-body .log-line').length,
            clearTitle: clear ? clear.getAttribute('title') || '' : '',
          });
        })()`),
      );

      ctx.check('日志页有内容（种子写了 3 行）', before.lines >= 3, String(before.lines));
      ctx.check('没开筛选时底部不再重复条数', !/显示\s*\d+\s*条/.test(before.barText), before.barText);
      ctx.check('「清空显示」的 title 说清磁盘文件不动', /磁盘/.test(before.clearTitle), before.clearTitle);

      const filtered = JSON.parse(
        await inst.eval(`(function() {
          document.querySelector('[data-act="logs.level"][data-level="error"]').click();
          return new Promise((resolve) => setTimeout(() => {
            const bar = document.querySelector('.log-toolbar');
            resolve(JSON.stringify({
              barText: bar ? bar.textContent.replace(/\\s+/g, ' ').trim() : '',
              lines: document.querySelectorAll('#log-body .log-line').length,
            }));
          }, 500));
        })()`),
      );

      ctx.check('筛到 error 只剩 1 行', filtered.lines === 1, String(filtered.lines));
      ctx.check('筛选后底部显示「当前显示 1 / 共 N 条」', /当前显示\s*1\s*\/\s*共\s*\d+\s*条/.test(filtered.barText), filtered.barText);
    } finally {
      inst.stop();
    }
  },
};
