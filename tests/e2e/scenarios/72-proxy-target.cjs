'use strict';
/* 1.2.189：代理可以指定「目标服务器」= 写进哪一条连接的 frpc.toml。
 *
 * 钉住六件事：
 * 1) 传 connectionId 时写的是那条连接的配置文件，当前连接的文件一字不动；
 * 2) 两条连接可以各有一个同名代理；
 * 3) 同一条连接内重名仍然拒绝；
 * 4) 同一台机器上跑两个 frps（端口不同）时，同公网端口不算冲突；
 * 5) 两条连接连同一台 frps（同 addr+port）时，端口重复要报冲突；
 * 6) 目标连接没有服务器地址时明确拒绝，不写坏文件。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const frpsHelper = require('../helpers/frps.cjs');

const A = { conn: 'c-default', name: '服务器A', bindPort: 18000, dashPort: 18020, token: 'pt-a-1234567890', adminPort: 7432 };
const B = { conn: 'c-b', name: '服务器B', bindPort: 18100, dashPort: 18120, token: 'pt-b-1234567890', adminPort: 7433 };
/* 第三台：和 A 连的是**同一台 frps**（同 addr+port），用来验冲突。 */
const C = { conn: 'c-c', name: '服务器A副本', bindPort: 18000, dashPort: 18030, token: 'pt-c-1234567890', adminPort: 7434 };

const ALL = [A, B, C];

function frpcToml(s, port = '') {
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
    `port = ${port || s.adminPort}`,
    'user = "admin"',
    'password = "admin"',
    '',
  ].join('\n');
}

