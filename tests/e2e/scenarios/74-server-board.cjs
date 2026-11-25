'use strict';
/* 1.2.191：服务器页多服务器看板。
 *
 * 钉住四件事：
 * 1) 两条连接时，服务器页顶部出现连接 chips（每条一个）；
 * 2) 「切换隧道并重启 / 仅查看」这两个按钮彻底消失（多连接下它只会打断正在跑的业务）；
 * 3) 页面上有「启动隧道 / 停止隧道」按钮，作用于当前连接；
 * 4) 点另一个 chip → 当前连接真的切过去了（activeConnectionId 变化）。
 */
const fs = require('node:fs');
const path = require('node:path');

const A = { conn: 'c-default', name: '服务器A', bindPort: 18400, token: 'sb-a-1234567890', adminPort: 7452 };
const B = { conn: 'c-b', name: '服务器B', bindPort: 18500, token: 'sb-b-1234567890', adminPort: 7453 };

function frpcToml(s) {
  return [
    'serverAddr = "127.0.0.1"',
    `serverPort = ${s.bindPort}`,
    'loginFailExit = false',
    '',
    '[auth]',
    'method = "token"',
    `token = "${s.token}"`,
    '',
    '[webServer]',
    'addr = "127.0.0.1"',
    `port = ${s.adminPort}`,
    'user = "admin"',
    'password = "admin"',
    '',
  ].join('\n');
}

module.exports = {
  id: '74-server-board',
  title: '服务器页多服务器看板：连接 chips / 无「切换隧道并重启」/ 隧道按钮',
  needs: ['app'],
  async run(ctx) {
    const { check } = ctx;
    let inst = null;
    try {
      inst = await ctx.startApp({
        cdpOffset: 4,
        seed: (dir) => {
          const work = path.join(dir, 'sb');
          fs.mkdirSync(work, { recursive: true });
          const fileOf = (s) => path.join(work, `${s.conn}.toml`);
          for (const s of [A, B]) fs.writeFileSync(fileOf(s), frpcToml(s), 'utf8');
          const ud = path.join(dir, 'frp-console-data');
          fs.mkdirSync(ud, { recursive: true });
          fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({
            version: 2,
            runMode: 'managed',
            adminPort: A.adminPort,
            adminUser: 'admin',
            adminPassword: 'sb-admin-pass-1234',
            configPath: fileOf(A),
            logPath: path.join(work, 'a.log'),
            connections: [A, B].map((s) => ({
              id: s.conn,
              name: s.name,
              enabled: true,
              configPath: fileOf(s),
              logPath: path.join(work, `${s.conn}.log`),
              adminPort: s.adminPort,
            })),
            activeConnectionId: A.conn,
          }, null, 2), 'utf8');
        },
      });

      const dom = JSON.parse(await inst.eval(`(async()=>{
        document.querySelector('.nav-item[data-view="server"]').click();
        await new Promise(r=>setTimeout(r,900));
        const chips = [...document.querySelectorAll('.server-chips .chip')].map(c=>c.textContent.trim());
        const applyBtn = document.querySelector('[data-act="server.apply"]');
        const applyKeep = document.querySelector('[data-act="server.apply.keep"]');
        const tunnelBtn = document.querySelector('.page-actions [data-act="conn.toggle"]') || document.querySelector('[data-act="conn.toggle"]');
        const allActs = [...document.querySelectorAll('[data-act]')].map(e=>e.dataset.act);
        return JSON.stringify({
          chips,
          hasApply: !!applyBtn,
          hasApplyKeep: !!applyKeep,
          tunnelBtn: tunnelBtn ? tunnelBtn.textContent.trim() : '',
          badText: document.body.textContent.includes('切换隧道并重启'),
          acts: allActs,
        });
      })()`));

      check('顶部出现两条连接的 chips', dom.chips.length === 2 && dom.chips.some((c) => c.includes('服务器A')) && dom.chips.some((c) => c.includes('服务器B')), JSON.stringify(dom.chips));
      check('「切换隧道并重启」按钮已移除', dom.hasApply === false && dom.hasApplyKeep === false, JSON.stringify({ a: dom.hasApply, k: dom.hasApplyKeep }));
      check('页面上不再出现该文案', dom.badText === false, '仍能找到「切换隧道并重启」');
      check('有作用于当前连接的隧道启停按钮', /启动隧道|停止隧道/.test(dom.tunnelBtn), dom.tunnelBtn);

      /* 点另一个 chip：当前连接切过去 */
      const switched = JSON.parse(await inst.eval(`(async()=>{
        const chips = [...document.querySelectorAll('.server-chips .chip')];
        const target = chips.find(c=>c.textContent.includes('服务器B'));
        if (!target) return JSON.stringify({ err: 'no chip' });
        target.click();
        await new Promise(r=>setTimeout(r,2600));
        const s = await FRP.refresh(); const st = s && s.data ? s.data : s;
        return JSON.stringify({ active: st.activeConnectionId, xstate: (window.__x||null), onClass: [...document.querySelectorAll('.server-chips .chip')].map(c=>c.classList.contains('on')), texts: [...document.querySelectorAll('.server-chips .chip')].map(c=>c.textContent.trim()) });
      })()`));
      check('点 chip 后当前连接切到服务器B', switched.active === B.conn, JSON.stringify(switched));
      check('选中的 chip 高亮跟着换', Array.isArray(switched.onClass) && switched.onClass[1] === true, JSON.stringify(switched.onClass));

    /* 连接标签上的计数要说清是「在线代理数」，只写 0/1 看不出含义（1.2.208）。 */
    const chipText = await inst.eval(`[...document.querySelectorAll('.server-chips .chip')].map(c=>c.textContent.replace(/\\s+/g,' ').trim()).join(' | ')`)
      .catch(() => '');
    const chipStr = String(chipText || '');
    ctx.check('连接标签的计数写成「在线 x/y」或「暂无代理」', /在线\s*\d+\/\d+|暂无代理/.test(chipStr), chipStr.slice(0, 160));
    } finally {
      if (inst) { try { await inst.stop(); } catch {} }
    }
  },
};
