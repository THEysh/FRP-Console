'use strict';
/* 冷启动：全新数据目录下应用能起来、五个视图都能渲染、没有立即出现的报错。
 * 这一条是其它所有场景的前提，也覆盖「自动生成 starter 配置」那段逻辑。 */
module.exports = {
  id: 'cold-start',
  title: '冷启动：五视图渲染 + starter 配置',
  needs: ['app'],
  async run(ctx) {
    const { check } = ctx;

    const boot = await ctx.eval(`(async () => {
      const r = await FRP.init();
      /* init 返回时 state 已经就绪，但侧边栏的第一帧渲染要等一拍；
       * 这里把「数据」和「DOM」分两次读，避免把渲染时序差异当成 bug。 */
      await new Promise((res) => setTimeout(res, 600));
      return {
        ok: !!(r && r.ok),
        hasState: !!(r && r.data && r.data.state),
        configPath: (r && r.data && r.data.state && r.data.state.paths && r.data.state.paths.configPath) || '',
        proxies: (r && r.data && r.data.state && r.data.state.proxies ? r.data.state.proxies.length : -1),
        navs: [...document.querySelectorAll('.nav-item[data-view]')].map((n) => n.dataset.view),
        title: document.title,
      };
    })()`);

    check('FRP.init 成功', boot.ok, JSON.stringify(boot).slice(0, 200));
    check('返回了 state', boot.hasState);
    check('全新安装自动生成 frpc.toml', !!boot.configPath, boot.configPath);
    check('全新安装没有代理', boot.proxies === 0, `proxies=${boot.proxies}`);
    check(
      '五个导航项齐全',
      ['overview', 'proxies', 'discovery', 'certs', 'logs', 'server', 'settings'].every((v) => boot.navs.includes(v)),
      boot.navs.join(','),
    );

    /* 逐个切换视图，检查标题与主容器都被重画（不该出现空白 / 残留上一页）。 */
    for (const view of ['proxies', 'discovery', 'certs', 'logs', 'server', 'overview']) {
      const info = await ctx.eval(`(async () => {
        const item = document.querySelector('.nav-item[data-view="${view}"]');
        if (!item) return { ok: false, reason: 'no nav item' };
        item.click();
        await new Promise((r) => setTimeout(r, 260));
        const heading = document.querySelector('.view-head h1, h1');
        const bodyLen = (document.getElementById('view') || document.body).innerHTML.length;
        return {
          ok: true,
          heading: heading ? heading.textContent.trim() : '',
          bodyLen,
          active: document.querySelector('.nav-item.active') ? document.querySelector('.nav-item.active').dataset.view : '',
        };
      })()`);
      check(`视图 ${view} 能渲染`, info.ok && info.bodyLen > 200, JSON.stringify(info).slice(0, 160));
      check(`视图 ${view} 导航高亮跟随`, info.active === view, info.active);
    }

    const toasts = await ctx.eval(`(() => document.querySelectorAll('.toast').length)()`);
    check('启动过程没有弹出错误提示', toasts === 0, `toast=${toasts}`);
  },
};
