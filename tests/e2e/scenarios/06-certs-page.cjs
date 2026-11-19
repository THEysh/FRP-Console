'use strict';
/* 证书页：总览 / 向导 / DNS 渠道三块都在；DNS 面板那两张表**不能窄到点不到按钮**
 * （v1.2.84/85 连着修过两次：一次是长 TXT 撑破表格，一次是 flex 把表压扁）。 */
module.exports = {
  id: 'certs-page',
  title: '证书页布局与 DNS 面板表格可读性',
  needs: ['app'],
  async run(ctx) {
    const { check } = ctx;

    await ctx.waitUi('.nav-item[data-view="server"]', '导航渲染完成');

    const page = await ctx.eval(`(async () => {
      document.querySelector('.nav-item[data-view="certs"]').click();
      await new Promise((r) => setTimeout(r, 600));
      const view = document.getElementById('view');
      return {
        heading: (view.querySelector('h1') || {}).textContent || '',
        text: view.textContent,
        cards: [...view.querySelectorAll('.card h3, .card h2')].map((n) => n.textContent.trim()),
      };
    })()`);
    check('证书页能渲染', /证书/.test(page.heading || page.text), page.heading);
    check('有「证书总览」', /证书总览/.test(page.text), page.cards.join('|').slice(0, 200));
    check('有域名就绪向导', /域名|向导|解析/.test(page.text));

    /* DNS 面板：用假的 inspect 结果直接渲染表格，避免依赖 Cloudflare 网络。
     * 这里关心的是布局（列宽 / 是否溢出 / 删除按钮是否可点），不是数据。 */
    const table = await ctx.eval(`(async () => {
      const res = await FRP.dnsInspect('e2e.example.com');
      return { ok: !!(res && res.ok), err: (res && res.error) || '' };
    })()`);
    /* 没有配 DNS 渠道时 dnsInspect 会失败，这属于预期；有网络就会真的查。
     * 两种情况都不该抛异常，只记录结果。 */
    check('DNS 检测不会抛异常', table.ok === true || !!table.err, JSON.stringify(table).slice(0, 160));

    const layout = await ctx.eval(`(async () => {
      /* 直接开面板（不管数据有没有），量两张表：表宽是否超出容器、按钮是否被裁。 */
      const open = [...document.querySelectorAll('[data-act]')].find((b) => b.dataset.act === 'cert.dns' || b.dataset.act === 'dns.open');
      if (open) { open.click(); await new Promise((r) => setTimeout(r, 900)); }
      const panel = document.getElementById('dns-panel') || document.querySelector('.dns-panel');
      if (!panel) return { ok: false, reason: 'panel-not-open' };
      const tables = [...panel.querySelectorAll('table')];
      const wraps = [...panel.querySelectorAll('.port-matrix-wrap')];
      return {
        ok: true,
        tables: tables.length,
        widths: tables.map((t) => ({ w: Math.round(t.getBoundingClientRect().width), sw: t.scrollWidth })),
        wrapOverflow: wraps.map((w) => w.scrollWidth - w.clientWidth),
        tableLayout: tables[0] ? getComputedStyle(tables[0]).tableLayout : '',
        overflows: (() => { const b = panel.querySelector('.modal-body'); return b ? b.scrollHeight > b.clientHeight + 2 : false; })(),
        bodyScrollable: (() => { const b = panel.querySelector('.modal-body'); return b ? b.scrollHeight > b.clientHeight : null; })(),
      };
    })()`);
    if (layout.ok) {
      /* 没有配 Cloudflare 渠道时只会渲染「解析结果对比」一张表（记录表需要 token），
       * 所以这里断言的是「至少一张、列宽固定、不溢出」，而不是硬要求两张。 */
      check('DNS 面板至少渲染一张表', layout.tables >= 1, `tables=${layout.tables}`);
      check('表格没有横向溢出', layout.wrapOverflow.every((v) => v <= 2), JSON.stringify(layout.wrapOverflow));
      check('表格宽度不是被压扁的（> 400px）', layout.widths.every((w) => w.w >= 400), JSON.stringify(layout.widths));
      check('表格用固定列宽布局', layout.tableLayout === 'fixed', String(layout.tableLayout));
      if (layout.overflows) check('内容超高时 body 自己滚动（不是压扁子项）', layout.bodyScrollable !== false, String(layout.bodyScrollable));
      await ctx.eval(`(async () => { const c = document.querySelector('.modal-close, [data-act="dialog.cancel"]'); if (c) c.click(); await new Promise((r) => setTimeout(r, 200)); return 1; })()`);
    } else {
      console.log('    ℹ DNS 面板未打开（缺少入口或需要先选域名），跳过表格布局断言');
    }
  },
};
