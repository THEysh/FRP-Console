'use strict';
/* 概览「连接信息」卡的措辞与噪声（1.2.224）：
 * ① 行名「服务器」其实显示 frps 地址，和界面里「服务器 = SSH 那台机器」同名不同义 → 改「隧道目标（frps）」；
 * ② 「系统服务」在服务模式撤掉之后基本恒为「未安装」；「管理员权限」提权时没什么可说 → 只在需要时出现。 */
module.exports = {
  id: 'overview-info',
  title: '概览连接信息卡：称谓不歧义、不摆无用行',
  needs: ['app'],
  async run(ctx) {
    await ctx.waitFor(
      () => ctx.eval(`!!document.querySelector('.nav-item[data-view="overview"]')`),
      (v) => v === true,
      { timeout: 30000, label: '侧栏就绪' },
    );
    await ctx.eval(`(function(){ document.querySelector('.nav-item[data-view="overview"]').click(); return true; })()`);
    await ctx.waitFor(
      () => ctx.eval(`!!document.querySelector('.detail-list')`),
      (v) => v === true,
      { timeout: 20000, label: '概览渲染' },
    );

    const info = JSON.parse(
      await ctx.eval(`(function(){
        const card = [...document.querySelectorAll('section.card')].find((s) => /连接信息/.test(s.textContent));
        if (!card) return JSON.stringify({ missing: true });
        const rows = [...card.querySelectorAll('.detail-row')].map((r) => {
          const label = r.querySelector('.d-label, .dl-label, span');
          return (label ? label.textContent : r.textContent).replace(/\\s+/g, ' ').trim();
        });
        return JSON.stringify({ rows, all: card.textContent.replace(/\\s+/g, ' ').trim() });
      })()`),
    );

    ctx.check('概览有「连接信息」卡', !info.missing, JSON.stringify(info.missing || false));

    const labels = info.rows || [];
    ctx.check('行名不再叫「服务器」', !labels.some((l) => l === '服务器'), JSON.stringify(labels));
    ctx.check(
      '改为「隧道目标（frps）」',
      labels.some((l) => /隧道目标/.test(l)),
      JSON.stringify(labels),
    );

    /* 系统服务：测试环境没装 systemd 服务 → 这一行不该出现 */
    const installed = await ctx.eval(`(async () => { const r = await FRP.refresh(); const st = r.data || r; return !!(st.service && st.service.installed); })()`);
    ctx.check(
      installed ? '装了系统服务时仍显示该行' : '没装系统服务时不显示该行',
      installed ? labels.some((l) => /系统服务/.test(l)) : !labels.some((l) => /系统服务/.test(l)),
      `installed=${installed} rows=${JSON.stringify(labels)}`,
    );

    /* 管理员权限：与 app.elevated 互补出现 */
    const elevated = await ctx.eval(`(async () => { const r = await FRP.refresh(); const st = r.data || r; return !!(st.app && st.app.elevated); })()`);
    const hasAdminRow = labels.some((l) => /管理员权限/.test(l));
    ctx.check(
      elevated ? '已提权时不摆「管理员权限」行' : '未提权时提示「管理员权限」',
      elevated ? hasAdminRow === false : hasAdminRow === true,
      `elevated=${elevated} rows=${JSON.stringify(labels)}`,
    );
  },
};
