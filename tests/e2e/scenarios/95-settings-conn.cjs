'use strict';
/* 设置页即时保存开关与高级设置展开（1.2.233）。 */
module.exports = {
  id: 'settings-conn',
  title: '设置页：行为开关拨动即保存，高级设置可展开收起',
  needs: ['app'],
  async run(ctx) {
    const inst = await ctx.startApp({ cdpOffset: 16 });
    try {
      await ctx.waitFor(
        () => inst.eval(`!!document.querySelector('.nav-item[data-view="settings"]')`),
        (v) => v === true,
        { timeout: 30000, label: '侧栏就绪' },
      );
      await inst.eval(`(function(){ document.querySelector('.nav-item[data-view="settings"]').click(); return true; })()`);
      await ctx.waitFor(
        () => inst.eval(`!!document.querySelector('.switch[data-field="startMinimized"]')`),
        (v) => v === true,
        { timeout: 20000, label: '设置页渲染' },
      );

      /* 拨动「以最小化状态启动」应立即持久化，无需再点保存按钮 */
      await inst.eval(`(function(){ document.querySelector('.switch[data-field="startMinimized"]').click(); return true; })()`);
      const persisted = await ctx.waitFor(
        () => inst.eval(`(async () => { const r = await FRP.refresh(); return !!(r && r.data && r.data.settings && r.data.settings.startMinimized); })()`),
        (v) => v === true,
        { timeout: 10000, label: 'startMinimized 立即落盘' },
      );
      ctx.check('拨动「以最小化状态启动」自动保存生效', persisted === true);

      /* 展开高级设置 */
      await inst.eval(`(function(){ document.querySelector('[data-act="settings.advanced.toggle"]').click(); return true; })()`);
      const hasAdv = await inst.eval(`!!document.querySelector('#form-advanced [name="adminPort"]')`);
      ctx.check('点击展开后显示高级设置表单', hasAdv === true);
    } finally {
      inst.stop();
    }
  },
};
