'use strict';
/* 1.2.190：代理页全量视图（proxiesAll）+ 跨连接删除。
 *
 * 钉住四件事：
 * 1) proxiesAll 里能同时看到两条连接的代理，各带 connectionId / connectionName / connectionAddr；
 * 2) 界面上表格出现「服务器」列，且多连接时出现筛选 chips；
 * 3) 删除「非当前连接」的代理写的是它自己的文件，当前连接一字未动；
 * 4) 在那条连接上删一个不存在的代理 → 明确报错，不动文件。
 */
const fs = require('node:fs');
const path = require('node:path');

const A = { conn: 'c-default', name: '服务器A', bindPort: 18200, token: 'pg-a-1234567890', adminPort: 7442 };
const B = { conn: 'c-b', name: '服务器B', bindPort: 18300, token: 'pg-b-1234567890', adminPort: 7443 };
const ALL = [A, B];

function frpcToml(s, proxies) {
  const head = [
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
  ];
  for (const p of proxies) {
    head.push('[[proxies]]', `name = "${p.name}"`, 'type = "tcp"', 'localIP = "127.0.0.1"', `localPort = ${p.localPort}`, `remotePort = ${p.remotePort}`, '');
  }
  return head.join('\n');
}

module.exports = {
  id: '73-proxy-global',
  title: '代理页全量视图：服务器列 / 筛选 chips / 跨连接删除',
  needs: ['app'],
  async run(ctx) {
    const { check } = ctx;
    let inst = null;
    try {
      const holder = {};
      inst = await ctx.startApp({
        cdpOffset: 3,
        seed: (dir) => {
          const work = path.join(dir, 'pg');
          fs.mkdirSync(work, { recursive: true });
          holder.work = work;
          const fileOf = (s) => path.join(work, `${s.conn}.toml`);
          fs.writeFileSync(fileOf(A), frpcToml(A, [{ name: 'global-a', localPort: 18080, remotePort: 24301 }]), 'utf8');
          fs.writeFileSync(fileOf(B), frpcToml(B, [{ name: 'global-b', localPort: 18080, remotePort: 24302 }]), 'utf8');
          const ud = path.join(dir, 'frp-console-data');
          fs.mkdirSync(ud, { recursive: true });
          fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({
            version: 2,
            runMode: 'managed',
            adminPort: A.adminPort,
            adminUser: 'admin',
            adminPassword: 'pg-admin-pass-1234',
            configPath: fileOf(A),
            logPath: path.join(work, 'a.log'),
            connections: ALL.map((s) => ({
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
      const work = holder.work;
      const fileOf = (s) => path.join(work, `${s.conn}.toml`);
      const read = (s) => fs.readFileSync(fileOf(s), 'utf8');

      const raw = await inst.eval(`(async()=>{
        const s = await FRP.refresh(); const st = s && s.data ? s.data : s;
        return JSON.stringify((st.proxiesAll||[]).map(p=>({n:p.name,c:p.connectionId,cn:p.connectionName,addr:p.connectionAddr})));
      })()`);
      const all = JSON.parse(raw);
      check('proxiesAll 同时包含两条连接的代理', all.length === 2 && all.some((p) => p.n === 'global-a') && all.some((p) => p.n === 'global-b'), raw);
      check('每条都带连接名与地址', all.every((p) => p.cn && p.addr), raw);

      /* 界面：服务器列 + 筛选 chips */
      const dom = JSON.parse(await inst.eval(`(async()=>{
        document.querySelector('.nav-item[data-view="proxies"]').click();
        await new Promise(r=>setTimeout(r,800));
        const heads = [...document.querySelectorAll('table thead th')].map(t=>t.textContent.trim());
        const chips = [...document.querySelectorAll('.chips .chip')].map(c=>c.textContent.trim());
        const cells = [...document.querySelectorAll('table tbody tr')].map(tr=>tr.textContent.replace(/\\s+/g,' ').trim()).slice(0,4);
        return JSON.stringify({heads, chips, cells});
      })()`));
      check('表头出现「服务器」列', dom.heads.includes('服务器'), JSON.stringify(dom.heads));
      check('多连接时出现筛选 chips（全部 + 两条）', dom.chips.length === 3, JSON.stringify(dom.chips));
      /* 这条场景里隧道没有启动：状态列应该说「隧道未运行」，而不是含糊的「未同步」（1.2.199） */
      check('隧道没跑时状态列写「隧道未运行」', dom.cells.length > 0 && dom.cells.every((c) => !/未同步/.test(c)) && dom.cells.some((c) => /隧道未运行/.test(c)), JSON.stringify(dom.cells));

      /* 隧道没跑时页面上要给一条能直接启动的提示（1.2.207）。 */
      const headActs = await inst.eval(`(function(){ return [...document.querySelectorAll('.page-actions [data-act]')].map(b=>b.dataset.act).join(','); })()`);
      check('隧道没跑时代理页页头不摆「热重载」', !String(headActs).includes('tunnel.reload'), String(headActs));

      const idleNote = JSON.parse(await inst.eval(`(function(){
        const note=[...document.querySelectorAll('.note.warn')].find(n=>/隧道没有在运行/.test(n.textContent||''));
        if(!note) return JSON.stringify({ ok:false });
        const btn=note.querySelector('[data-act=\"conn.toggle\"]');
        return JSON.stringify({ ok:true, hasBtn: !!btn, text: note.innerText.replace(/\\s+/g,' ').slice(0,160) });
      })()`));
      check('隧道没跑时代理页给出启动提示', idleNote.ok === true, JSON.stringify(idleNote).slice(0, 200));
      check('提示里带「启动隧道」按钮（不用切页面）', idleNote.hasBtn === true, JSON.stringify(idleNote).slice(0, 200));

      /* 跨连接删除 */
      const beforeA = read(A);
      const del = JSON.parse(await inst.eval(`(async()=>JSON.stringify(await FRP.deleteProxy('global-b', '${B.conn}')))()`));
      check('删除非当前连接的代理：ok 且点名 connectionId', del.ok === true && del.data && del.data.connectionId === B.conn, JSON.stringify(del).slice(0, 300));
      check('删的是那条连接的文件', !read(B).includes('global-b'), read(B).slice(0, 200));
      check('当前连接一字未动', read(A) === beforeA, 'a.toml 被改动了');

      const bad = JSON.parse(await inst.eval(`(async()=>JSON.stringify(await FRP.deleteProxy('nope', '${B.conn}')))()`));
      check('那条连接里没有这个代理时报错并点名连接', bad.ok === false && /服务器B/.test(bad.error || ''), JSON.stringify(bad).slice(0, 200));
    } finally {
      if (inst) { try { await inst.stop(); } catch {} }
    }
  },
};
