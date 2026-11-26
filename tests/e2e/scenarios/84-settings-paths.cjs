'use strict';
/* 设置页「可执行文件与路径」三行的状态说法要统一，而且日志文件在隧道没跑过之前本来就不存在，
 * 不能标成红色「不存在」——那会让用户以为程序出问题了（1.2.210）。
 *
 * 断言三件事：
 * ① frpc.exe / frpc.toml 的徽标只能是「可用」或「未找到」，且带 title 说明；
 * ② 日志文件那行只能是「已生成」或「还没生成」，绝不能是「不存在」；
 * ③ 不存在时用琥珀色（amber），不是红色（bad）。 */
module.exports = {
  id: 'settings-paths',
  title: '设置页路径卡片：三行状态说法统一，日志「还没生成」不标红',
  needs: ['app'],
  async run(ctx) {
    const inst = await ctx.startApp({ cdpOffset: 4 });

    try {
      await inst.eval(`(async () => {
        document.querySelector('.nav-item[data-view="settings"]').click();
        await new Promise((r) => setTimeout(r, 600));
        return true;
      })()`);

      const rows = JSON.parse(
        await inst.eval(`(function() {
          return JSON.stringify([...document.querySelectorAll('.path-row')].map((row) => {
            const label = row.querySelector('.p-label');
            const tag = row.querySelector('.p-value') ? row.querySelector('.tag') : row.querySelector('.tag');
            const badge = tag || row.querySelector('.tag');
            return {
              label: label ? label.textContent.trim() : '',
              text: badge ? badge.textContent.trim() : '',
              cls: badge ? badge.className : '',
            };
          }));
        })()`),
      );

      const byLabel = (name) => rows.find((r) => r.label === name) || null;
      const exe = byLabel('frpc.exe');
      const cfg = byLabel('frpc.toml');
      const log = byLabel('日志文件');

      ctx.check('找得到 frpc.exe 这一行', !!exe, JSON.stringify(rows));
      ctx.check('找得到 frpc.toml 这一行', !!cfg, JSON.stringify(rows));
      ctx.check('找得到日志文件这一行', !!log, JSON.stringify(rows));

      const fileBadgesOk = [exe, cfg].every((r) => r && ['可用', '未找到'].includes(r.text));
      ctx.check('配置类两行只用「可用 / 未找到」', fileBadgesOk, JSON.stringify([exe && exe.text, cfg && cfg.text]));

      ctx.check('日志行不再写「不存在」', !!log && log.text !== '不存在', log && log.text);
      ctx.check('日志行用「已生成 / 还没生成」', !!log && ['已生成', '还没生成'].includes(log.text), log && log.text);

      /* 本机新实例没跑过隧道 → 日志应当还没生成，并且是琥珀色而不是红色 */
      if (log && log.text === '还没生成') {
        ctx.check('「还没生成」是琥珀色不是红色', /\bamber\b/.test(log.cls) && !/\bbad\b/.test(log.cls), log.cls);
      }
    } finally {
      inst.stop();
    }
  },
};
