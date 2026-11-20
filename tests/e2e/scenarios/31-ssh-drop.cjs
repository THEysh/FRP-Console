'use strict';
/* 破坏与恢复：SSH 会话中途断掉（服务器重启 / 网络抖动）时界面要尽快反映；
 * sshd 重启后主机密钥变了，连接必须被拒并说清楚，信任新指纹后能恢复。
 *
 * 用独立实例跑：主机指纹是「首次信任」式的持久状态，和别的场景共用实例会互相干扰。 */
const { spawn, execFileSync } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

/* 本文件在 tests/e2e/scenarios/ 下，仓库根要上三级（少算一级会 Cannot find module） */
const ROOT = path.join(__dirname, '..', '..', '..');
const PORT = 22524;

module.exports = {
  id: 'ssh-drop',
  title: 'SSH 中途断开能及时发现；主机密钥变了会被拒并可信任后恢复',
  needs: ['app'],
  async run(ctx) {
    const startSshd = () =>
      spawn(process.execPath, [path.join(ROOT, 'tests', 'e2e', 'fixtures', 'fake-sshd.cjs'), String(PORT), 'mixed', 'drop-test', 'tok'], { stdio: 'ignore' });
    const kill = (pid) => {
      try {
        execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
      } catch {}
    };
    const waitPort = async (want = true, timeout = 12000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const open = await new Promise((resolve) => {
          const s = net.connect({ host: '127.0.0.1', port: PORT }, () => { s.destroy(); resolve(true); });
          s.on('error', () => resolve(false));
          s.setTimeout(600, () => { s.destroy(); resolve(false); });
        });
        if (open === want) return true;
        await new Promise((r) => setTimeout(r, 300));
      }
      return false;
    };

    const inst = await ctx.startApp({ cdpOffset: 4 });
    let sshd = null;
    try {
      sshd = startSshd();
      ctx.check('假 sshd 端口已就绪', await waitPort(true));

      const conn = await inst.eval(`(async () => { const r = await FRP.serverConnect({ host: '127.0.0.1', port: ${PORT}, username: 'root', password: 'labpass', adoptProfile: false, remember: false }); return { ok: r.ok, hostname: r.ok && r.data.info && r.data.info.hostname, error: String(r.error || '').slice(0, 100) }; })()`);
      ctx.check('能连上假 sshd', conn.ok === true, conn.error);
      ctx.check('拿到主机名 drop-test', conn.hostname === 'drop-test', String(conn.hostname));

      /* 杀掉 sshd，模拟服务器中途断掉 */
      kill(sshd.pid);
      sshd = null;
      await waitPort(false, 8000);
      const flipped = await ctx
        .waitFor(
          () => inst.eval(`(async () => { const r = await FRP.serverState(); return r.data.connected; })()`),
          (v) => v === false,
          { timeout: 40000, label: '界面识别到 SSH 断开' },
        )
        .then(() => true)
        .catch(() => false);
      ctx.check('40 秒内自动识别到断开（不会一直显示已连接）', flipped === true);

      /* sshd 重新起来：主机密钥是新的 */
      sshd = startSshd();
      await waitPort(true);
      const again = await inst.eval(`(async () => { const r = await FRP.serverConnect({ host: '127.0.0.1', port: ${PORT}, username: 'root', password: 'labpass', adoptProfile: false, remember: false }); return { ok: r.ok, error: String(r.error || ''), fp: r.needsTrustHost && r.needsTrustHost.fingerprint }; })()`);
      ctx.check('换了主机密钥后连接被拒绝', again.ok === false, JSON.stringify(again).slice(0, 120));
      ctx.check('错误里说明「主机密钥与上次记录的不一致」', /主机密钥与上次记录的不一致/.test(again.error), again.error.slice(0, 60));
      ctx.check('两个指纹都摊开给用户看', /上次：SHA256:/.test(again.error) && /现在：SHA256:/.test(again.error));
      ctx.check('返回 needsTrustHost 供界面弹确认框', !!again.fp);

      if (again.fp) {
        const trusted = await inst.eval(`(async () => { const r = await FRP.serverTrustHost({ host: '127.0.0.1', port: ${PORT}, fingerprint: ${JSON.stringify(again.fp)} }); return { ok: r.ok }; })()`);
        ctx.check('可以信任新指纹', trusted.ok === true);
        const third = await inst.eval(`(async () => { const r = await FRP.serverConnect({ host: '127.0.0.1', port: ${PORT}, username: 'root', password: 'labpass', adoptProfile: false, remember: false }); return { ok: r.ok }; })()`);
        ctx.check('信任之后能连上', third.ok === true);
      }
    } finally {
      if (sshd) kill(sshd.pid);
      await inst.eval(`(async () => { await FRP.serverDisconnect(); return 1; })()`).catch(() => {});
      await inst.stop();
    }
  },
};
