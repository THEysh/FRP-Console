'use strict';
/* 安全面：SSH 主机指纹的记录、查看与删除。
 * 首次连接记下指纹（TOFU），设置页要能摊开都信任过谁，也能把某台删掉重新记录。 */
const path = require('path');
const { spawn } = require('child_process');
const { ROOT } = require('../helpers/app.cjs');
const { waitPort } = require('../helpers/frps.cjs');

module.exports = {
  id: 'known-hosts',
  title: '首次连接会记录主机指纹，设置页能查看与删除',
  needs: ['app'],
  async run(ctx) {
    const { check } = ctx;
    const port = 22466;
    const sshd = spawn(process.execPath, [path.join(ROOT, 'tests', 'e2e', 'fixtures', 'fake-sshd.cjs'), String(port), 'mixed', 'kh-host', 'kh-token', '1.26.3'], {
      cwd: ROOT,
      stdio: 'ignore',
    });
    try {
      const up = await waitPort(port, '127.0.0.1', 15000);
      check('假 sshd 起来了', up === true);

      /* 用一个干净的数据目录，避免别的场景留下的指纹干扰 */
      const inst = await ctx.startApp({ cdpOffset: 8 });
      try {
        const before = await inst.eval(`(async () => { const r = await FRP.serverKnownHosts(); return r.data.hosts.length; })()`);
        check('新数据目录里没有指纹', before === 0, `count=${before}`);

        const conn = await inst.eval(`FRP.serverConnect({ host: '127.0.0.1', port: ${port}, username: 'root', password: 'labpass', adoptProfile: false })`);
        check('首次连接成功（TOFU 自动信任）', conn.ok === true, conn.error || '');

        const after = await inst.eval(`(async () => { const r = await FRP.serverKnownHosts(); return r.data.hosts; })()`);
        check('首次连接后记录了这台', after.length === 1 && after[0].host === '127.0.0.1' && Number(after[0].port) === port, JSON.stringify(after));
        check('指纹是 SHA256 格式', after.length === 1 && /^SHA256:[A-Za-z0-9+/]+$/.test(after[0].fingerprint), after[0] && after[0].fingerprint);

        const ui = await inst.eval(`(async () => {
          for (let i = 0; i < 40 && !document.querySelector('.nav-item[data-view="settings"]'); i += 1) await new Promise((r) => setTimeout(r, 250));
          document.querySelector('.nav-item[data-view="settings"]').click();
          for (let i = 0; i < 30; i += 1) {
            const rows = document.querySelectorAll('.known-row');
            if (rows.length) return { rows: rows.length, text: (rows[0].innerText || '').replace(/\\s+/g, ' ') };
            await new Promise((r) => setTimeout(r, 300));
          }
          return { rows: 0, text: '' };
        })()`);
        check('设置页列出了这台服务器', ui.rows === 1 && /127\.0\.0\.1/.test(ui.text), JSON.stringify(ui));

        const forgot = await inst.eval(`FRP.serverForgetHost({ host: '127.0.0.1', port: ${port} })`);
        check('删除接口返回成功且列表变空', forgot.ok === true && forgot.data.hosts.length === 0, forgot.error || '');
        const rowsAfter = await inst.eval(`(async () => { const r = await FRP.serverKnownHosts(); return r.data.hosts.length; })()`);
        check('删除后确实没了', rowsAfter === 0, `count=${rowsAfter}`);
      } finally {
        try { await inst.stop(); } catch (e) { /* 收尾失败不影响结论 */ }
      }
    } finally {
      try { sshd.kill(); } catch (e) { /* 已退出 */ }
    }
  },
};
