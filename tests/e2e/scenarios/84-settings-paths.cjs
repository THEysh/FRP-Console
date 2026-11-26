'use strict';
/* 设置页精简重构（1.2.233）：
 * ① 移除不再适合多服务器的「可执行文件与路径」卡片；
 * ② 「关于」卡片保留「打开数据目录」入口；
 * ③ 「高级设置」默认折叠，展开后可见运行模式与客户端管理 API。 */
module.exports = {
  id: 'settings-paths',
  title: '设置页：移除单机路径卡，保留数据目录与可折叠高级设置',
  needs: ['app'],
  async run(ctx) {
    const inst = await ctx.startApp({ cdpOffset: 4 });

    try {
      await inst.eval(`(async () => {
        document.querySelector('.nav-item[data-view="settings"]').click();
        await new Promise((r) => setTimeout(r, 600));
        return true;
      })()`);

      const info = JSON.parse(
        await inst.eval(`(function() {
          const cards = [...document.querySelectorAll('section.card')].map((c) => c.textContent || '');
          return JSON.stringify({
            hasPathCard: cards.some((t) => /可执行文件与路径/.test(t)),
            hasDataBtn: !!document.querySelector('[data-act="settings.reveal-data"]'),
            hasAdvToggle: !!document.querySelector('[data-act="settings.advanced.toggle"]'),
            advFormInitiallyHidden: !document.querySelector('#form-advanced'),
          });
        })()`),
      );

      ctx.check('已移除「可执行文件与路径」卡片', info.hasPathCard === false, JSON.stringify(info));
      ctx.check('「关于」卡片保留「打开数据目录」按钮', info.hasDataBtn === true, JSON.stringify(info));
      ctx.check('「高级设置」默认折叠', info.hasAdvToggle === true && info.advFormInitiallyHidden === true, JSON.stringify(info));
    } finally {
      inst.stop();
    }
  },
};
