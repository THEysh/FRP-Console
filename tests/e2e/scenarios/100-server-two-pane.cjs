'use strict';
/* 1.2.226：服务器页「左侧常驻服务器列表 + 右侧详情」。
 *
 * 断言：宽屏有左栏（两行 + 「＋ 再连一台」，未配置的标出来），点第二行能切过去；
 * 窄屏（1040）左栏折叠、顶部 chips 回来。 */
const fs = require('fs');
const path = require('path');

function seedTwo(dir) {
  const ud = path.join(dir, 'frp-console-data');
  fs.mkdirSync(ud, { recursive: true });
  const mk = (name, host) => {
    const cfg = path.join(ud, `${name}.toml`);
    fs.writeFileSync(cfg, 'serverAddr = ""\nserverPort = 7000\n', 'utf8');
    return cfg;
  };
  const a = mk('jp', '154.36.178.154');
  const b = mk('gz', '');
  fs.writeFileSync(
    path.join(ud, 'settings.json'),
    JSON.stringify(
      {
        version: 2,
        frpcPath: path.join(dir, 'frpc.exe'),
        configPath: a,
        connections: [
          { id: 'c-jp', name: '日本frp', configPath: a, adminPort: 7496, host: '154.36.178.154', port: 22, username: 'root' },
          { id: 'c-gz', name: '广州frp', configPath: b, adminPort: 7497, host: '', port: 22, username: 'root' },
        ],
        activeConnectionId: 'c-jp',
      },
      null,
      2,
    ),
    'utf8',
  );
}

module.exports = {
  id: 'server-two-pane',
  title: '服务器页：左侧服务器列表 + 右侧详情（窄屏折叠）',
  needs: ['app'],
  async run(ctx) {
    const inst = await ctx.startApp({ cdpOffset: 19, seed: seedTwo });
    const ev = (expr) => inst.eval(expr);

    try {
      await inst.emulate(1440, 900);
      await ctx.waitFor(
        () => ev(`!!document.querySelector('.nav-item[data-view="server"]')`),
        (v) => v === true,
        { timeout: 30000, label: '侧栏就绪' },
      );
      await ev(`(function(){ document.querySelector('.nav-item[data-view="server"]').click(); return true; })()`);
      await ctx.waitFor(
        () => ev(`!!document.querySelector('.server-layout')`),
        (v) => v === true,
        { timeout: 20000, label: '两栏骨架' },
      );

      const wide = JSON.parse(
        await ev(`(function(){
          const list = document.querySelector('.server-list');
          const items = [...document.querySelectorAll('.server-list .sl-item')];
          return JSON.stringify({
            hasLayout: !!document.querySelector('.server-layout'),
            hasList: !!list,
            listVisible: !!(list && list.offsetParent),
            count: items.length,
            names: items.map((i) => (i.querySelector('.sl-name') || {}).textContent || ''),
            addrs: items.map((i) => (i.querySelector('.sl-addr') || {}).textContent || ''),
            unset: items.filter((i) => i.querySelector('.sl-addr.unset')).length,
            active: items.filter((i) => i.classList.contains('on')).length,
            hasAdd: document.querySelectorAll('.server-list .sl-add').length,
            chipsHidden: (function(){ const c = document.querySelector('.server-chips'); return !c || !c.offsetParent; })(),
          });
        })()`),
      );

      ctx.check('宽屏有两栏骨架', wide.hasLayout === true, String(wide.hasLayout));
      ctx.check('左栏可见', wide.listVisible === true, String(wide.listVisible));
      ctx.check('左栏两条连接', wide.count === 2, String(wide.count));
      ctx.check('行里显示名字与地址', wide.names.join(',') === '日本frp,广州frp' && /154\.36\.178\.154:22/.test(wide.addrs[0]), JSON.stringify(wide));
      ctx.check('未配置地址的那条被标出来', wide.unset === 1, JSON.stringify(wide.addrs));
      ctx.check('恰好一条是当前', wide.active === 1, String(wide.active));
      ctx.check('左栏底部有「再连一台」', wide.hasAdd === 1, String(wide.hasAdd));
      ctx.check('宽屏隐藏顶部 chips 行', wide.chipsHidden === true, String(wide.chipsHidden));

      /* 点第二行 → 切到广州 */
      const switched = JSON.parse(
        await ev(`(async () => {
          const items = [...document.querySelectorAll('.server-list .sl-item')];
          const target = items.find((i) => (i.querySelector('.sl-name') || {}).textContent.includes('广州'));
          if (!target) return JSON.stringify({ missing: true });
          target.click();
          await new Promise((r) => setTimeout(r, 3000));
          const res = await FRP.refresh();
          const st = res.data || res;
          return JSON.stringify({ active: st.activeConnectionId || '', on: [...document.querySelectorAll('.server-list .sl-item.on')].map((i) => (i.querySelector('.sl-name') || {}).textContent) });
        })()`),
      );
      ctx.check('点第二行切到广州frp', switched.active === 'c-gz', JSON.stringify(switched));
      ctx.check('高亮跟着换', Array.isArray(switched.on) && switched.on.length === 1 && /广州/.test(switched.on[0]), JSON.stringify(switched.on));

      /* 窄屏：左栏折叠、chips 回来 */
      await inst.emulate(1040, 680);
      await ctx.sleep(400);
      const narrow = JSON.parse(
        await ev(`(function(){
          const list = document.querySelector('.server-list');
          const chips = document.querySelector('.server-chips');
          return JSON.stringify({
            listHidden: !list || !list.offsetParent,
            chipsVisible: !!(chips && chips.offsetParent),
            overflow: document.querySelector('#view').scrollWidth > document.querySelector('#view').clientWidth + 2,
          });
        })()`),
      );
      ctx.check('窄屏折叠左栏', narrow.listHidden === true, JSON.stringify(narrow));
      ctx.check('窄屏顶部 chips 回来', narrow.chipsVisible === true, JSON.stringify(narrow));
      ctx.check('窄屏没有横向溢出', narrow.overflow === false, JSON.stringify(narrow));
    } finally {
      try { await inst.emulate(0, 0); } catch { /* 忽略 */ }
      inst.stop();
    }
  },
};
