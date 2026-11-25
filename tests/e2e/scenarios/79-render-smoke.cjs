'use strict';
/* 79 渲染冒烟：每个视图都要真的渲染出来，且不能抛异常。
 *
 * 为什么单独有一条：1.2.198 我把 switchRow(label, desc) 的形参名改错，而 `node --check`
 * 与 ESLint 都没拦住（lint 那一步当时没跑），页面表现是「切到设置页什么都不变，右下角
 * 一个『操作异常 label is not defined』的小红条」。只看截图缩略图很容易漏，这里直接断言：
 * 每个视图都有自己的标题区（概览是 hero，其它是 .page-title h1），且页面里没有异常 toast。 */
module.exports = {
  id: 'render-smoke',
  title: '七个视图渲染冒烟：标题正确、无渲染异常',
  needs: ['app'],
  async run(ctx) {
    const views = [
      ['overview', '概览'],
      ['proxies', '代理映射'],
      ['discovery', '服务发现'],
      ['server', '服务器'],
      ['certs', 'HTTPS 证书'],
      ['logs', '实时日志'],
      ['settings', '设置'],
    ];

    await ctx.eval(`(function(){document.querySelectorAll('.toast').forEach(t=>t.remove()); return true;})()`);

    const readHead = `(function(){
      const h = document.querySelector('.page-title h1');
      if (h && h.textContent.trim()) return h.textContent.trim();
      const hero = document.querySelector('.hero');
      if (hero && hero.innerText.trim()) return '概览';
      const c = document.querySelector('.crumb');
      return c ? c.textContent.trim() : '';
    })()`;

    for (const [view, title] of views) {
      await ctx.waitUi(`.nav-item[data-view="${view}"]`);
      await ctx.eval(`(function(){const b=document.querySelector('.nav-item[data-view="${view}"]'); if(b) b.click(); return true;})()`);
      /* 标题可能是骨架先渲染，等它出现再断言 */
      await ctx.waitFor(async () => !!(await ctx.eval(readHead)), (v) => v === true, { timeout: 8000, label: title + ' 标题出现' });

      const info = await ctx.eval(`(function(){
        const head = ${readHead};
        const toasts = [...document.querySelectorAll('.toast')].map(t => t.innerText.replace(/\\s+/g, ' '));
        return { head, toasts };
      })()`);
      ctx.check(`${title}：视图标题正确`, String(info.head).includes(title), `实际「${info.head}」`);
      const bad = (info.toasts || []).filter((t) => /操作异常|is not defined|is not a function/.test(t));
      ctx.check(`${title}：没有渲染异常提示`, bad.length === 0, bad.join(' / '));
    }

    /* 设置页的行为开关必须还在（分组只加标题，不改字段） */
    await ctx.eval(`(function(){const b=document.querySelector('.nav-item[data-view="settings"]'); if(b) b.click(); return true;})()`);
    await ctx.sleep(600);
    const form = await ctx.eval(`(function(){
      const f = document.querySelector('#form-behavior');
      if (!f) return null;
      return {
        switches: f.querySelectorAll('.switch').length,
        subheads: [...f.querySelectorAll('.form-subhead')].map(s => (s.querySelector('strong') || {}).textContent || ''),
        fields: [...f.querySelectorAll('[name]')].map(e => e.name),
      };
    })()`);
    ctx.check('行为表单存在', !!form, form ? '' : '找不到 #form-behavior');
    if (form) {
      ctx.check('开关一个都没少（7 个）', form.switches === 7, `switches=${form.switches}`);
      const want = ['隧道', '窗口与开机'];
      ctx.check('分成了「隧道」「窗口与开机」两组', JSON.stringify(form.subheads) === JSON.stringify(want), JSON.stringify(form.subheads));
      const need = ['runMode', 'pollIntervalMs', 'logLevel', 'adminPort', 'adminUser', 'adminPassword'];
      const missing = need.filter((n) => !form.fields.includes(n));
      ctx.check('保存需要的字段都在', missing.length === 0, missing.join(','));
    }
  },
};
