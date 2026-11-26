'use strict';
/* 证书页有三个「按下去必然报错」的按钮（1.2.220）：
 *   · 没填域名时的「检测 / 检测解析」；
 *   · 没填域名时的「签发证书」；
 *   · 没 token、也没保存过凭证时的「验证」。
 * 这一版让它们跟着输入框的当前值开关，并在 title 里说清原因。 */
const fs = require('fs');
const path = require('path');

module.exports = {
  id: 'cert-buttons',
  title: '证书页：输入不全时相关按钮不可点',
  needs: ['app'],
  async run(ctx) {
    const inst = await ctx.startApp({
      cdpOffset: 14,
      seed: (dir) => {
        const ud = path.join(dir, 'frp-console-data');
        fs.mkdirSync(ud, { recursive: true });
        const cfg = path.join(ud, 'frpc.toml');
        fs.writeFileSync(cfg, 'serverAddr = ""\nserverPort = 7000\n', 'utf8');
        fs.writeFileSync(
          path.join(ud, 'settings.json'),
          JSON.stringify({ version: 2, frpcPath: path.join(dir, 'frpc.exe'), configPath: cfg }, null, 2),
          'utf8',
        );
      },
    });
    const ev = (expr) => inst.eval(expr);

    const read = async () =>
      JSON.parse(
        await ev(`(function(){
          const list = (act) => [...document.querySelectorAll('[data-act="' + act + '"]')];
          return JSON.stringify({
            checks: list('dw.check').map((b) => ({ disabled: b.disabled, title: b.title || '' })),
            issue: list('certs.issue').map((b) => ({ disabled: b.disabled, title: b.title || '' })),
            verify: list('certs.dns.verify').map((b) => ({ disabled: b.disabled, title: b.title || '' })),
          });
        })()`),
      );
    const typeInto = (sel, value) =>
      ev(`(function(){
        const el = document.querySelector(${JSON.stringify(sel)});
        if (!el) return 'missing';
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return 'ok';
      })()`);

    try {
      await ctx.waitFor(
        () => ev(`!!document.querySelector('.nav-item[data-view="certs"]')`),
        (v) => v === true,
        { timeout: 30000, label: '侧栏就绪' },
      );
      await ev(`(function(){ document.querySelector('.nav-item[data-view="certs"]').click(); return true; })()`);
      await ctx.waitFor(
        () => ev(`document.querySelectorAll('[data-act="dw.check"]').length`),
        (v) => Number(v) >= 1,
        { timeout: 20000, label: '向导渲染' },
      );

      const empty = await read();
      ctx.check('没填域名时「检测」不可点', empty.checks.length >= 1 && empty.checks.every((b) => b.disabled), JSON.stringify(empty.checks));
      ctx.check(
        '没填域名时按钮 title 说明原因',
        empty.checks.every((b) => /先在上面填写域名/.test(b.title)),
        JSON.stringify(empty.checks.map((b) => b.title)),
      );
      ctx.check('没填域名时「签发证书」不可点', empty.issue.length === 1 && empty.issue[0].disabled, JSON.stringify(empty.issue));
      ctx.check(
        '没填域名时「签发证书」title 说明原因',
        /先在左边填要签发的域名/.test(empty.issue[0].title),
        empty.issue[0].title,
      );
      ctx.check('没 token 时「验证」不可点', empty.verify.length === 1 && empty.verify[0].disabled, JSON.stringify(empty.verify));

      await typeInto('#dw-domain', 'buttons-1220.example.com');
      await typeInto('#cert-domains', 'buttons-1220.example.com');
      await typeInto('#cert-dns-token', 'dummy-token-for-ui-test');
      await ctx.sleep(300);

      const filled = await read();
      ctx.check('填了域名后「检测」可点', filled.checks.every((b) => b.disabled === false), JSON.stringify(filled.checks));
      ctx.check('填了域名后「签发证书」可点', filled.issue[0].disabled === false, JSON.stringify(filled.issue));
      ctx.check('填了 token 后「验证」可点', filled.verify[0].disabled === false, JSON.stringify(filled.verify));

      await typeInto('#dw-domain', '');
      await typeInto('#cert-domains', '');
      await ctx.sleep(300);
      const again = await read();
      ctx.check('清空域名后按钮重新变灰', again.checks.every((b) => b.disabled) && again.issue[0].disabled, JSON.stringify({ checks: again.checks, issue: again.issue }));
    } finally {
      inst.stop();
    }
  },
};
