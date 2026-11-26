'use strict';
/* 服务器页的卡片顺序（1.2.223）：连上之后第一屏应该是「运行状态」，
 * 不是「SSH 终端」。以前终端卡排状态卡前面，打开终端后要往下滚才能看到状态。 */
module.exports = {
  id: 'server-order',
  title: '服务器页：状态卡在终端卡之前',
  needs: ['app', 'sshd'],
  async run(ctx) {
    const ev = (expr) => ctx.eval(expr);
    const check = ctx.check.bind(ctx);
    const inst = ctx;

    try {
      const conn = JSON.parse(
        await ev(`(async () => {
          const FRP = window.FRP;
          const res = await FRP.serverConnect({ host: '127.0.0.1', port: ${ctx.sshPort}, username: 'root', password: 'labpass', adoptProfile: false });
          return JSON.stringify({ ok: !!(res && res.ok), err: (res && res.error) || '' });
        })()`),
      );
      check('能连上服务器', conn.ok === true, JSON.stringify(conn).slice(0, 200));

      await ctx.waitUi('.nav-item[data-view="server"]', '侧栏');
      await ev(`(function(){ document.querySelector('.nav-item[data-view="server"]').click(); return true; })()`);
      await ctx.waitFor(
        () => ev(`!!document.querySelector('.server-status-card')`),
        (v) => v === true,
        { timeout: 20000, label: '服务器页渲染' },
      );

      const order = JSON.parse(
        await ev(`(function(){
          const all = [...document.querySelectorAll('#view section, #view > div > section, #view .card')];
          const uniq = [...new Set(all)];
          const idx = (sel) => uniq.findIndex((el) => el.matches(sel));
          return JSON.stringify({
            status: idx('.server-status-card'),
            terminal: idx('#terminal-card'),
            config: idx('.config-card'),
            total: uniq.length,
          });
        })()`),
      );

      check('状态卡在页面上', order.status >= 0, JSON.stringify(order));
      check('终端卡在页面上', order.terminal >= 0, JSON.stringify(order));
      check('状态卡排在终端卡之前', order.status >= 0 && order.terminal > order.status, JSON.stringify(order));
      check('终端卡排在配置文件卡之前', order.terminal >= 0 && order.config > order.terminal, JSON.stringify(order));

      /* 终端依然可用：点开之后输入容器出现（不动会话，只验可达性） */
      const opened = await ev(`(async () => {
        const btn = document.querySelector('[data-act="server.shell.open"]');
        if (!btn) return JSON.stringify({ missing: true });
        btn.click();
        return JSON.stringify({ clicked: true });
      })()`);
      check('终端卡里的「打开终端」按钮仍在', !JSON.parse(opened).missing, opened);
    } finally {
      try { await ev(`window.FRP.serverDisconnect()`); } catch { /* 忽略 */ }
      void inst;
    }
  },
};
