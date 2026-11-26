'use strict';
/* 双真机多连接剧本（1.2.172 基线，npm run test:real:multi）：需要一份「已配置两条连接」的数据目录，
 * 默认 .e2e/lab/app-mc，可用 FRP_REAL_MC_DATA 覆盖；缺目录时直接退出。
 *日本 154.36.178.154 + 广州 8.148.198.61
 * 同时在线，逐项验证「两条隧道互不干扰」以及「停一条不影响另一条」。
 * 只读产品状态 + 起一个本地服务；不改两台服务器上的任何文件。 */
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const cdp = require('./../e2e/helpers/cdp.cjs');
const appHelper = require('./../e2e/helpers/app.cjs');

const ROOT = path.join(__dirname, '..', '..');
const APP = process.env.FRP_REAL_MC_DATA || path.join(ROOT, '.e2e', 'lab', 'app-mc');
const PORT = 9356;
const LOCAL = 18089;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const steps = [];
const check = (name, ok, detail) => steps.push({ name, ok: !!ok, detail: String(detail === undefined ? '' : detail).slice(0, 200) });

function startLocal() {
  const srv = net.createServer((sock) => {
    sock.on('error', () => {});
    sock.end('HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 12\r\nConnection: close\r\n\r\nmc-local-ok\n');
  });
  return new Promise((resolve) => {
    srv.on('error', () => resolve(null));
    srv.listen(LOCAL, '127.0.0.1', () => resolve(srv));
  });
}

async function waitAgg(expectOnline, timeout = 90000) {
  const mark = Date.now();
  let last = null;
  while (Date.now() - mark < timeout) {
    last = await cdp.evalIn(PORT, `(async () => {
      const r = await FRP.refresh(); const d = r.data || r;
      const a = d.connectionsAgg || {};
      return { running: a.running, online: a.online, unhealthy: a.unhealthy, unchecked: a.unchecked, conns: (d.connections || []).length,
        list: (d.connections || []).map((c) => ({ name: c.name, mode: c.runtime && c.runtime.mode, pid: c.runtime && c.runtime.pid, online: c.counts && c.counts.online })) };
    })()`);
    if (expectOnline === null && last.running === 0) return last;
    if (expectOnline !== null && Number(last.online) >= expectOnline && last.unhealthy === 0) return last;
    await sleep(2500);
  }
  return last;
}

if (!fs.existsSync(APP)) {
  console.error(`缺少多连接数据目录：${APP}（用 FRP_REAL_MC_DATA 指定一份已配好两条连接的）`);
  process.exit(2);
}

