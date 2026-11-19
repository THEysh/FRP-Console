'use strict';
/* 终端与日志页：
 *  - 终端能打开、右键菜单三项齐全（v1.2.89）
 *  - 日志页能切「服务器 frps」来源并渲染结构化行（v1.2.91）
 *  - 切视图不会把服务器页内容画进日志页（v1.2.91 顺手修的回归） */
module.exports = {
  id: 'terminal-logs',
  title: 'SSH 终端与实时日志（来源切换）',
  needs: ['app', 'sshd'],
  async run(ctx) {
    const { check } = ctx;

    const term = await ctx.eval(`(async () => {
      document.querySelector('.nav-item[data-view="server"]').click();
      await new Promise((r) => setTimeout(r, 400));
      const open = [...document.querySelectorAll('[data-act]')].find((b) => b.dataset.act === 'server.shell.open');
      if (!open) return { ok: false, reason: 'no-open-button' };
      open.click();
      await new Promise((r) => setTimeout(r, 1800));
      const xterm = document.querySelector('.xterm');
      return { ok: !!xterm, hasXterm: !!xterm, menus: document.querySelectorAll('.ctx-menu').length };
    })()`);
    check('终端能打开', term.ok && term.hasXterm, JSON.stringify(term));

    const menu = await ctx.eval(`(async () => {
      const el = document.querySelector('.xterm');
      if (!el) return { ok: false, reason: 'no-xterm' };
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 300 }));
      await new Promise((r) => setTimeout(r, 200));
      const items = [...document.querySelectorAll('.ctx-menu .ctx-item')].map((b) => ({ label: b.textContent.trim(), disabled: b.classList.contains('disabled') || b.disabled }));
      const open = items.length;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((r) => setTimeout(r, 150));
      return { ok: open === 3, items, closed: document.querySelectorAll('.ctx-menu').length };
    })()`);
    check('右键菜单三项齐全', menu.ok, JSON.stringify(menu.items));
    check('无选区时「复制」置灰', !!(menu.items && menu.items[0] && menu.items[0].disabled && /复制/.test(menu.items[0].label)), JSON.stringify(menu.items && menu.items[0]));
    check('Esc 能关掉菜单', menu.closed === 0, `closed=${menu.closed}`);

    const logs = await ctx.eval(`(async () => {
      document.querySelector('.nav-item[data-view="logs"]').click();
      await new Promise((r) => setTimeout(r, 800));
      const segs = [...document.querySelectorAll('.log-src-seg button, .log-src-seg [data-act]')].map((b) => ({ act: b.dataset.act || '', text: b.textContent.trim() }));
      const serverBtn = [...document.querySelectorAll('[data-act="logs.source"]')].find((b) => /服务器/.test(b.textContent || ''));
      if (serverBtn) serverBtn.click();
      await new Promise((r) => setTimeout(r, 1800));
      const view = document.getElementById('view');
      return {
        segs: segs.length,
        heading: (view.querySelector('h1') || {}).textContent || '',
        rows: view.querySelectorAll('.log-rows .log-row, .log-rows > div').length,
        text: view.textContent.slice(0, 400),
        isLogsView: /日志/.test((view.querySelector('h1') || {}).textContent || ''),
      };
    })()`);
    check('日志页有来源切换', logs.segs >= 2, `segs=${logs.segs}`);
    check('切到服务器来源后仍在日志页（没被服务器页覆盖）', logs.isLogsView, logs.heading);
    check('服务器日志渲染出内容', logs.rows > 0, `rows=${logs.rows} text=${logs.text.slice(0, 120)}`);
  },
};
