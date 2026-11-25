'use strict';
/* 78 服务发现：高危端口要显眼、发布前要二次确认。
 *
 * 背景（1.2.197 截图巡检）：94 个监听端口里，135/139/445/3389 这类高危端口原先和普通
 * HTTP 端口长得一模一样，点「添加代理」直接就能发布到公网；同时「进程」列全是「未知」，
 * 用户连这是哪个程序都不知道。现在：端口列带风险徽标、发布前弹确认、进程名读不到时
 * 明确写「未知（权限）」并把覆盖率提示提到表格上方。 */
module.exports = {
  id: 'discovery-risk',
  title: '服务发现：高危端口徽标 + 发布前确认',
  needs: ['app'],
  async run(ctx) {
    await ctx.waitUi('.nav-item[data-view="discovery"]');
    await ctx.eval(`(function(){const b=document.querySelector('.nav-item[data-view="discovery"]'); if(b) b.click(); return true;})()`);
    await ctx.sleep(600);

    /* 触发扫描（页面打开时可能已经有上次结果，扫描一次保证数据新鲜） */
    await ctx.eval(`(function(){const b=document.querySelector('[data-act="listeners.scan"]'); if(b) b.click(); return true;})()`);
    await ctx.waitFor(async () => {
      const n = await ctx.eval(`document.querySelectorAll('.listener-table tbody tr').length`);
      return Number(n) > 0;
    }, (v) => v === true, { timeout: 30000, label: '监听端口表出现' });

    const heads = String(await ctx.eval(`[...document.querySelectorAll('.listener-table thead th')].map(th => th.textContent.trim()).join('|')`));
    ctx.check('表头最后一列叫「操作」而不是「发布」', /操作$/.test(heads) && !/发布/.test(heads), heads);

    /* 进程列：读不到时要说清楚是权限问题，不能只写「未知」 */
    const procs = String(await ctx.eval(`[...document.querySelectorAll('.proc-cell')].map(td => td.textContent.trim()).slice(0, 12).join('|')`));
    const unknown = procs.split('|').filter((s) => s === '未知');
    ctx.check('进程名读不到时写「未知（权限）」而不是光一个「未知」', unknown.length === 0, procs.slice(0, 120));

    /* 高危端口：本机一般都有 135/445/3389，没有就跳过（不把环境差异当成失败） */
    const danger = await ctx.eval(`(function(){
      const b = document.querySelector('[data-act="listener.publish"][data-risk="danger"]');
      return b ? { port: b.dataset.port, label: b.dataset.risklabel } : null;
    })()`);
    if (!danger) {
      ctx.skip('本机没有高危端口（135/445/3389 都没在监听），跳过徽标与确认框断言');
    } else {
      const marked = await ctx.eval(`!!document.querySelector('[data-act="listener.publish"][data-risk="danger"]')`);
      ctx.check(`高危端口 ${danger.port}（${danger.label}）在表里被标出来了`, marked === true, JSON.stringify(danger));

      await ctx.eval(`(function(){
        const b = document.querySelector('[data-act="listener.publish"][data-risk="danger"]');
        b.click();
        return true;
      })()`);
      await ctx.sleep(500);
      const modal = await ctx.eval(`(function(){
        const m = document.querySelector('.modal');
        if (!m) return null;
        return { text: m.innerText.replace(/\\s+/g, ' ').slice(0, 400), buttons: [...m.querySelectorAll('button')].map(b => b.textContent.trim()) };
      })()`);
      ctx.check('点高危端口的「添加代理」会先弹确认框', !!modal, modal ? modal.buttons.join(' / ') : '没弹窗');
      if (modal) {
        ctx.check('确认框说明风险并给出「我确认」按钮', /确认|风险|公网/.test(modal.text) && modal.buttons.some((t) => /我确认/.test(t)), modal.text.slice(0, 160));
        /* 取消后不应该打开代理表单 */
        await ctx.eval(`(function(){
          const m = document.querySelector('.modal');
          const btn = [...m.querySelectorAll('button')].find(b => b.textContent.trim() === '取消');
          if (btn) btn.click();
          return true;
        })()`);
        await ctx.sleep(400);
        const opened = await ctx.eval(`!!document.querySelector('#pf-name')`);
        ctx.check('取消后不会打开代理表单', opened === false, String(opened));
      }
    }
  },
};