module.exports = {
  id: '72-proxy-target',
  title: '代理指定目标服务器：写对文件 / 跨连接同名 / 端口冲突按 addr+port 判',
  needs: ['app', 'frpc'],
  async run(ctx) {
    const { check } = ctx;
    const frpsBin = frpsHelper.findFrps();
    if (!frpsBin) { check('找到 frps 二进制', false, '需要 frps 才能验「配置真的写进那条连接」'); return; }

    const procs = [];
    const startFrps = async (s, work) => {
      const cfg = path.join(work, `frps-${s.dashPort}.toml`);
      fs.writeFileSync(cfg, [
        'bindAddr = "127.0.0.1"', `bindPort = ${s.bindPort}`, '',
        '[auth]', 'method = "token"', `token = "${s.token}"`, '',
        '[webServer]', 'addr = "127.0.0.1"', `port = ${s.dashPort}`, 'user = "admin"', 'password = "admin"', '',
      ].join('\n'), 'utf8');
      const p = spawn(frpsBin, ['-c', cfg], { stdio: 'ignore', windowsHide: true });
      procs.push(p);
      await frpsHelper.waitPort(s.bindPort, '127.0.0.1', 8000);
    };

    let inst = null;
    try {
      /* 数据目录在 seed 回调里就位：三条连接各一份 frpc.toml，c-default 是当前连接。 */
      const workHolder = {};
      inst = await ctx.startApp({
        cdpOffset: 2,
        seed: (dir) => {
          const work = path.join(dir, 'pt');
          fs.mkdirSync(work, { recursive: true });
          workHolder.work = work;
          const fileOf = (s) => path.join(work, `${s.conn}.toml`);
          for (const s of ALL) fs.writeFileSync(fileOf(s), frpcToml(s), 'utf8');
          const ud = path.join(dir, 'frp-console-data');
          fs.mkdirSync(ud, { recursive: true });
          fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({
            version: 2,
            runMode: 'managed',
            adminPort: A.adminPort,
            adminUser: 'admin',
            adminPassword: 'pt-admin-pass-1234',
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
      const work = workHolder.work;
      const fileOf = (s) => path.join(work, `${s.conn}.toml`);
      const read = (s) => (fs.existsSync(fileOf(s)) ? fs.readFileSync(fileOf(s), 'utf8') : '');
      await startFrps(A, work);
      await startFrps(B, work);

      const list = await inst.eval(`(async()=>{
        const s = await FRP.refresh(); const st = s && s.data ? s.data : s;
        return JSON.stringify((st.connections||[]).map(c=>({id:c.id,name:c.name,addr:c.serverAddr||''})));
      })()`);
      const conns = JSON.parse(list);
      check('三条连接都在，且带 serverAddr 供下拉标注', conns.length === 3 && conns.every((c) => 'addr' in c), JSON.stringify(conns));

      /* 1) 写进「服务器B」 */
      const beforeA = read(A);
      const r1 = JSON.parse(await inst.eval(
        `(async()=>JSON.stringify(await FRP.saveProxy('add','',{name:'shared',type:'tcp',localIP:'127.0.0.1',localPort:18080,remotePort:24101}, '${B.conn}')))()`,
      ));
      check('写到非当前连接：ok 且点名 connectionId', r1.ok === true && r1.data && r1.data.connectionId === B.conn, JSON.stringify(r1).slice(0, 300));
      check('配置写进了那条连接的文件', read(B).includes('name = "shared"'), read(B).slice(0, 300));
      check('当前连接的配置一字未动', read(A) === beforeA, 'a.toml 被改动了');

      /* 2) 同名再写到当前连接（不同服务器）→ 允许 */
      const r2 = JSON.parse(await inst.eval(
        `(async()=>JSON.stringify(await FRP.saveProxy('add','',{name:'shared',type:'tcp',localIP:'127.0.0.1',localPort:18080,remotePort:24102})))()`,
      ));
      check('两条连接可以同名', r2.ok === true, JSON.stringify(r2).slice(0, 300));
      check('当前连接的配置里出现了同名代理', read(A).includes('name = "shared"'));

      /* 3) 同一条连接里再建同名 → 拒绝 */
      const r3 = JSON.parse(await inst.eval(
        `(async()=>JSON.stringify(await FRP.saveProxy('add','',{name:'shared',type:'tcp',localIP:'127.0.0.1',localPort:18080,remotePort:24103}, '${B.conn}')))()`,
      ));
      check('同一条连接内重名被拒', r3.ok === false && /已存在/.test(r3.error || ''), JSON.stringify(r3).slice(0, 200));

      /* 4) 不同 frps 端口 → 同公网端口不算冲突 */
      const r4 = JSON.parse(await inst.eval(
        `(async()=>JSON.stringify(await FRP.saveProxy('add','',{name:'same-port-ok',type:'tcp',localIP:'127.0.0.1',localPort:18080,remotePort:24102}, '${B.conn}')))()`,
      ));
      check('不同 frps 端口上同公网端口不算冲突', r4.ok === true, JSON.stringify(r4).slice(0, 300));

      /* 5) 和当前连接连同一台 frps（同 addr+port）→ 端口重复要报冲突 */
      const r5 = JSON.parse(await inst.eval(
        `(async()=>JSON.stringify(await FRP.saveProxy('add','',{name:'clash-port',type:'tcp',localIP:'127.0.0.1',localPort:18080,remotePort:24102}, '${C.conn}')))()`,
      ));
      check('同一台 frps 上端口重复被拦下', r5.ok === false && /占用/.test(r5.error || ''), JSON.stringify(r5).slice(0, 300));

      /* 6) 目标连接没有服务器地址 → 明确拒绝 */
      fs.writeFileSync(fileOf(C), 'serverAddr = ""\nserverPort = 7000\n', 'utf8');
      const r6 = JSON.parse(await inst.eval(
        `(async()=>JSON.stringify(await FRP.saveProxy('add','',{name:'no-addr',type:'tcp',localIP:'127.0.0.1',localPort:18080,remotePort:24109}, '${C.conn}')))()`,
      ));
      check('目标连接没有服务器地址时明确拒绝', r6.ok === false && /还没有服务器地址/.test(r6.error || ''), JSON.stringify(r6).slice(0, 300));
      check('被拒后没有写坏目标文件', !read(C).includes('no-addr'), read(C));
    } finally {
      if (inst) { try { await inst.stop(); } catch {} }
      for (const p of procs) { try { p.kill(); } catch {} }
    }
  },
};
