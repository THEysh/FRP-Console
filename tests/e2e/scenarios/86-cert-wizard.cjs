'use strict';
/* 证书页「域名就绪向导」的可达性问题（1.2.212）：
 * ① 第 2 步（域名解析）以前一个按钮都没有 —— 想检测只能回顶部那行找「检测」；
 * ② 第 3 步的「签发证书」用的是自己的输入框，但页面从没说清「不填第 1 步也能在这里直接签」，
 *    用户很容易以为必须先走完前两步。
 *
 * 断言：第 2 步有自己的「检测解析」；没域名时第 3 步出现「字段独立」的说明；填了域名后该说明消失。 */
module.exports = {
  id: 'cert-wizard',
  title: '证书向导：第 2 步有就地检测，第 3 步说清签发字段独立',
  needs: ['app'],
  async run(ctx) {
    const inst = await ctx.startApp({ cdpOffset: 6 });

    try {
      /* 起实例后界面可能还没解析完（1.2.217 全量跑时偶发 null.click），先等侧栏与向导出现 */
      await ctx.waitFor(
        () => inst.eval(`!!document.querySelector('.nav-item[data-view="certs"]')`),
        (v) => v === true,
        { timeout: 30000, label: '侧栏就绪' },
      );
      await inst.eval(`(function(){ document.querySelector('.nav-item[data-view="certs"]').click(); return true; })()`);
      await ctx.waitFor(
        () => inst.eval(`document.querySelectorAll('.dw-step').length`),
        (v) => Number(v) === 4,
        { timeout: 20000, label: '向导四步渲染' },
      );

      const before = JSON.parse(
        await inst.eval(`(function() {
          const steps = [...document.querySelectorAll('.dw-step')];
          const step2 = steps[1] || null;
          const step3 = steps[2] || null;
          return JSON.stringify({
            stepCount: steps.length,
            step2Acts: step2 ? [...step2.querySelectorAll('[data-act]')].map((b) => b.dataset.act) : [],
            step2Text: step2 ? step2.textContent.replace(/\\s+/g, ' ').trim() : '',
            step3HasHint: !!(step3 && step3.querySelector('.dw-need-domain')),
          });
        })()`),
      );

      ctx.check('向导有 4 个步骤', before.stepCount === 4, String(before.stepCount));
      ctx.check('第 2 步自己能发起检测（dw.check）', before.step2Acts.includes('dw.check'), JSON.stringify(before.step2Acts));
      ctx.check('第 2 步按钮文案是「检测解析」', /检测解析/.test(before.step2Text), before.step2Text.slice(0, 80));
      ctx.check('没填域名时第 3 步有「字段独立」的说明', before.step3HasHint === true, String(before.step3HasHint));

      /* 填域名并触发一次检测，说明应当消失（域名已就位，不再需要解释） */
      const after = JSON.parse(
        await inst.eval(`(async () => {
          const input = document.querySelector('#dw-domain');
          input.value = 'wizard-1212.example.com';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          document.querySelectorAll('[data-act="dw.check"]')[0].click();
          await new Promise((r) => setTimeout(r, 1200));
          const step3 = [...document.querySelectorAll('.dw-step')][2] || null;
          return JSON.stringify({ step3HasHint: !!(step3 && step3.querySelector('.dw-need-domain')) });
        })()`),
      );
      ctx.check('填了域名后这条说明消失', after.step3HasHint === false, String(after.step3HasHint));
    } finally {
      inst.stop();
    }
  },
};
