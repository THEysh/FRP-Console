'use strict';
/* 1.2.227：两个用户反馈的 bug —
 *  ① 切换当前连接后，页面还把上一台的 SSH 会话状态显示在新连接名下；
 *  ② 给「还没填地址的连接」填地址时弹「地址与档案不一致」，只有「另存为新档案」才放行。
 *
 * 这里验的是修完后的行为：切换即解绑 SSH；填地址就是改这条连接（不再有任何决策框）；
 * 同一台机器不允许两条连接。 */
const fs = require('fs');
const path = require('path');

function seedThree(dir, sshPort) {
  const ud = path.join(dir, 'frp-console-data');
  fs.mkdirSync(ud, { recursive: true });
  const mk = (name) => {
    const cfg = path.join(ud, `${name}.toml`);
    fs.writeFileSync(cfg, 'serverAddr = ""\nserverPort = 7000\n', 'utf8');
    return cfg;
  };
  const aCfg = mk('a');
  const bCfg = mk('b');
  const cCfg = mk('c');
  fs.writeFileSync(
    path.join(ud, 'settings.json'),
    JSON.stringify(
      {
        version: 2,
        frpcPath: path.join(dir, 'frpc.exe'),
        configPath: aCfg,
        adminPort: 7460,
        adminUser: 'admin',
        adminPassword: 'rebind-pass-123456',
        connections: [
          { id: 'c-mig-a01', name: '日本frp', host: '127.0.0.1', port: sshPort, username: 'root', configPath: aCfg, adminPort: 7460, enabled: true },
          { id: 'c-mig-b01', name: '广州frp', host: '', port: 22, username: 'root', configPath: bCfg, adminPort: 7461, enabled: true },
          { id: 'c-mig-c01', name: '第三台', host: '', port: 22, username: 'root', configPath: cCfg, adminPort: 7462, enabled: true },
        ],
        activeConnectionId: 'c-mig-a01',
      },
      null,
      2,
    ),
    'utf8',
  );
}

module.exports = {
  id: 'conn-rebind',
  title: '连接切换会解绑 SSH；给连接填地址不再弹「档案不一致」',
  needs: ['app', 'sshd'],

  async run(ctx) {
    const sshPort = ctx.sshPort;
    const inst = await ctx.startApp({ cdpOffset: 41, seed: (dir) => seedThree(dir, sshPort) });
    const ev = (expr) => inst.eval(expr);

    try {
      await ctx.waitFor(
        () => ev(`!!document.querySelector('.nav-item[data-view="server"]')`),
        (v) => v === true,
        { timeout: 30000, label: '侧栏就绪' },
      );

      /* ① 连上 A（会话连着 127.0.0.1） */
      const c1 = JSON.parse(
        await ev(`(async () => {
          const r = await FRP.serverConnect({ connectionId: 'c-mig-a01', host: '127.0.0.1', port: ${sshPort}, username: 'root', password: 'labpass', remember: true });
          return JSON.stringify({ ok: r.ok, error: r.error, connected: r.data && r.data.connected });
        })()`),
      );
      ctx.check('连上第一条连接（会话在 127.0.0.1）', c1.ok === true && c1.connected === true, JSON.stringify(c1).slice(0, 200));

      /* ② 切到 B（B 没有地址）→ 必须断开 A 的 SSH，并且页面不再显示 A 的详情 */
      const c2 = JSON.parse(
        await ev(`(async () => {
          const r = await FRP.connectionActive('c-mig-b01');
          const s = await FRP.serverState();
          return JSON.stringify({
            ok: r.ok,
            sshDropped: (r.data && r.data.sshDropped) || '',
            connected: s.data && s.data.connected,
            hasInfo: !!(s.data && s.data.info),
          });
        })()`),
      );
      ctx.check('切换连接时记录了被断开的 SSH', c2.ok === true && c2.sshDropped.indexOf('127.0.0.1') >= 0, JSON.stringify(c2));
      ctx.check('切换后会话已断开、详情已清空', c2.connected === false && c2.hasInfo === false, JSON.stringify(c2));

      /* ③ 页面应回到「连接 frps 服务器」表单，而不是上一台的状态卡 */
      await ctx.waitFor(
        () => ev(`(async () => { document.querySelector('.nav-item[data-view="server"]').click(); await new Promise((r) => setTimeout(r, 900)); return !!document.querySelector('#server-form'); })()`),
        (v) => v === true,
        { timeout: 25000, label: '切换后回到连接表单' },
      );
      const pageText = await ev(`(function(){ const v = document.querySelector('#view'); return v ? v.textContent.replace(/\\s+/g,' ').slice(0, 300) : ''; })()`);
      ctx.check('切换后页面不再显示上一台的状态卡', !/运行状态/.test(String(pageText)), String(pageText).slice(0, 120));
      ctx.check('切换后显示连接表单（填地址）', /连接 frps 服务器/.test(String(pageText)), String(pageText).slice(0, 120));

      /* ④ 给 B 填地址并连接：不应出现「档案不一致」的决策 */
      const c4 = JSON.parse(
        await ev(`(async () => {
          const r = await FRP.serverConnect({ connectionId: 'c-mig-b01', host: '127.0.0.1', port: ${sshPort}, username: 'root', password: 'labpass', remember: true });
          const st = await FRP.connections();
          const b = ((st.data && st.data.connections) || []).find((x) => x.id === 'c-mig-b01') || {};
          return JSON.stringify({ ok: r.ok, error: r.error, needsDecision: r.needsDecision || '', repointed: r.data && r.data.repointed, host: b.host, port: b.port });
        })()`),
      );
      ctx.check('填地址直接连接成功（没有档案决策框）', c4.ok === true && !c4.needsDecision, JSON.stringify(c4).slice(0, 200));
      ctx.check('这条连接的地址被更新为输入值', c4.host === '127.0.0.1' && Number(c4.port) === Number(sshPort), JSON.stringify(c4));

      /* ⑤ 同一台机器不允许两条连接 */
      const c5 = JSON.parse(
        await ev(`(async () => {
          // 先把 A 挪开，确保 127.0.0.1 上只剩 B（正在连的那条），冲突才会点名 B。
          await FRP.connectionUpdate({ id: 'c-mig-a01', host: '127.0.0.9' });
          const r = await FRP.connectionUpdate({ id: 'c-mig-c01', host: '127.0.0.1', port: ${sshPort} });
          return JSON.stringify({ ok: r.ok, error: r.error });
        })()`),
      );
      ctx.check('同一台机器只允许一条连接（点名占用者）', c5.ok === false && String(c5.error || '').indexOf('广州frp') >= 0, JSON.stringify(c5));

      /* ⑥ 改地址时必须重新输入密码：B 现在连着，先断开，再把地址改成另一个（模拟换机） */
      const c6 = JSON.parse(
        await ev(`(async () => {
          await FRP.serverDisconnect();
          const r = await FRP.serverConnect({ connectionId: 'c-mig-b01', host: '127.0.0.2', port: ${sshPort}, username: 'root' });
          return JSON.stringify({ ok: r.ok, needsPassword: !!r.needsPassword, error: r.error || '' });
        })()`),
      );
      ctx.check('改地址且没带密码时，要求重新输入（不复用旧机器的密码）', c6.ok === false && c6.needsPassword === true && c6.error.indexOf('原来的地址') >= 0, JSON.stringify(c6).slice(0, 200));
    } finally {
      try { await ev('FRP.serverDisconnect()'); } catch { /* 忽略 */ }
      inst.stop();
    }
  },
};
