'use strict';
/* 安全面：frps 的 webServer.addr 是 0.0.0.0 时等于把面板摆到公网，
 * 而 frp 在面板没口令时压根不校验身份（谁都能看到 auth.token、改配置、重启 frps）。
 * 这里锁住三种严重程度：空口令=红、口令偏短=橙、够长/仅本机=不提示。
 * 注意：本场景自己起假 sshd（需要 FAKE_FRPS_WEB 改 webServer），不依赖 ctx.sshPort。 */
const path = require('node:path');
const { spawn } = require('node:child_process');

/* __dirname 是 tests/e2e/scenarios，仓库根要再上两级 */
const ROOT = path.join(__dirname, '..', '..', '..');

module.exports = {
  id: 'dashboard-exposure',
  title: '服务器页：frps 面板暴露在公网的风险提示',
  needs: ['app'],
  async run(ctx) {
    const { check, sleep } = ctx;

    const readNote = () =>
      ctx.eval(`(() => {
        const notes = [...document.querySelectorAll('#view .note')].map((n) => ({
          cls: n.className,
          text: (n.textContent || '').replace(/\\s+/g, ' ').trim(),
        }));
        const hit = notes.filter((n) => /面板/.test(n.text));
        return hit.length ? hit[0] : null;
      })()`);

    /* 每个假 sshd 进程一把新主机密钥，1.2.102 起会被拒——显式信任新指纹。 */
    const connectAs = (port) =>
      ctx.eval(`(async () => {
        await FRP.serverDisconnect();
        await FRP.serverForgetHost({ host: '127.0.0.1', port: ${port} });
        const first = await FRP.serverConnect({ host: '127.0.0.1', port: ${port}, username: 'root', password: 'labpass', adoptProfile: false });
        if (first.ok) return { ok: true };
        if (first.needsTrustHost) {
          await FRP.serverTrustHost({ host: '127.0.0.1', port: ${port}, fingerprint: first.needsTrustHost.fingerprint });
          const again = await FRP.serverConnect({ host: '127.0.0.1', port: ${port}, username: 'root', password: 'labpass', adoptProfile: false });
          return { ok: !!again.ok, err: String(again.error || '') };
        }
        return { ok: false, err: String(first.error || '') };
      })()`);

    const wantNote = async (cls) => {
      await ctx.waitUi('.nav-item[data-view="server"]', '导航渲染完成');
      await ctx.eval(`(() => { const c = document.querySelector('.nav-item[data-view="overview"]'); if (c) c.click(); return 1; })()`);
      await sleep(250);
      await ctx.eval(`(() => { document.querySelector('.nav-item[data-view="server"]').click(); return 1; })()`);
      await sleep(600);
      return readNote();
    };

    const spawnSshd = (port, webSpec) =>
      new Promise((resolve) => {
        const child = spawn(
          process.execPath,
          [path.join(ROOT, 'tests/e2e/fixtures/fake-sshd.cjs'), String(port), 'mixed', `exposed-${port}`, 'labpass', '1.26.3', 'none', '7000,17000'],
          { env: { ...process.env, FAKE_FRPS_WEB: webSpec }, stdio: 'ignore' },
        );
        setTimeout(() => resolve(child), 1500);
      });

    const withServer = async (port, webSpec, fn) => {
      const child = await spawnSshd(port, webSpec);
      try {
        const conn = await connectAs(port);
        check(`能连上 :${port}`, conn.ok === true, conn.err || '');
        await fn();
      } finally {
        try { child.kill(); } catch {}
        await sleep(300);
      }
    };

    /* ① 面板 0.0.0.0 + 空口令 → 红色，且点名 token 泄露 */
    await withServer(22455, '0.0.0.0:4096:admin:', async () => {
      const note = await wantNote();
      check('空口令 + 0.0.0.0 → 红色提示', !!note && /note bad/.test(note.cls), note && note.text);
      check('提示里点名 auth.token 泄露风险', !!note && /auth\.token/.test(note.text), note && note.text);
    });

    /* ② 面板 0.0.0.0 + 6 位口令 → 橙色，并给出「改 127.0.0.1」的出路 */
    await withServer(22456, '0.0.0.0:4096:admin:abc123', async () => {
      const note = await wantNote();
      check('6 位口令 + 0.0.0.0 → 橙色提示', !!note && /note warn/.test(note.cls), note && note.text);
      check('提示里给出改 addr 的出路', !!note && /127\.0\.0\.1/.test(note.text), note && note.text);
    });

    /* ③ 面板 0.0.0.0 + 16 位口令 → 不提示 */
    await withServer(22457, '0.0.0.0:4096:admin:Zx9q2Lm7Pw4tRv8K', async () => {
      const note = await wantNote();
      check('16 位口令 + 0.0.0.0 → 不提示', note === null, note && note.text);
    });

    /* ④ 只监听 127.0.0.1（默认）→ 不提示 */
    await withServer(22458, '', async () => {
      const note = await wantNote();
      check('只监听 127.0.0.1 → 不提示', note === null, note && note.text);
    });
  },
};
