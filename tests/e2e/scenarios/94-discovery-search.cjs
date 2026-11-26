'use strict';
/* 服务发现页的搜索框（1.2.221）：94~96 行监听里找「8080 是哪个进程」只能肉眼扫。
 * 搜索支持端口 / 进程名 / 监听地址 / PID，并和分类、只看高危叠加。 */
module.exports = {
  id: 'discovery-search',
  title: '服务发现：按端口/进程搜索监听',
  needs: ['app'],
  async run(ctx) {
    const inst = await ctx.startApp({ cdpOffset: 15 });
    const ev = (expr) => inst.eval(expr);

    const rows = () =>
      ev(`JSON.stringify([...document.querySelectorAll('.listener-table tbody tr')].map((tr) => tr.textContent.replace(/\\s+/g, ' ').trim()))`);

    try {
      await ctx.waitFor(
        () => ev(`!!document.querySelector('.nav-item[data-view="discovery"]')`),
        (v) => v === true,
        { timeout: 30000, label: '侧栏就绪' },
      );
      await ev(`(function(){ document.querySelector('.nav-item[data-view="discovery"]').click(); return true; })()`);
      await ctx.waitFor(
        () => ev(`!!document.querySelector('[data-act="listeners.scan"]')`),
        (v) => v === true,
        { timeout: 20000, label: '服务发现页' },
      );

      await ev(`(function(){ document.querySelector('[data-act="listeners.scan"]').click(); return true; })()`);
      await ctx.waitFor(
        () => ev(`document.querySelectorAll('.listener-table tbody tr').length`),
        (v) => Number(v) > 0,
        { timeout: 60000, label: '扫描出监听端口' },
      );

      const before = JSON.parse(await rows());
      ctx.check('扫描后列出监听端口', before.length > 0, String(before.length));
      ctx.check('工具栏有搜索框', (await ev(`!!document.getElementById('discovery-q')`)) === true, '');

      /* 拿第一行的端口号做搜索条件 —— 至少它自己要被搜出来 */
      const port = (String(before[0]).match(/\b(\d{2,5})\b/) || [])[1] || '';
      ctx.check('能从行文本里取到端口', !!port, String(before[0]).slice(0, 60));

      await ev(`(function(){
        const el = document.getElementById('discovery-q');
        el.value = ${JSON.stringify(port)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      await ctx.sleep(400);

      const filtered = JSON.parse(await rows());
      ctx.check('搜索端口后只剩匹配行', filtered.length > 0 && filtered.length < before.length, `${filtered.length}/${before.length}`);
      ctx.check(
        '所有匹配行都含这个端口',
        filtered.every((r) => r.includes(port)),
        JSON.stringify(filtered.slice(0, 3)),
      );
      ctx.check(
        '搜索后输入框仍保有焦点',
        (await ev(`document.activeElement && document.activeElement.id === 'discovery-q'`)) === true,
        '',
      );

      /* 搜一个不存在的东西 → 空状态 */
      await ev(`(function(){
        const el = document.getElementById('discovery-q');
        el.value = 'zzz-no-such-listener';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      await ctx.sleep(400);
      const emptyRows = JSON.parse(await rows());
      const emptyText = await ev(`(function(){ const el = document.querySelector('.empty'); return el ? el.textContent.replace(/\\s+/g, ' ').trim() : ''; })()`);
      ctx.check('搜不到时列表为空', emptyRows.length === 0, String(emptyRows.length));
      ctx.check('搜不到时有空状态文案', /没有|找不到|匹配/.test(String(emptyText)), String(emptyText).slice(0, 60));

      /* 清空搜索 → 回到全量 */
      await ev(`(function(){
        const el = document.getElementById('discovery-q');
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      await ctx.sleep(400);
      const restored = JSON.parse(await rows());
      ctx.check('清空搜索后恢复全量', restored.length === before.length, `${restored.length}/${before.length}`);
    } finally {
      inst.stop();
    }
  },
};
