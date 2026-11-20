'use strict';
/* 42-paste-guard：终端里粘贴多行命令要先确认（这是 root shell，粘进去就执行）。 */
const MENU = `const el = document.querySelector('#ssh-term .xterm');
  if (!el) return { ok: false, err: '没有 .xterm' };
  const r = el.getBoundingClientRect();
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 40 }));
  await new Promise((res) => setTimeout(res, 150));
  const btn = document.querySelector('.ctx-menu [data-ctx="paste"]');
  if (!btn) return { ok: false, err: '没有粘贴菜单项' };
  btn.click();`;

module.exports = {
  id: 'paste-guard',
  title: '粘贴多行命令前先确认，单行不打扰',
  needs: ['app', 'sshd'],
  async run(ctx) {
    const { check, waitFor, sleep } = ctx;

    const conn = await ctx.eval(`(async () => {
      const r = await FRP.serverConnect({ host: '127.0.0.1', port: ${ctx.sshPort}, username: 'root', password: 'labpass', remember: true, adoptProfile: false });
      return { ok: !!r.ok, error: r.error || '' };
    })()`);
    check('连上假服务器', conn.ok, conn.error);

    await ctx.waitUi('.nav-item[data-view="server"]', '导航渲染完成');
    const opened = await ctx.eval(`(async () => {
      document.querySelector('.nav-item[data-view="server"]').click();
      await new Promise((r) => setTimeout(r, 500));
      const btn = [...document.querySelectorAll('[data-act]')].find((b) => b.dataset.act === 'server.shell.open');
      if (!btn) return { ok: false, err: '没有「打开终端」按钮（可能没连上服务器）' };
      btn.click();
      await new Promise((r) => setTimeout(r, 2000));
      return { ok: !!document.querySelector('.xterm'), err: '' };
    })()`);
    check('打开终端', opened.ok, opened.err);
    if (!opened.ok) return;

    /* 多行：弹确认 */
    const multi = await ctx.eval(`(async () => {
      await FRP.copy('echo one\\necho two\\necho three');
      await new Promise((res) => setTimeout(res, 120));
      ${MENU}
      await new Promise((res) => setTimeout(res, 350));
      const m = /粘贴 (\\d+) 行命令？/.exec(document.body.innerText || '');
      return { ok: true, shown: !!m, count: m ? Number(m[1]) : 0 };
    })()`);
    check('多行粘贴弹出确认框', multi.shown === true, multi.shown ? `${multi.count} 行` : JSON.stringify(multi).slice(0, 120));

    const cancelled = await ctx.eval(`(async () => {
      const btn = [...document.querySelectorAll('button')].find((b) => /取消/.test(b.textContent || ''));
      if (btn) btn.click();
      await new Promise((res) => setTimeout(res, 300));
      return { closed: !/粘贴 \\d+ 行命令？/.test(document.body.innerText || '') };
    })()`);
    check('点取消后弹窗关闭且不执行', cancelled.closed === true, JSON.stringify(cancelled));

    /* 单行：不打扰 */
    const single = await ctx.eval(`(async () => {
      await FRP.copy('echo solo');
      await new Promise((res) => setTimeout(res, 120));
      ${MENU}
      await new Promise((res) => setTimeout(res, 400));
      return { modal: /粘贴 \\d+ 行命令？/.test(document.body.innerText || '') };
    })()`);
    check('单行粘贴不弹确认', single.modal === false, JSON.stringify(single));

    await sleep(200);
    await ctx.eval(`(async () => { await FRP.shellClose(); return 1; })()`).catch(() => {});
  },
};