(async () => {
  const out = { steps };
  let srv = null;
  try {
    srv = await startLocal();
    out.inst = await appHelper.start({ cdpPort: PORT, instancePort: 47926, dataDir: APP, dataRoot: path.join(ROOT, '.e2e-tmp') });
    await cdp.waitReady(PORT, 60000);

    const list = await cdp.evalIn(PORT, `(async () => { const r = await FRP.connections(); const d = r.data || r; return (d.connections || d || []).map((c) => ({ id: c.id, name: c.name, enabled: c.enabled })); })()`);
    out.list = list;
    check('列出两条连接', Array.isArray(list) && list.length === 2, JSON.stringify(list));

    /* 两条一起启动 */
    const started = await cdp.evalIn(PORT, `(async () => {
      const r = await FRP.connections(); const d = r.data || r; const arr = d.connections || d || [];
      const res = [];
      for (const c of arr) { const s = await FRP.connectionStart(c.id); res.push({ name: c.name, ok: !!(s && s.ok), err: (s && s.error) || '' }); }
      return res;
    })()`);
    out.started = started;
    check('两条连接都启动成功', started.every((s) => s.ok), JSON.stringify(started));

    const agg = await waitAgg(2);
    out.agg = agg;
    check('两条同时在线（agg.online=2）', Number(agg.online) === 2, JSON.stringify(agg));
    check('两条 unhealthy 为 0', Number(agg.unhealthy) === 0, agg.unhealthy);
    const pids = (agg.list || []).map((c) => c.pid).filter(Boolean);
    check('两条连接各有一个 frpc 进程', pids.length === 2 && new Set(pids).size === 2, JSON.stringify(pids));

    /* 来回切换当前连接：两条 frpc 的 pid 必须保持不变（C2 切换不停隧道） */
    const pidMapBefore = Object.fromEntries((agg.list || []).map((c) => [c.name, c.pid]));
    const firstId = (out.list[0] || {}).id;
    const secondId = (out.list[1] || {}).id;
    if (firstId && secondId) {
      await cdp.evalIn(PORT, `(async () => { await FRP.connectionActive(${JSON.stringify(secondId)}); return 1; })()`);
      await sleep(1000);
      await cdp.evalIn(PORT, `(async () => { await FRP.connectionActive(${JSON.stringify(firstId)}); return 1; })()`);
      await sleep(1000);
      const afterSwitch = await cdp.evalIn(PORT, `(async () => {
        const r = await FRP.refresh(); const d = r.data || r;
        return (d.connections || []).map((c) => ({ name: c.name, pid: c.runtime && c.runtime.pid }));
      })()`);
      const pidMapAfter = Object.fromEntries((afterSwitch || []).map((c) => [c.name, c.pid]));
      check('来回切换连接后两条 frpc 的 pid 均未改变', JSON.stringify(pidMapBefore) === JSON.stringify(pidMapAfter), `${JSON.stringify(pidMapBefore)} -> ${JSON.stringify(pidMapAfter)}`);
    }

    /* 公网各自可达 */
    const pub = await cdp.evalIn(PORT, `(async () => {
      const r = await FRP.refresh(); const d = r.data || r;
      const cur = (d.proxies || [])[0] || {};
      const reach = {};
      for (const url of ['http://154.36.178.154:26310/', 'http://8.148.198.61:26311/']) {
        const t = await FRP.probeTcp(url.includes('154.') ? '154.36.178.154' : '8.148.198.61', url.includes('154.') ? 26310 : 26311);
        reach[url] = t && t.ok ? (t.data ? t.data.ok : t.ok) : false;
      }
      return { cur: { name: cur.name, publicAddress: cur.publicAddress, health: cur.health && cur.health.ok }, reach };
    })()`);
    out.pub = pub;
    check('日本公网端口可连', pub.reach['http://154.36.178.154:26310/'] === true, JSON.stringify(pub.reach));
    check('广州公网端口可连', pub.reach['http://8.148.198.61:26311/'] === true, JSON.stringify(pub.reach));

    /* 停掉「广州」那条，日本那条必须不受影响 */
    const idx = (agg.list || []).findIndex((c) => /广州/.test(c.name));
    const gzId = idx >= 0 ? (out.list[idx] || {}).id : '';
    const stopped = await cdp.evalIn(PORT, `(async () => { const r = await FRP.connectionStop(${JSON.stringify(gzId)}); return { ok: !!(r && r.ok), err: (r && r.error) || '' }; })()`);
    out.stopped = stopped;
    check('停掉广州那条', stopped.ok === true, JSON.stringify(stopped));

    const afterStop = await waitAgg(1);
    out.afterStop = afterStop;
    check('停一条后另一条仍在线', Number(afterStop.online) === 1, JSON.stringify(afterStop));

    /* 重新启动广州那条 */
    const restarted = await cdp.evalIn(PORT, `(async () => { const r = await FRP.connectionStart(${JSON.stringify(gzId)}); return { ok: !!(r && r.ok), err: (r && r.error) || '' }; })()`);
    check('广州那条能重新启动', restarted.ok === true, JSON.stringify(restarted));
    const agg2 = await waitAgg(2);
    out.agg2 = agg2;
    check('恢复后两条又同时在线', Number(agg2.online) === 2, JSON.stringify(agg2));

    /* 收尾：两条都停掉，确认 agg 归零（不残留进程） */
    const stopAll = await cdp.evalIn(PORT, `(async () => {
      const r = await FRP.connections(); const d = r.data || r; const arr = d.connections || d || [];
      for (const c of arr) { try { await FRP.connectionStop(c.id); } catch (e) {} }
      return arr.length;
    })()`);
    const zero = await waitAgg(null, 40000);
    out.zero = zero;
    check('收尾后没有在跑的隧道', Number(zero.running) === 0, JSON.stringify(zero));
  } catch (e) {
    check('脚本异常', false, (e && e.message) || e);
  } finally {
    try { if (out.inst) out.inst.stop(); } catch { /* 忽略 */ }
    try { if (srv) srv.close(); } catch { /* 忽略 */ }
    await sleep(600);
    console.log(JSON.stringify({ steps, list: out.list, agg: out.agg, afterStop: out.afterStop, agg2: out.agg2 }, null, 2));
    const bad = steps.filter((s) => !s.ok);
    if (bad.length) process.exitCode = 1;
  }
})();
