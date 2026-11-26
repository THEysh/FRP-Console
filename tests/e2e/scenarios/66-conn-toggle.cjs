'use strict';
/* 多连接的开关语义：
 * ① 停用的连接不能启动，错误要说明「已停用」而不是含糊的失败；
 * ② 切换「当前连接」只换视图不碰任何进程（B 机 pid 保持不变），只有显式停止才释放管理端口。 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function portOwners(port) {
  const out = [];
  try {
    const net = execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    for (const line of net.split(/\r?\n/)) {
      if (!line.includes(`:${port} `) || !/LISTENING/i.test(line)) continue;
      const pid = Number(line.trim().split(/\s+/).pop());
      if (!Number.isInteger(pid) || pid <= 0) continue;
      let info = {};
      try {
        const ps = execFileSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress`], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        info = JSON.parse(String(ps).trim() || '{}');
      } catch { info = { pid }; }
      out.push(info);
    }
  } catch { /* 忽略 */ }
  return out;
}

function portListening(port) {
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').some((line) => line.includes(`:${port} `) && /LISTENING/i.test(line));
  } catch {
    return false;
  }
}

module.exports = {
  id: 'conn-toggle',
  title: '停用的连接不能启动；切换当前连接不停隧道，显式停止才释放端口',
  needs: ['app'],
  async run(ctx) {
    const inst = await ctx.startApp({
      cdpOffset: 20,
      seed: (dir) => {
        const ud = path.join(dir, 'frp-console-data');
        fs.mkdirSync(ud, { recursive: true });
        const aToml = path.join(dir, 'a.toml');
        const bToml = path.join(dir, 'b.toml');
        const cfg = (name, adminPort) => [
          'serverAddr = "127.0.0.1"',
          'serverPort = 1',
          'loginFailExit = false',
          '',
          '[webServer]',
          'addr = "127.0.0.1"',
          `port = ${adminPort}`,
          'user = "admin"',
          'password = "toggle-test-123456"',
          '',
          '[[proxies]]',
          `name = "${name}"`,
          'type = "tcp"',
          'localIP = "127.0.0.1"',
          'localPort = 18080',
          'remotePort = 26301',
          '',
        ].join('\n');
        fs.writeFileSync(aToml, cfg('a-one', 7481), 'utf8');
        fs.writeFileSync(bToml, cfg('b-one', 7482), 'utf8');
        fs.writeFileSync(
          path.join(ud, 'settings.json'),
          JSON.stringify(
            {
              version: 2,
              runMode: 'managed',
              adminPort: 7481,
              adminUser: 'admin',
              adminPassword: 'toggle-test-123456',
              configPath: aToml,
              logPath: path.join(ud, 'frpc.log'),
              connections: [
                { id: 'c-tg1', name: 'A 机', configPath: aToml, logPath: path.join(dir, 'a.log'), adminPort: 7481, enabled: true },
                { id: 'c-tg2', name: 'B 机', configPath: bToml, logPath: path.join(dir, 'b.log'), adminPort: 7482, enabled: false },
              ],
              activeConnectionId: 'c-tg1',
            },
            null,
            2,
          ),
          'utf8',
        );
      },
    });

    const read = () => inst.eval(`(async () => {
      const r = await FRP.refresh(); const d = r.data || r;
      const list = (d.connections || []).map((c) => ({ name: c.name, enabled: c.enabled, mode: c.runtime && c.runtime.mode, pid: c.runtime && c.runtime.pid, active: c.active }));
      return { active: d.activeConnectionId, list };
    })()`);
    const pick = (r, re) => (r.list || []).find((c) => re.test(c.name)) || {};

    try {
      /* ① 停用的连接不能启动 */
      const blocked = await inst.eval(`(async () => { const r = await FRP.connectionStart('c-tg2'); return { ok: !!(r && r.ok), err: (r && r.error) || '' }; })()`);
      ctx.check('停用的连接启动被拒', blocked.ok === false, JSON.stringify(blocked));
      ctx.check('拒绝原因说清「已停用」', /不启用|停用/.test(blocked.err), blocked.err);

      /* 打开开关后能启动 */
      const enabled = await inst.eval(`(async () => { const r = await FRP.connectionUpdate({ id: 'c-tg2', enabled: true }); return { ok: !!(r && r.ok), err: (r && r.error) || '' }; })()`);
      ctx.check('可以重新启用这条连接', enabled.ok === true, JSON.stringify(enabled));
      const started = await inst.eval(`(async () => { const r = await FRP.connectionStart('c-tg2'); return { ok: !!(r && r.ok), err: (r && r.error) || '' }; })()`);
      ctx.check('启用后能启动', started.ok === true, JSON.stringify(started));

      const running = await ctx.waitFor(
        async () => {
          const r = await read();
          return pick(r, /B 机/).mode === 'managed' ? r : null;
        },
        (v) => !!v,
        { timeout: 40000, label: 'B 机进入 managed' },
      );
      const pidBefore = pick(running, /B 机/).pid;
      ctx.check('B 机确实跑起来了', pick(running, /B 机/).mode === 'managed' && !!pidBefore, JSON.stringify(pick(running, /B 机/)));

      /* ② 切到 B 机为当前连接（1.2.229 起切换只换视图，不碰任何进程）：
       *    B 机必须保持运行且 pid 不变，A 机仍保持停止。 */
      const switched = await inst.eval(`(async () => { const r = await FRP.connectionActive('c-tg2'); return { ok: !!(r && r.ok), hasStopped: !!(r && r.data && 'stopped' in r.data) }; })()`);
      ctx.check('切换当前连接成功', switched.ok === true, JSON.stringify(switched));
      ctx.check('切换结果里不再带 stopped 字段', switched.hasStopped === false, JSON.stringify(switched));

      const after = await ctx.waitFor(
        async () => {
          const r = await read();
          return r.active === 'c-tg2' ? r : null;
        },
        (v) => !!v,
        { timeout: 15000, label: '当前连接切到 B 机' },
      );
      ctx.check('当前连接切到 B 机', after.active === 'c-tg2', JSON.stringify(after.active));
      ctx.check('A 机保持停止（不会被顺手拉起）', pick(after, /A 机/).mode === 'stopped', JSON.stringify(pick(after, /A 机/)));
      ctx.check('B 机仍在跑且 pid 不变（切换不停隧道）', pick(after, /B 机/).mode === 'managed' && pick(after, /B 机/).pid === pidBefore, JSON.stringify({ before: pidBefore, after: pick(after, /B 机/) }));

      /* ③ 显式停止 B 机之后，管理端口必须真正释放 */
      const stoppedB = await inst.eval(`(async () => { const r = await FRP.connectionStop('c-tg2'); return { ok: !!(r && r.ok), err: (r && r.error) || '' }; })()`);
      ctx.check('显式停止 B 机成功', stoppedB.ok === true, JSON.stringify(stoppedB));

      let free = false;
      for (let i = 0; i < 20; i += 1) {
        await ctx.sleep(500);
        free = !portListening(7481) && !portListening(7482);
        if (free) break;
      }
      ctx.check('显式停止后两条连接的管理端口都已释放', free, JSON.stringify({ l7481: portOwners(7481), l7482: portOwners(7482) }));
    } finally {
      try { await inst.eval(`(async () => { const r = await FRP.connections(); const d = r.data || r; const arr = d.connections || d || []; for (const c of arr) { try { await FRP.connectionStop(c.id); } catch (e) {} } return 1; })()`); } catch { /* 忽略 */ }
      inst.stop();
    }
  },
};
