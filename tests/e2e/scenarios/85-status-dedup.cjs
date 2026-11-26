'use strict';
/* 左下角迷你状态不该把 hero 的整句话抄一遍（1.2.211）。
 *
 * 以前 hero 写「隧道未运行 / 点击"启动隧道"建立连接」，左下角一模一样再来一遍；
 * 左下角真正该回答的是「哪条连接、几个代理在线」。
 *
 * 断言：
 * ① hero 仍然有「隧道未运行」这句主状态（它是页面主信息，不能丢）；
 * ② 左下角 `.mini-title` 不能等于 hero 标题，也不能含「隧道未运行」；
 * ③ 左下角小字要么是「在线 x/y」这种计数，要么是操作提示，不能和 hero 副标题一字不差。 */
module.exports = {
  id: 'status-dedup',
  title: '左下角迷你状态不再重复 hero 的整句话',
  needs: ['app'],
  async run(ctx) {
    const inst = await ctx.startApp({ cdpOffset: 5 });

    try {
      await ctx.waitFor(
        () => inst.eval(`document.querySelector('.hero-titles h2') !== null`),
        (v) => !!v,
        { timeout: 20000, label: '概览 hero 渲染' },
      );

      const snap = JSON.parse(
        await inst.eval(`(function() {
          const heroTitle = document.querySelector('.hero-titles h2');
          const heroDesc = document.querySelector('.hero-titles p');
          const mini = document.querySelector('#mini-status');
          return JSON.stringify({
            heroTitle: heroTitle ? heroTitle.textContent.trim() : '',
            heroDesc: heroDesc ? heroDesc.textContent.trim() : '',
            miniTitle: mini && mini.querySelector('.mini-title') ? mini.querySelector('.mini-title').textContent.trim() : '',
            miniSub: mini && mini.querySelector('.mini-sub') ? mini.querySelector('.mini-sub').textContent.trim() : '',
          });
        })()`),
      );

      ctx.check('hero 仍有「隧道未运行」主状态', /隧道未运行/.test(snap.heroTitle), JSON.stringify(snap));
      ctx.check('左下角标题不再重复「隧道未运行」', !!snap.miniTitle && !/隧道未运行/.test(snap.miniTitle), snap.miniTitle);
      ctx.check('左下角标题与 hero 标题不同', snap.miniTitle !== snap.heroTitle, `${snap.miniTitle} vs ${snap.heroTitle}`);
      ctx.check(
        '左下角小字不与 hero 副标题完全相同',
        !!snap.miniSub && snap.miniSub !== snap.heroDesc,
        `${snap.miniSub} vs ${snap.heroDesc}`,
      );
    } finally {
      inst.stop();
    }
  },
};
