'use strict';
/* 边界：服务器只允许极少数公网端口（frps allowPorts），且这些端口已经被用完。
 * 此时「端口建议 / 随机」不能悄悄给一个 frpc 会拒绝的端口，必须说清为什么没有。 */
const path = require('path');
const { spawn } = require('child_process');
const { ROOT } = require('../helpers/app.cjs');
const { waitPort } = require('../helpers/frps.cjs');

module.exports = {
  id: 'port-exhausted',
  title: 'allowPorts 用满时端口建议/随机会说明原因',
  needs: ['app'],
  async run(ctx) {
    const { check } = ctx;
    const port = 22467;
    const sshd = spawn(process.execPath, [path.join(ROOT, 'tests', 'e2e', 'fixtures', 'fake-sshd.cjs'), String(port), 'mixed', 'allow-host', 'allow-token', '1.26.3', 'fw'], {
      cwd: ROOT,
      stdio: 'ignore',
      env: { ...process.env, FAKE_ALLOW_PORTS: '20000' },
    });
    try {
      const up = await waitPort(port, '127.0.0.1', 15000);
      check('假 sshd 起来了', up === true);

      const inst = await ctx.startApp({ cdpOffset: 9 });
      try {
        const conn = await inst.eval(`FRP.serverConnect({ host: '127.0.0.1', port: ${port}, username: 'root', password: 'labpass', adoptProfile: false })`);
        check('连上服务器', conn.ok === true, conn.error || '');

        const summary = await inst.eval(`(async () => { const r = await FRP.serverState(); return r.data.summary; })()`);
        const allow = (summary && summary.allowPorts) || [];
        check('服务器 allowPorts 解析到 20000', JSON.stringify(allow) === JSON.stringify([{ single: 20000 }]), JSON.stringify(allow));

        /* 1.2.133 修的回归：allowPorts 还没被用时，建议端口必须命中白名单里的那个。
         * 以前 TOML 里的 [20000] 是数字，白名单判定只认对象，结果一条都匹配不上 →
         * 明明有空闲端口也报「没有可用端口」。 */
        const freeSuggest = await inst.eval(`FRP.suggestPort('tcp')`);
        check('还有空闲时建议到白名单里的 20000', freeSuggest.ok === true && Number(freeSuggest.data.port) === 20000, JSON.stringify(freeSuggest.data));

        /* 占掉唯一被允许的端口 */
        const made = await inst.eval(`FRP.saveProxy('add', '', { name: 'only-port', type: 'tcp', localIP: '127.0.0.1', localPort: 18080, remotePort: 20000 })`);
        check('占掉 20000 这条能存', made.ok === true, made.error || '');

        const suggest = await inst.eval(`FRP.suggestPort('tcp')`);
        check('建议端口返回空且带原因', suggest.ok === true && !suggest.data.port && /allowPorts/.test(String(suggest.data.reason || '')), JSON.stringify(suggest.data));

        const random = await inst.eval(`FRP.randomPort('tcp')`);
        check('随机端口同样返回空且带原因', random.ok === true && !random.data.port && /allowPorts/.test(String(random.data.reason || '')), JSON.stringify(random.data));

        /* 界面上点「随机」要弹提示，而不是默默什么都不做 */
        const toastText = await inst.eval(`(async () => {
          for (let i = 0; i < 40 && !document.querySelector('.nav-item[data-view="proxies"]'); i += 1) await new Promise((r) => setTimeout(r, 250));
          document.querySelector('.nav-item[data-view="proxies"]').click();
          /* 「随机」按钮在代理表单弹窗里：先点「新增代理」把弹窗打开 */
          for (let i = 0; i < 40 && !document.querySelector('[data-act="proxy.add"]'); i += 1) await new Promise((r) => setTimeout(r, 250));
          const addBtn = document.querySelector('[data-act="proxy.add"]');
          if (addBtn) addBtn.click();
          for (let i = 0; i < 40 && !document.querySelector('[data-act="proxyform.random"]'); i += 1) await new Promise((r) => setTimeout(r, 250));
          const btn = document.querySelector('[data-act="proxyform.random"]');
          if (!btn) return '';
          btn.click();
          for (let i = 0; i < 30; i += 1) {
            const t = document.querySelector('.toast');
            if (t && /可用端口/.test(t.innerText)) return t.innerText.replace(/\\s+/g, ' ');
            await new Promise((r) => setTimeout(r, 200));
          }
          return '';
        })()`);
        check('点「随机」会提示没找到可用端口', /可用端口/.test(String(toastText || '')), String(toastText || ''));
      } finally {
        try { await inst.stop(); } catch (e) { /* 收尾失败不影响结论 */ }
      }
    } finally {
      try { sshd.kill(); } catch (e) { /* 已退出 */ }
    }
  },
};
