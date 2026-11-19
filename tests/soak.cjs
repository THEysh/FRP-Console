'use strict';
/* 长稳/泄漏抽查（L5-lite）：隧道跑着 + 20 条代理，每 30 秒采样一次，
 * 看主进程内存是否单调上涨、健康检查是否还在推进、日志缓冲是否无界增长。
 * 用法：node .e2e/lab/soak.cjs [分钟数，默认 6]
 * 判读只看趋势：小幅漂移正常，单调爬升不回收 / 健康检查停摆才算问题。 */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const helpers = path.join(ROOT, 'tests', 'e2e', 'helpers');
const appHelper = require(path.join(helpers, 'app.cjs'));
const cdpHelper = require(path.join(helpers, 'cdp.cjs'));
const frpsHelper = require(path.join(helpers, 'frps.cjs'));
const seed = require(path.join(helpers, 'seed.cjs'));

const MINUTES = Number(process.argv[2] || 6);
const SAMPLE_MS = 30000;
const PROXIES = 20;

function rssOfPid(pid) {
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
    const m = out.match(/"([^"]*)","(\d+)","[^"]*","([^"]*)","([\d,]+) K"/);
    if (!m) return null;
    return Math.round(Number(m[4].replace(/,/g, '')) / 1024);
  } catch {
    return null;
  }
}

(async () => {
  if (!frpsHelper.findFrps()) {
    console.log('没有 frps 二进制，跳过长稳抽查');
    return;
  }
  const dataRoot = path.join(ROOT, '.e2e-tmp', 'soak-' + Date.now());
  fs.mkdirSync(dataRoot, { recursive: true });
  let app = null;
  let frps = null;
  let local = null;
  try {
    frps = await frpsHelper.startFrps({ dir: path.join(dataRoot, 'frps'), bindPort: 17600, dashPort: 17601, token: 'soak-token' });
    if (!frps) throw new Error('frps 未起来');
    local = await frpsHelper.startLocalServers();

    app = await appHelper.start({ cdpPort: 9359, instancePort: 47929, dataRoot });
    await cdpHelper.waitReady(app.cdpPort);
    const evalIn = (body) => cdpHelper.evalIn(app.cdpPort, body);

    const seeded = await seed.ensureConfig({ eval: evalIn, frps: { bindPort: 17600, token: 'soak-token' } });
    if (!seeded.ok) throw new Error('隧道目标写入失败：' + seeded.err);

    const up = await evalIn(`(async () => {
      const res = await FRP.startTunnel();
      return { ok: !!(res && res.ok), err: (res && res.error) || '' };
    })()`);
    if (!up.ok) throw new Error('startTunnel 失败：' + up.err);

    /* 必须确认隧道真的连上了再开始采样：只凭 startTunnel 返回 ok 是不够的
     * —— frpc 可能起来就退出（管理端口被占、密码错、端口冲突），
     * 这时长稳会连续 8 分钟测一把“停止状态的空壳”，
     * 最后却把结论写成「健康检查停摆」，误导排查方向。 */
    const connected = await (async () => {
      for (let i = 0; i < 25; i += 1) {
        const rt = await evalIn('(async () => { const r = await FRP.refresh(); return r.data.runtime; })()');
        if (rt && rt.connected) return rt;
        await new Promise((r) => setTimeout(r, 1000));
      }
      const rt = await evalIn('(async () => { const r = await FRP.refresh(); return r.data.runtime; })()');
      return rt;
    })();
    if (!connected || !connected.connected) {
      throw new Error(
        '隧道没能连上，长稳采样没有意义：' +
          JSON.stringify({ mode: connected && connected.mode, apiError: connected && connected.apiError, connectError: connected && connected.connectError, lastExit: connected && connected.lastExit }).slice(0, 300),
      );
    }

    const added = await evalIn(`(async () => {
      for (let i = 1; i <= ${PROXIES}; i++) {
        const res = await FRP.saveProxy('add', '', { name: 'soak-' + i, type: 'tcp', localIP: '127.0.0.1', localPort: ${local.port}, remotePort: ${26100} + i });
        if (!res || !res.ok) return { ok: false, err: (res && res.error) || ('第 ' + i + ' 条失败') };
      }
      return { ok: true };
    })()`);
    if (!added.ok) throw new Error('加代理失败：' + added.err);

    const samples = [];
    const deadline = Date.now() + MINUTES * 60000;
    let i = 0;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, SAMPLE_MS));
      i += 1;
      const snap = await evalIn(`(async () => {
        const st = await FRP.refresh();
        const s = st.data;
        const logs = await FRP.getLogs(600);
        const hs = (s.proxies || []).map((p) => (p.health && p.health.at) || 0);
        return {
          total: s.counts.total,
          online: s.counts.online,
          unchecked: s.counts.unchecked,
          at: hs.length ? Math.max(...hs) : 0,
          logLines: (logs.data && logs.data.lines && logs.data.lines.length) || 0,
          mode: s.runtime.mode,
        };
      })()`);
      const row = { t: i * (SAMPLE_MS / 1000), mainMB: rssOfPid(app.child.pid), ...snap };
      samples.push(row);
      console.log(`  +${String(row.t).padStart(3)}s  main=${String(row.mainMB).padStart(4)}MB  mode=${row.mode}  proxies=${row.total} online=${row.online} unchecked=${row.unchecked} logs=${row.logLines}`);
    }

    const withMb = samples.filter((s) => s.mainMB);
    const first = withMb[0];
    const lastS = withMb[withMb.length - 1];
    const grow = first && lastS ? lastS.mainMB - first.mainMB : 0;
    const stalled = samples.length >= 2 && samples[samples.length - 1].at === samples[0].at;
    const logsGrew = samples[samples.length - 1].logLines - samples[0].logLines;

    console.log('\n=== 结论 ===');
    console.log(`采样 ${samples.length} 次 / ${MINUTES} 分钟`);
    console.log(`主进程内存：${first ? first.mainMB : '?'}MB → ${lastS ? lastS.mainMB : '?'}MB（净增 ${grow}MB）`);
    console.log(`健康检查推进：${stalled ? '✗ 停摆' : '✓ 正常'}（healthAt ${samples[0].at} → ${samples[samples.length - 1].at}）`);
    console.log(`日志缓冲：${samples[0].logLines} → ${samples[samples.length - 1].logLines} 行（涨 ${logsGrew}）`);
    console.log(`在线代理：${lastS.online} / ${lastS.total}`);
    const neverManaged = samples.every((s) => s.mode !== 'managed');
    const ok = grow <= 40 && !stalled && !neverManaged;
    if (neverManaged) console.log('✗ 全程没有进入 managed 模式：采样期间隧道根本没在跑');
    console.log(ok ? '✓ 通过' : '✗ 需要关注');
    fs.writeFileSync(path.join(dataRoot, 'samples.json'), JSON.stringify(samples, null, 2));
    process.exitCode = ok ? 0 : 2;
  } catch (e) {
    console.error('长稳抽查失败：', e && e.message);
    process.exitCode = 1;
  } finally {
    if (app) app.stop();
    if (local) local.stop();
    if (frps) frps.stop();
  }
})();
