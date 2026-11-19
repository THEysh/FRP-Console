'use strict';
/* 布局回归：五个视图都不能横向溢出、图标不能被撑成巨图、卡片不能互相压。
 * 1.2.61 的「巨大感叹号」和 1.2.65 的「主次不分」都是这类问题，
 * 它们不影响逻辑测试，只能靠量尺寸发现，所以在 E2E 里固定量一次。 */
module.exports = {
  id: 'layout-guards',
  title: '布局体检：溢出、图标尺寸、遮挡',
  needs: ['app'],
  async run(ctx) {
    const { check } = ctx;

    const result = await ctx.eval(`(async () => {
      const views = ['overview', 'proxies', 'discovery', 'certs', 'logs', 'server'];
      const out = [];
      for (const view of views) {
        const item = document.querySelector('.nav-item[data-view="' + view + '"]');
        if (!item) { out.push({ view, missing: true }); continue; }
        item.click();
        await new Promise((r) => setTimeout(r, 420));
        const root = document.getElementById('view');
        /* 只看「明显越界」的元素：宽度超过可视区域，且不是刻意横向滚动的容器
         * （表格外层、代码块、日志区都允许自己滚）。 */
        const overflowing = [...root.querySelectorAll('*')].filter((el) => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return false;
          if (r.right > window.innerWidth + 2) {
            const style = getComputedStyle(el);
            const scrollableAncestor = el.closest('.port-matrix-wrap, .log-rows, pre, .term-shell, .config-area');
            if (style.position === 'fixed' || scrollableAncestor) return false;
            return true;
          }
          return false;
        }).slice(0, 5).map((el) => (el.className || el.tagName).toString().slice(0, 40));

        const bigSvgs = [...root.querySelectorAll('svg')].filter((svg) => {
          const r = svg.getBoundingClientRect();
          return r.width > 24 || r.height > 24;
        }).map((svg) => ({ cls: (svg.parentElement && svg.parentElement.className || '').toString().slice(0, 30), w: Math.round(svg.getBoundingClientRect().width) }));

        /* 复制按钮这类关键操作不能被别的元素盖住。 */
        const covered = [...root.querySelectorAll('button')].filter((b) => {
          const r = b.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return false;
          const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return top && top !== b && !b.contains(top) && !top.contains(b);
        }).length;

        out.push({ view, overflowing, bigSvgs, covered, height: root.scrollHeight });
      }
      return out;
    })()`);

    for (const row of result) {
      if (row.missing) {
        check(`视图 ${row.view} 存在`, false, '找不到导航项');
        continue;
      }
      check(`视图 ${row.view} 没有横向溢出`, row.overflowing.length === 0, JSON.stringify(row.overflowing));
      check(`视图 ${row.view} 没有超大图标`, row.bigSvgs.length === 0, JSON.stringify(row.bigSvgs));
      check(`视图 ${row.view} 按钮没被遮挡`, row.covered === 0, `covered=${row.covered}`);
    }
  },
};
