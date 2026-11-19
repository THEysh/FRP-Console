'use strict';
/* 服务器页三张「靠 IPC 拉取」的卡片（nginx / 防火墙 / 配置体检）必须自己把数据拉回来。
 *
 * 背景（真机故障注入发现，1.2.101）：这三份状态以前只在「用户在连接表单里点连接」
 * 那条路径上加载。走 IPC 连（自动连接、恢复会话、从托盘进来）时，卡片就永远停在
 * 「检测中…」和「端口与连通（未知）」——用户看到的是「不知道」，还得手动点「重新检测」。
 *
 * 顺带守住另一类更隐蔽的错：卡片渲染函数里抛异常（例如把 const 用在声明之前），
 * 整块 renderServer 会静默失败，DOM 停在上一帧，界面上什么都看不出来。
 */
module.exports = {
  id: 'server-cards',
  title: '服务器页：nginx / 防火墙 / 体检卡片自动加载 + 渲染无异常',
  needs: ['app', 'sshd'],
  async run(ctx) {
    const { check, waitFor } = ctx;

    const conn = await ctx.eval(`(async () => {
      const res = await FRP.serverConnect({ host: '127.0.0.1', port: ${ctx.sshPort}, username: 'root', password: 'labpass', adoptProfile: false });
      return { ok: !!(res && res.ok), err: (res && res.error) || '' };
    })()`);
    check('能连上（假）服务器', conn.ok, JSON.stringify(conn).slice(0, 200));

    await ctx.waitUi('.nav-item[data-view="server"]', '导航渲染完成');

    /* 先挂错误钩子，再切到服务器页——渲染异常会被上面数出来。 */
    await ctx.eval(`(() => {
      window.__renderErrs = [];
      window.addEventListener('error', (e) => window.__renderErrs.push(String(e.message || e)));
      window.addEventListener('unhandledrejection', (e) => window.__renderErrs.push('rejection: ' + String((e.reason && e.reason.message) || e.reason)));
      const nav = document.querySelector('.nav-item[data-view="server"]');
      if (nav) nav.click();
      return 1;
    })()`);

    /* 读某张卡片的文本（按标题匹配）。 */
    const readCard = (kw) => ctx.eval(`(() => {
      const el = [...document.querySelectorAll('.card')].find((c) => ((c.querySelector('h3') || {}).textContent || '').includes(${JSON.stringify(kw)}));
      return el ? (el.textContent || '').replace(/\\s+/g, ' ').trim() : '';
    })()`);

    const nginxText = await waitFor(async () => {
      const t = await readCard('nginx');
      return t && !t.includes('检测中') ? t : '';
    }, (v) => !!v, { timeout: 20000 }).catch(() => '');
    check('nginx 卡片自动加载（不停在「检测中」）', !!nginxText, (nginxText || '20 秒内仍是「检测中…」').slice(0, 180));
    check('nginx 卡片显示了版本号', /1\.26|nginx\s*\d/i.test(nginxText || ''), (nginxText || '').split(' ').slice(0, 10).join(' '));

    const fwText = await waitFor(async () => {
      const t = await readCard('端口与连通');
      return t && !t.includes('（未知）') ? t : '';
    }, (v) => !!v, { timeout: 20000 }).catch(() => '');
    check('防火墙卡片自动加载（不停在「未知」）', !!fwText, (fwText || '20 秒内仍是「（未知）」').slice(0, 180));

    const healthText = await waitFor(async () => {
      const t = await readCard('nginx');
      return /配置体检|nginx -t/.test(t || '') ? t : '';
    }, (v) => !!v, { timeout: 20000 }).catch(() => '');
    check('配置体检结果出现（不静默）', !!healthText, (healthText || '20 秒内没有体检区').slice(0, 140));

    const errs = await ctx.eval('window.__renderErrs || []');
    check('渲染过程没有抛异常', Array.isArray(errs) && errs.length === 0, JSON.stringify(errs).slice(0, 240));

    /* 服务器信息要能重新抓（frps 被停/升级后卡片才会跟着变）。 */
    const recheck = await ctx.eval(`(async () => { const r = await FRP.serverRecheck(); return { ok: !!(r && r.ok), status: r && r.data && r.data.info && r.data.info.status, err: (r && r.error) || '' }; })()`);
    check('server:recheck 能重新读取服务器信息', recheck.ok && recheck.status === 'running', JSON.stringify(recheck).slice(0, 160));

    await ctx.eval('(async () => { await FRP.serverDisconnect(); return 1; })()').catch(() => {});
  },
};
