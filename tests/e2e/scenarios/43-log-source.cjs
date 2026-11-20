'use strict';
/* 43-log-source：断开服务器之后，日志来源不能继续停在「服务器 frps · <host>」。
 * 走真实 UI 路径（填连接表单 → 点「连接并读取状态」）。 */
const SEG_SERVER = "document.querySelector('.log-src-seg button:last-child')";
const SEG_ACTIVE = "document.querySelector('.log-src-seg .active')";

module.exports = {
  id: 'log-source',
  title: '断线后日志来源自动切回本机',
  needs: ['app', 'sshd'],
  async run(ctx) {
    const { check, sleep, waitFor } = ctx;

    await ctx.waitUi('.nav-item[data-view="server"]', '导航渲染完成');
    /* 全量跑时前面的场景可能已经连上服务器了，这里先断开，保证从「连接表单」开始。 */
    await ctx.eval(`(async () => { try { await FRP.serverDisconnect(); } catch (e) {} return 1; })()`);
    await waitFor(
      () => ctx.eval(`(async () => !!document.querySelector('#server-form'))()`),
      (v) => v === true,
      { timeout: 10000, label: '断开后回到连接表单' },
    ).catch(() => {});
    const clicked = await ctx.eval(`(async () => {
      document.querySelector('.nav-item[data-view="server"]').click();
      await new Promise((r) => setTimeout(r, 700));
      const form = document.querySelector('#server-form');
      if (!form) return { ok: false, err: '没有连接表单' };
      form.querySelector('[name="host"]').value = '127.0.0.1';
      form.querySelector('[name="port"]').value = '${ctx.sshPort}';
      form.querySelector('[name="username"]').value = 'root';
      form.querySelector('[name="password"]').value = 'labpass';
      const remember = form.querySelector('[name="remember"]');
      if (remember) remember.checked = true;
      const btn = [...document.querySelectorAll('[data-act]')].find((b) => b.dataset.act === 'server.connect');
      if (!btn) return { ok: false, err: '没有连接按钮' };
      btn.click();
      return { ok: true };
    })()`);
    check('通过界面表单发起连接', clicked.ok, clicked.err);
    if (!clicked.ok) return;

    /* 已连接的判据：连接表单消失（日志页的胶囊只在日志页存在，不能拿来判断）。 */
    const synced = await waitFor(
      () => ctx.eval(`(async () => !!document.querySelector('#server-form'))()`),
      (v) => v === false,
      { timeout: 20000, label: '界面进入已连接态' },
    ).then(() => true).catch(() => false);
    check('界面进入「已连接」', synced === true, synced ? '' : '20 秒内仍停在连接表单');
    if (!synced) return;

    const picked = await ctx.eval(`(async () => {
      document.querySelector('.nav-item[data-view="logs"]').click();
      await new Promise((r) => setTimeout(r, 700));
      const btn = ${SEG_SERVER};
      if (!btn) return { ok: false, err: '没有服务器来源按钮' };
      const label = btn.textContent.trim();
      const off = btn.classList.contains('is-off');
      btn.click();
      await new Promise((r) => setTimeout(r, 1200));
      const active = ${SEG_ACTIVE};
      return { ok: true, label, off, active: active ? active.textContent.trim() : '' };
    })()`);
    check('已连接时胶囊显示主机名、不置灰', picked.ok && /服务器 frps ·/.test(picked.label || '') && picked.off === false, JSON.stringify(picked).slice(0, 160));
    check('切到「服务器 frps」来源', /服务器 frps/.test(picked.active || ''), picked.active);

    await ctx.eval(`(async () => { await FRP.serverDisconnect(); return 1; })()`);
    await sleep(2200);

    const after = await ctx.eval(`(async () => {
      const serverBtn = ${SEG_SERVER};
      const active = ${SEG_ACTIVE};
      return {
        active: active ? active.textContent.trim() : '',
        serverLabel: serverBtn ? serverBtn.textContent.trim() : '',
        off: serverBtn ? serverBtn.classList.contains('is-off') : false,
      };
    })()`);
    check('断开后自动切回「本机 frpc」', /本机 frpc/.test(after.active || ''), after.active);
    check('服务器来源标注「（未连接）」并置灰', /未连接/.test(after.serverLabel || '') && after.off === true, `${after.serverLabel} off=${after.off}`);

    const clickWhileOff = await ctx.eval(`(async () => {
      const btn = ${SEG_SERVER};
      btn.click();
      await new Promise((r) => setTimeout(r, 600));
      const active = ${SEG_ACTIVE};
      const toastText = (document.querySelector('#toast-root') || {}).textContent || '';
      return { active: active ? active.textContent.trim() : '', toast: String(toastText).trim().slice(0, 80) };
    })()`);
    check('未连接时点它只提示、不切换', /本机 frpc/.test(clickWhileOff.active || '') && /先连上服务器/.test(clickWhileOff.toast || ''), JSON.stringify(clickWhileOff).slice(0, 160));
  },
};
