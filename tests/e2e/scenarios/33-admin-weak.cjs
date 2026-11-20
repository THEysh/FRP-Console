'use strict';
/* 本机 frpc 管理 API 用默认口令（admin/admin 或空）时，概览要提示并且能一键换掉。
 * 这个接口只监听 127.0.0.1，但本机任何进程都能连上去读 token、改代理。 */
const fs = require('fs');
const path = require('path');

module.exports = {
  id: 'admin-weak',
  title: '本机管理 API 弱口令会在概览提示，换掉后提示消失',
  needs: ['app'],
  async run(ctx) {
    const inst = await ctx.startApp({
      cdpOffset: 6,
      seed: (dir) => {
        const ud = path.join(dir, 'frp-console-data');
        fs.mkdirSync(ud, { recursive: true });
        const cfg = path.join(ud, 'frpc.toml');
        fs.writeFileSync(
          path.join(ud, 'settings.json'),
          JSON.stringify(
            {
              version: 2,
              frpcPath: path.join(dir, 'frpc.exe'),
              configPath: cfg,
              logPath: path.join(ud, 'frpc.log'),
              runMode: 'managed',
              adminPort: 7481,
              adminUser: 'admin',
              adminPassword: 'admin',
              pollIntervalMs: 3000,
            },
            null,
            2,
          ),
          'utf8',
        );
        fs.writeFileSync(
          cfg,
          ['serverAddr = ""', 'serverPort = 7000', 'webServer.addr = "127.0.0.1"', 'webServer.port = 7481', 'webServer.user = "admin"', 'webServer.password = "admin"', ''].join('\n'),
          'utf8',
        );
      },
    });

    try {
      /* 1) 状态里带出「弱」以及原因 */
      const stateWeak = await inst.eval(`(async () => {
        const r = await FRP.refresh();
        return { weak: r.data.app.adminWeak.weak, reasons: r.data.app.adminWeak.reasons || [] };
      })()`);
      ctx.check('弱口令被识别', stateWeak.weak === true && stateWeak.reasons.length > 0, JSON.stringify(stateWeak));

      /* 2) 概览上有那条提示（等 3 秒节拍自己重绘） */
      const noteCount = await inst.eval(`(async () => {
        for (let i = 0; i < 40 && !document.querySelector('.nav-item[data-view="overview"]'); i += 1) await new Promise((r) => setTimeout(r, 250));
        document.querySelector('.nav-item[data-view="overview"]').click();
        for (let i = 0; i < 24; i += 1) {
          const n = [...document.querySelectorAll('#view .note')].filter((x) => /管理 API/.test(x.innerText)).length;
          if (n > 0) return n;
          await new Promise((r) => setTimeout(r, 400));
        }
        return 0;
      })()`);
      ctx.check('概览出现弱口令提示', noteCount === 1, `note=${noteCount}`);

      /* 3) 换成 20 位后提示消失、状态不再弱 */
      const after = await inst.eval(`(async () => {
        const saved = await FRP.saveSettings({ adminPassword: 'abcdefghij23456789ab' });
        for (let i = 0; i < 24; i += 1) {
          const r = await FRP.refresh();
          const n = [...document.querySelectorAll('#view .note')].filter((x) => /管理 API/.test(x.innerText)).length;
          if (r.data.app.adminWeak.weak === false && n === 0) return { saved: saved.ok, weak: false, note: 0 };
          await new Promise((r2) => setTimeout(r2, 400));
        }
        const r2 = await FRP.refresh();
        return { saved: saved.ok, weak: r2.data.app.adminWeak.weak, note: [...document.querySelectorAll('#view .note')].filter((x) => /管理 API/.test(x.innerText)).length };
      })()`);
      ctx.check('换口令后提示消失', after.saved === true && after.weak === false && after.note === 0, JSON.stringify(after));
    } finally {
      /* helper 的 stop() 是同步的（内部 execFileSync），别对它调 .catch */
      try { await inst.stop(); } catch (e) { /* 收尾失败不影响结论 */ }
    }
  },
};
