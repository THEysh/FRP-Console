'use strict';
/* 双连接长稳：两条真实隧道同时在线，按分钟采样「状态 / 进程 / 在线数 / 内存 / 日志增长」，
 * 用来抓「跑几十分钟后某一条悄悄停了」「健康检查停摆」「内存一路涨」这类问题。
 *
 * 用法：node tests/soak-multi.cjs [分钟数=30]
 * 需要一份「已配好两条连接」的数据目录：默认 .e2e/lab/app-mc，可用 FRP_REAL_MC_DATA 覆盖。
 * 退出码：0=结论通过；1=发现异常（会在结论里写原因）。
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const cdp = require('./e2e/helpers/cdp.cjs');
const appHelper = require('./e2e/helpers/app.cjs');

const ROOT = path.join(__dirname, '..');
const APP = process.env.FRP_REAL_MC_DATA || path.join(ROOT, '.e2e', 'lab', 'app-mc');
const PORT = Number(process.env.FRP_SOAK_CDP || 9370);
const INSTANCE = Number(process.env.FRP_SOAK_INSTANCE || 47940);
const MINUTES = Number(process.argv[2] || 30);
const SAMPLE_MS = 60 * 1000;
const LOCAL_PORT = Number(process.env.FRP_SOAK_LOCAL || 18089);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pidOnPort(port) {
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    for (const line of out.split('\n')) {
      if (!line.includes(`:${port} `)) continue;
      if (!/LISTENING/i.test(line)) continue;
      const parts = line.trim().split(/\s+/);
      const pid = Number(parts[parts.length - 1]);
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
    return 0;
  } catch {
    return 0;
  }
}

function rssMb(pid) {
  if (!pid) return null;
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).WorkingSet64`],
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const bytes = Number(String(out).trim());
    return Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes / 1048576) : null;
  } catch {
    return null;
  }
}

function startLocal() {
  const net = require('node:net');
  const srv = net.createServer((s) => {
    s.on('error', () => {});
    s.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
  });
  return new Promise((resolve) => {
    srv.on('error', () => resolve(null));
    srv.listen(LOCAL_PORT, '127.0.0.1', () => resolve(srv));
  });
}

(async () => {
  if (!fs.existsSync(APP)) {
    console.error(`缺少多连接数据目录：${APP}（用 FRP_REAL_MC_DATA 指定）`);
    process.exit(2);
  }
  const srv = await startLocal();
  const inst = await appHelper.start({ cdpPort: PORT, instancePort: INSTANCE, dataDir: APP, dataRoot: path.join(ROOT, '.e2e-tmp') });
  const rows = [];
  const problems = [];
  try {
    await cdp.waitReady(PORT, 60000);
    await sleep(6000);

    const started = await cdp.evalIn(PORT, `(async () => {
      const r = await FRP.connections(); const d = r.data || r; const arr = d.connections || d || [];
      const res = [];
      for (const c of arr) { const s = await FRP.connectionStart(c.id); res.push({ name: c.name, ok: !!(s && s.ok), err: (s && s.error) || '' }); }
      return res;
    })()`);
    console.log('[soak-multi] 启动连接：', JSON.stringify(started));

    /* 先确认两条都真的连上，再开始采样（否则测的是一把空壳）。 */
    const warm = Date.now() + 90000;
    let ok = false;
    while (Date.now() < warm) {
      const s = await cdp.evalIn(PORT, `(async () => { const r = await FRP.refresh(); const d = r.data || r; const a = d.connectionsAgg || {}; return { running: a.running, online: a.online, unhealthy: a.unhealthy }; })()`);
      if (Number(s.running) >= 2 && Number(s.online) >= 2) { ok = true; break; }
      await sleep(3000);
    }
    if (!ok) problems.push('预热阶段两条连接没能同时在线');

    const rounds = Math.max(1, Math.round((MINUTES * 60 * 1000) / SAMPLE_MS));
    let lastLogLines = null;
    for (let i = 1; i <= rounds; i += 1) {
      await sleep(SAMPLE_MS);
      const s = await cdp.evalIn(PORT, `(async () => {
        const r = await FRP.refresh(); const d = r.data || r;
        const a = d.connectionsAgg || {};
        const list = (d.connections || []).map((c) => ({ name: c.name, mode: c.runtime && c.runtime.mode, pid: c.runtime && c.runtime.pid, online: (c.counts && c.counts.online) || 0 }));
        const logs = await FRP.getLogs(600);
        const lines = (logs && logs.data && logs.data.lines) || [];
        return { agg: { running: a.running, online: a.online, unhealthy: a.unhealthy, unchecked: a.unchecked }, list, logLines: lines.length };
      })()`);
      const mainPid = pidOnPort(PORT);
      const row = { t: `+${i}m`, ...s, rss: rssMb(mainPid) };
      rows.push(row);
      if (Number(s.agg.running) < 2) problems.push(`${row.t} 有一条连接不在跑（running=${s.agg.running}）`);
      if (Number(s.agg.online) < 2) problems.push(`${row.t} 在线数掉到 ${s.agg.online}`);
      if (lastLogLines !== null && Number(s.logLines) > lastLogLines + 300) problems.push(`${row.t} 日志缓冲涨了 ${s.logLines - lastLogLines} 行（可能被轮询刷屏）`);
      lastLogLines = Number(s.logLines);
      console.log(`[soak-multi] ${row.t} agg=${JSON.stringify(row.agg)} rss=${row.rss}MB logs=${row.logLines} conns=${row.list.map((c) => `${c.name}:${c.mode}/${c.pid}`).join(',')}`);
    }
  } catch (e) {
    problems.push(`脚本异常：${(e && e.message) || e}`);
  } finally {
    try { inst.stop(); } catch { /* 忽略 */ }
    try { if (srv) srv.close(); } catch { /* 忽略 */ }
    const rssValues = rows.map((r) => r.rss).filter((v) => typeof v === 'number');
    const rssGrow = rssValues.length >= 2 ? rssValues[rssValues.length - 1] - rssValues[0] : null;
    const verdict = {
      minutes: MINUTES,
      samples: rows.length,
      rssFirst: rssValues[0] ?? null,
      rssLast: rssValues[rssValues.length - 1] ?? null,
      rssGrowMb: rssGrow,
      problems,
      pass: problems.length === 0,
    };
    const logPath = path.join(ROOT, '.e2e', 'lab', `soak-multi-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, JSON.stringify({ verdict, rows }, null, 2), 'utf8');
      console.log(`[soak-multi] 明细：${logPath}`);
    } catch { /* 忽略 */ }
    console.log('[soak-multi] 结论：', JSON.stringify(verdict));
    process.exitCode = verdict.pass ? 0 : 1;
  }
})();
