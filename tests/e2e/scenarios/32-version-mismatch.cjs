'use strict';
/* 服务器 frps 与本机 frpc 版本不一致时，界面必须给出提示。
 * 做法：用假 sshd 把服务器版本改成 0.52.0（本机 frpc 0.61.0）→ 断言状态卡下方出现红色提示；
 *       再换回 0.61.0 → 断言提示消失。
 * 注意：本场景自己起假 sshd，端口固定 22427，不依赖 ctx.sshPort。 */
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..', '..');
const PORT = 22427;

function startSshd(version) {
  return spawn(
    process.execPath,
    [path.join(ROOT, 'tests', 'e2e', 'fixtures', 'fake-sshd.cjs'), String(PORT), 'mixed', 'ver-server', 'token-ver', '', '', '17000', '', '7000', version],
    { stdio: 'ignore' },
  );
}

module.exports = {
  id: 'version-mismatch',
  title: '服务器 frps 与本机 frpc 版本不一致时的提示',
  needs: ['app'],
  async run(ctx) {
    const { check, sleep } = ctx;

    const connectOnce = () => ctx.eval(`(async () => {
      await FRP.serverDisconnect().catch(() => {});
      await FRP.serverForgetHost({ host: '127.0.0.1', port: ${PORT} }).catch(() => {});
      let r = await FRP.serverConnect({ host: '127.0.0.1', port: ${PORT}, username: 'root', password: 'labpass', adoptProfile: false });
      if (!r.ok && r.needsTrustHost) {
        await FRP.serverTrustHost({ host: '127.0.0.1', port: ${PORT}, fingerprint: r.needsTrustHost.fingerprint });
        r = await FRP.serverConnect({ host: '127.0.0.1', port: ${PORT}, username: 'root', password: 'labpass', adoptProfile: false });
      }
      const st = await FRP.serverState().catch(() => ({ data: {} }));
      const d = (st && st.data) || {};
      return { ok: !!r.ok, err: String(r.error || ''), connected: !!d.connected, ver: (d.info && d.info.version) || '' };
    })()`);

    /* 端口刚起/刚停时偶发 ECONNREFUSED，给三次机会 */
    const connect = async () => {
      let last = null;
      for (let i = 0; i < 3; i++) {
        last = await connectOnce();
        if (last && last.ok && last.connected) return last;
        await sleep(900);
      }
      return last;
    };

    const readNote = () => ctx.eval(`(() => {
      const n = [...document.querySelectorAll('#view .note')].find((x) => /版本/.test(x.textContent || ''));
      return n ? { cls: n.className, text: (n.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200) } : null;
    })()`);

    const gotoServer = async () => {
      await ctx.waitUi('.nav-item[data-view="server"]');
      await ctx.eval(`(() => { document.querySelector('.nav-item[data-view="server"]').click(); return 1; })()`);
      await sleep(500);
    };

    /* ---- A：服务器 0.52.0（差 9 个次版本）---- */
    const a = startSshd('0.52.0');
    try {
      await ctx.waitFor(
        () => ctx.eval(`(async () => { const x = await FRP.probeTcp('127.0.0.1', ${PORT}).catch(() => ({})); return !!x.ok; })()`),
        (v) => !!v,
        { timeout: 15000 },
      );
      const c1 = await connect();
      check('连上版本不一致的服务器', !!(c1 && c1.ok && c1.connected), JSON.stringify(c1));
      check('读到服务器版本 0.52.0', /0\.52/.test(String(c1 && c1.ver)), String(c1 && c1.ver));

      await gotoServer();
      const note = await ctx.waitFor(readNote, (v) => !!v, { timeout: 15000 }).catch(() => null);
      check('给出红色版本提示', !!note && /bad/.test(String(note.cls)), JSON.stringify(note));
      check('提示里写明两边版本', !!note && /0\.52/.test(note.text) && /0\.61/.test(note.text), String(note && note.text));
    } finally {
      await ctx.eval(`(async () => { await FRP.serverDisconnect().catch(() => {}); return 1; })()`).catch(() => {});
      a.kill();
      await sleep(700);
    }

    /* ---- B：服务器 0.61.0（与本机一致）---- */
    const b = startSshd('0.61.0');
    try {
      await ctx.waitFor(
        () => ctx.eval(`(async () => { const x = await FRP.probeTcp('127.0.0.1', ${PORT}).catch(() => ({})); return !!x.ok; })()`),
        (v) => !!v,
        { timeout: 15000 },
      );
      const c2 = await connect();
      check('连上同版本服务器', !!(c2 && c2.ok && c2.connected), JSON.stringify(c2));
      await gotoServer();
      const note2 = await readNote();
      check('同版本时没有版本提示', !note2, JSON.stringify(note2));
    } finally {
      await ctx.eval(`(async () => { await FRP.serverDisconnect().catch(() => {}); return 1; })()`).catch(() => {});
      b.kill();
      await sleep(300);
    }
  },
};
