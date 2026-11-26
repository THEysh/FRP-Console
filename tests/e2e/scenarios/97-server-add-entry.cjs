'use strict';
/* 1.2.225：服务器页必须有「加第二台服务器」的入口（以前单连接时是死路），
 * 并且页头那个重复的「断开 SSH」被换成「＋ 再连一台」（只剩连接卡里那一个）。
 *
 * 两个状态都要验：未连接（只有连接表单）与已连接（整页详情）。 */
const fs = require('fs');
const path = require('path');

function seedOne(dir) {
  const ud = path.join(dir, 'frp-console-data');
  fs.mkdirSync(ud, { recursive: true });
  const cfg = path.join(ud, 'a.toml');
  fs.writeFileSync(cfg, 'serverAddr = ""\nserverPort = 7000\n', 'utf8');
  fs.writeFileSync(
    path.join(ud, 'settings.json'),
    JSON.stringify(
      {
        version: 2,
        frpcPath: path.join(dir, 'frpc.exe'),
        configPath: cfg,
        connections: [{ id: 'c-only', name: '唯一一台', configPath: cfg, adminPort: 7495, host: '', port: 22, username: 'root' }],
        activeConnectionId: 'c-only',
      },
      null,
      2,
    ),
    'utf8',
  );
}

module.exports = {
  id: 'server-add-entry',
  title: '服务器页：单连接时也有「再连一台」入口，断开 SSH 只剩一个',
  needs: ['app', 'sshd'],
  async run(ctx) {
    const inst = await ctx.startApp({ cdpOffset: 18, seed: seedOne });
    const ev = (expr) => inst.eval(expr);

    const headInfo = () =>
      ev(`(function(){
        const actions = document.querySelector('.page-head .page-actions');
        const acts = actions ? [...actions.querySelectorAll('[data-act]')].map((b) => b.dataset.act) : [];
        return JSON.stringify({
          addTexts: actions ? [...actions.querySelectorAll('[data-act="conn.add"]')].map((b) => b.textContent.replace(/\\s+/g,' ').trim()) : [],
          disconnectInHead: actions ? actions.querySelectorAll('[data-act="server.disconnect"]').length : -1,
          disconnectTotal: document.querySelectorAll('[data-act="server.disconnect"]').length,
        });
      })()`);

    try {
      await ctx.waitFor(
        () => ev(`!!document.querySelector('.nav-item[data-view="server"]')`),
        (v) => v === true,
        { timeout: 30000, label: '侧栏就绪' },
      );
      await ev(`(function(){ document.querySelector('.nav-item[data-view="server"]').click(); return true; })()`);
      await ctx.waitFor(
        () => ev(`!!document.querySelector('.page-head .page-actions')`),
        (v) => v === true,
        { timeout: 20000, label: '服务器页渲染（未连接）' },
      );

      /* ① 未连接状态 */
      const head1 = JSON.parse(await headInfo());
      ctx.check('未连接时页头也有「再连一台」', head1.addTexts.length === 1 && /再连一台/.test(head1.addTexts[0]), JSON.stringify(head1.addTexts));
      ctx.check('未连接时页头没有「断开 SSH」', head1.disconnectInHead === 0, String(head1.disconnectInHead));

      const chips = JSON.parse(
        await ev(`(function(){
          const box = document.querySelector('.server-chips');
          if (!box) return JSON.stringify({ missing: true });
          return JSON.stringify({
            chips: [...box.querySelectorAll('.chip')].map((c) => c.textContent.replace(/\\s+/g,' ').trim()),
            addChip: box.querySelectorAll('.chip.add').length,
            active: [...box.querySelectorAll('.chip')].filter((c) => c.classList.contains('on')).length,
          });
        })()`),
      );
      ctx.check('单连接时也显示服务器标签行', !chips.missing, JSON.stringify(chips.missing || false));
      ctx.check('标签行里恰好一个当前服务器', chips.active === 1, JSON.stringify(chips.chips));
      ctx.check('标签行末尾有「再连一台」', chips.addChip === 1 && chips.chips.some((c) => /再连一台/.test(c)), JSON.stringify(chips.chips));

      const clicked = await ev(`(function(){ const b = document.querySelector('.page-head [data-act="conn.add"]'); if (!b) return 'missing'; b.click(); return 'ok'; })()`);
      const dialog = JSON.parse(
        await ev(`(function(){
          const m = document.querySelector('.modal-root .modal, .modal-root');
          const text = m ? m.textContent.replace(/\\s+/g,' ').trim() : '';
          return JSON.stringify({ shown: !!m, text: text.slice(0, 120) });
        })()`),
      );
      ctx.check('点「再连一台」弹出命名对话框', clicked === 'ok' && dialog.shown === true && /再连一台/.test(dialog.text), `${clicked} / ${dialog.text}`);
      await ev(`(function(){ document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()`);

      /* ② 连上假 sshd 后再看一遍 */
      const conn = JSON.parse(
        await ev(`(async () => {
          const res = await FRP.serverConnect({ host: '127.0.0.1', port: ${ctx.sshPort}, username: 'root', password: 'labpass', adoptProfile: false });
          return JSON.stringify({ ok: !!(res && res.ok), err: (res && res.error) || '' });
        })()`),
      );
      ctx.check('能连上服务器', conn.ok === true, JSON.stringify(conn).slice(0, 200));

      await ev(`(function(){ document.querySelector('.nav-item[data-view="server"]').click(); return true; })()`);
      await ctx.waitFor(
        () => ev(`!!document.querySelector('.server-status-card')`),
        (v) => v === true,
        { timeout: 25000, label: '服务器详情渲染' },
      );

      const head2 = JSON.parse(await headInfo());
      ctx.check('已连接时页头仍有「再连一台」', head2.addTexts.length === 1, JSON.stringify(head2.addTexts));
      ctx.check('已连接时页头没有「断开 SSH」', head2.disconnectInHead === 0, String(head2.disconnectInHead));
      ctx.check('整页「断开 SSH」只剩一个（在连接卡里）', head2.disconnectTotal === 1, String(head2.disconnectTotal));
    } finally {
      try { await ev('FRP.serverDisconnect()'); } catch { /* 忽略 */ }
      inst.stop();
    }
  },
};
