'use strict';
/* 多服务器切换：连 A → 连 B → 回 A，界面上的「服务器专属状态」（nginx 卡片、
 * 就绪检查、frps 摘要）必须跟着一起换，不能残留上一台。
 * 1.2.39 修过一次 nginx 卡片不刷新；这里把它固定住。
 * 另外顺带覆盖：同一 host:port 连两次不会产生重复档案（1.2.69 的唯一性）。 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const { waitPort } = require('../helpers/frps.cjs');

const SECOND_PORT = Number(process.env.E2E_SSH2_PORT || 22423);

module.exports = {
  id: 'multi-server',
  title: '多服务器切换：nginx 卡片与档案不串台',
  needs: ['app', 'sshd'],
  async run(ctx) {
    const { check, waitFor, sleep } = ctx;
    const fixture = path.join(__dirname, '..', 'fixtures', 'fake-sshd.cjs');

    /* 第二台：没有 nginx、主机名也不同，用来区分「换了服务器」。 */
    const second = spawn(process.execPath, [fixture, String(SECOND_PORT), 'mixed', 'e2e-second', 'e2e-token-second', '', 'fw', '7000', '22/tcp'], {
      cwd: path.join(__dirname, '..', 'fixtures'),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    second.unref();
    try {
      const up = await waitPort(SECOND_PORT, '127.0.0.1', 15000);
      check('第二台假 sshd 已就绪', up === true, `port=${SECOND_PORT}`);

      const connect = (port, host) => ctx.eval(`(async () => {
        const res = await FRP.serverConnect({ host: '127.0.0.1', port: ${port}, username: 'root', password: 'labpass', adoptProfile: false });
        return { ok: !!(res && res.ok), err: (res && res.error) || '', hostname: res && res.data && res.data.info && res.data.info.hostname };
      })()`);

      const a = await connect(ctx.sshPort, 'e2e-server');
      check('连上第一台', a.ok && a.hostname === 'e2e-server', JSON.stringify(a).slice(0, 200));

      const nginxA = await ctx.eval(`(async () => { const r = await FRP.serverNginxState(); return { installed: r.data && r.data.installed, version: r.data && r.data.version }; })()`);
      check('第一台：nginx 已安装', nginxA.installed === true, JSON.stringify(nginxA));

      const b = await connect(SECOND_PORT, 'e2e-second');
      check('切到第二台', b.ok && b.hostname === 'e2e-second', JSON.stringify(b).slice(0, 200));

      /* 切换后前端要自己重新拉一次 nginx 状态（1.2.39 的修复点）。 */
      const nginxB = await waitFor(
        () => ctx.eval(`(async () => {
          const r = await FRP.serverNginxState();
          return { installed: r.data && r.data.installed, version: r.data && r.data.version, names: (r.data && r.data.serverNames) || [] };
        })()`),
        (v) => v && v.installed === false,
        { timeout: 8000, label: '第二台 nginx 状态变为未安装' },
      ).catch((e) => ({ error: String(e.message) }));
      check('第二台：nginx 显示未安装（不继承第一台）', nginxB && nginxB.installed === false, JSON.stringify(nginxB).slice(0, 200));

      /* DOM 也要跟着变，不能停在上一台的「1.26.3 · 就绪」。
       * 先等导航渲染出来——单独跑这一个场景时，界面可能还没画完。 */
      await waitFor(
        () => ctx.eval('!!document.querySelector(\'.nav-item[data-view="server"]\')'),
        (v) => v === true,
        { timeout: 15000, label: '界面渲染完成' },
      );
      const domB = await ctx.eval(`(async () => {
        document.querySelector('.nav-item[data-view="server"]').click();
        await new Promise((r) => setTimeout(r, 700));
        const text = document.getElementById('view').textContent;
        return { mentionsNginx: /nginx/i.test(text), saysNotInstalled: /未安装|安装 nginx|安装并启用/.test(text), saysReady263: /1\\.26\\.3/.test(text) };
      })()`);
      check('第二台：界面不再显示第一台的 nginx 版本', domB.saysReady263 === false, JSON.stringify(domB));

      const backA = await connect(ctx.sshPort, 'e2e-server');
      check('切回第一台', backA.ok && backA.hostname === 'e2e-server', JSON.stringify(backA).slice(0, 200));
      const nginxA2 = await waitFor(
        () => ctx.eval(`(async () => { const r = await FRP.serverNginxState(); return { installed: r.data && r.data.installed, version: r.data && r.data.version }; })()`),
        (v) => v && v.installed === true,
        { timeout: 8000, label: '第一台 nginx 恢复已安装' },
      ).catch((e) => ({ error: String(e.message) }));
      check('回第一台：nginx 状态恢复', nginxA2 && nginxA2.installed === true, JSON.stringify(nginxA2).slice(0, 200));

      /* 档案唯一性：同一个 host:port 连三次，档案数不该增长。 */
      const countProfiles = () => ctx.eval(`(async () => { const r = await FRP.serverState(); return (r.data.profiles || []).length; })()`);
      const before = await countProfiles();
      await connect(ctx.sshPort, 'e2e-server');
      await sleep(600);
      await connect(ctx.sshPort, 'e2e-server');
      await sleep(600);
      const after = await countProfiles();
      check('同一 host:port 反复连接不新增档案', after <= before, `${before} → ${after}`);

      const dupe = await ctx.eval(`(async () => {
        const r = await FRP.serverState();
        const keys = (r.data.profiles || []).map((p) => (String(p.host || '').toLowerCase() + ':' + (Number(p.port) || 22)));
        const seen = new Set();
        const dup = [];
        for (const k of keys) { if (seen.has(k)) dup.push(k); seen.add(k); }
        return { total: keys.length, dup };
      })()`);
      check('档案列表里没有重复的 host:port', (dupe.dup || []).length === 0, JSON.stringify(dupe).slice(0, 240));

      /* 收尾：断开，别把 SSH 会话留给后面的场景。 */
      await ctx.eval(`(async () => { await FRP.serverDisconnect(); return true; })()`);
    } finally {
      try {
        process.kill(second.pid, 'SIGKILL');
      } catch {
        /* ignore */
      }
    }
  },
};
