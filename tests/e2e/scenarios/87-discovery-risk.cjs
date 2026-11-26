'use strict';
/* 服务发现页「只看高危」开关（1.2.213）。
 *
 * 背景：这台机器 94 个监听端口，135 RPC / 139 NetBIOS / 445 SMB / 3389 RDP 混在中间，
 * 1.2.197 加的红色徽标只能靠眼睛一行行找。这个开关把它们一次筛出来。
 *
 * 断言：开关上的数字等于「添加代理」按钮上 data-risk="danger" 的行数；
 * 点开后表里只剩这些行；再点一次恢复原样。 */
module.exports = {
  id: 'discovery-risk-filter',
  title: '服务发现：只看高危端口（叠加在分类筛选上）',
  needs: ['app'],
  async run(ctx) {
    const inst = await ctx.startApp({ cdpOffset: 9 });

    try {
      await inst.eval(`(async () => {
        document.querySelector('.nav-item[data-view="discovery"]').click();
        await new Promise((r) => setTimeout(r, 400));
        const scan = document.querySelector('[data-act="listeners.scan"]');
        if (scan) scan.click();
        await new Promise((r) => setTimeout(r, 7000));
        return true;
      })()`);

      const before = JSON.parse(
        await inst.eval(`(function() {
          const rows = [...document.querySelectorAll('.listener-table tbody tr')];
          const danger = rows.filter((r) => r.querySelector('[data-risk="danger"]')).length;
          const toggle = document.querySelector('[data-act="listeners.risk"]');
          return JSON.stringify({
            rows: rows.length,
            danger,
            hasToggle: !!toggle,
            toggleText: toggle ? toggle.textContent.trim() : '',
          });
        })()`),
      );

      if (!before.rows) return ctx.skip('本机没有扫描到监听端口');
      if (!before.danger) return ctx.skip('本机没有高危端口，无法验证筛选');

      ctx.check('高危端口存在时出现「只看高危」开关', before.hasToggle === true, JSON.stringify(before));
      ctx.check('开关上的数字等于高危行数', before.toggleText.includes(String(before.danger)), `${before.toggleText} vs ${before.danger}`);

      const on = JSON.parse(
        await inst.eval(`(function() {
          const toggle = document.querySelector('[data-act="listeners.risk"]');
          if (!toggle) return Promise.resolve(JSON.stringify({ missing: true }));
          toggle.click();
          return new Promise((resolve) => setTimeout(() => {
            const rows = [...document.querySelectorAll('.listener-table tbody tr')];
            resolve(JSON.stringify({
              rows: rows.length,
              allDanger: rows.every((r) => r.querySelector('[data-risk="danger"]')),
              active: document.querySelector('[data-act="listeners.risk"]').classList.contains('active'),
            }));
          }, 500));
        })()`),
      );
      ctx.check('开关存在且可点', on.missing !== true, JSON.stringify(on));
      ctx.check('点开后只剩高危行', on.rows === before.danger, `${on.rows} vs ${before.danger}`);
      ctx.check('剩下的每一行都是高危', on.allDanger === true, String(on.allDanger));
      ctx.check('开关显示为激活状态', on.active === true, String(on.active));

      const off = JSON.parse(
        await inst.eval(`(function() {
          const t2 = document.querySelector('[data-act="listeners.risk"]');
          if (!t2) return Promise.resolve(JSON.stringify({ rows: -1 }));
          t2.click();
          return new Promise((resolve) => setTimeout(() => {
            resolve(JSON.stringify({ rows: document.querySelectorAll('.listener-table tbody tr').length }));
          }, 500));
        })()`),
      );
      ctx.check('再点一次恢复全部', off.rows === before.rows, `${off.rows} vs ${before.rows}`);
    } finally {
      inst.stop();
    }
  },
};
