'use strict';
/* L3 端到端（GUI）测试跑批器。
 *
 * 用法：
 *   node tests/e2e/run.cjs                 # 全部场景
 *   node tests/e2e/run.cjs --only tunnel   # 只跑 id/标题匹配的场景
 *   node tests/e2e/run.cjs --keep          # 保留临时数据目录与进程（排障用）
 *
 * 场景按文件名顺序执行，共享同一个 app 实例（冷启动只测一次，后面复用），
 * 需要 frps / 假 SSH 的场景自己声明 needs，缺依赖就标记 skipped 而不是红。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const appHelper = require('./helpers/app.cjs');
const { startFrps, startLocalServers, waitPort } = require('./helpers/frps.cjs');
const cdp = require('./helpers/cdp.cjs');

const HERE = __dirname;
const args = process.argv.slice(2);
const only = (args.find((a) => a.startsWith('--only=')) || '').split('=')[1] || '';
const keep = args.includes('--keep');
const CDP_PORT = Number(process.env.E2E_CDP_PORT || 9450);
const INSTANCE_PORT = Number(process.env.E2E_INSTANCE_PORT || 47950);
const SSH_PORT = Number(process.env.E2E_SSH_PORT || 22422);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, predicate = Boolean, { timeout = 20000, interval = 400, label = '条件' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (predicate(last)) return last;
    } catch (error) {
      last = String((error && error.message) || error);
    }
    await sleep(interval);
  }
  throw new Error(`等待${label}超时（最后结果：${JSON.stringify(last)?.slice(0, 300)}）`);
}

function loadScenarios() {
  const dir = path.join(HERE, 'scenarios');
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.cjs'))
    .sort()
    .map((f) => require(path.join(dir, f)))
    .filter((s) => (only ? `${s.id} ${s.title}`.toLowerCase().includes(only.toLowerCase()) : true));
}

async function main() {
  const scenarios = loadScenarios();
  if (!scenarios.length) {
    console.error(`✗ 没有匹配的场景（--only=${only}）`);
    process.exit(2);
  }
  const needs = new Set(scenarios.flatMap((s) => s.needs || []));
  const dataRoot = process.env.E2E_DATA_ROOT || path.join(appHelper.ROOT, '.e2e-tmp');
  fs.mkdirSync(dataRoot, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(dataRoot, 'run-'));
  const results = [];
  let app = null;
  let frps = null;
  let local = null;
  let sshd = null;

  const cleanup = () => {
    if (sshd) {
      try {
        process.kill(sshd.pid, 'SIGKILL');
      } catch {
        /* ignore */
      }
    }
    if (frps) frps.stop();
    if (local) local.stop();
    if (app) app.stop();
    if (!keep) {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
      } catch {
        /* Windows 上偶发占用，忽略 */
      }
    }
  };
  process.on('exit', cleanup);

  console.log(`▶ E2E 起步：${scenarios.length} 个场景，数据目录 ${dataDir}`);

  /* 起主实例：偶发「启动即退」（上一轮残留占着端口、或启动被拖慢），重试 3 次，
   * 失败时把应用日志尾部打出来——不然只看到 ECONNREFUSED，完全不知道为什么。 */
  const bootApp = async () => {
    let lastLog = "";
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      app = await appHelper.start({ cdpPort: CDP_PORT, instancePort: INSTANCE_PORT, dataDir });
      if (await cdp.waitReady(CDP_PORT, 40)) return true;
      try {
        lastLog = fs.readFileSync(app.logPath, 'utf8').trim().split('\n').slice(-20).join('\n');
      } catch {
        lastLog = '';
      }
      console.log(`ℹ 主实例第 ${attempt} 次没能打开调试端口，清掉端口后重试`);
      try { appHelper.killPort(CDP_PORT); } catch { /* 已经没了 */ }
      await sleep(1500);
    }
    console.error('✗ 应用三次都没能打开调试端口（CDP）');
    if (lastLog) console.error(`--- 应用日志（${app.logPath}）---\n${lastLog}`);
    return false;
  };
  if (!(await bootApp())) process.exit(1);

  if (needs.has('frps')) {
    frps = await startFrps({ dir: path.join(dataDir, 'frps'), bindPort: 17000, dashPort: 17500 });
    if (!frps) console.log('ℹ 没找到 frps 二进制，需要隧道的场景会跳过（tools/fetch-frpc.cjs 只下 frpc）');
  }
  if (needs.has('local')) local = await startLocalServers();
  if (needs.has('sshd')) {
    sshd = spawn(process.execPath, [path.join(HERE, 'fixtures', 'fake-sshd.cjs'), String(SSH_PORT), 'mixed', 'e2e-server', 'e2e-token-1234567890', '1.26.3', 'fw', '7000,17000', '22/tcp,7000/tcp,17000/tcp', '17000'], {
      cwd: HERE,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    sshd.unref();
    if (!(await waitPort(SSH_PORT, '127.0.0.1', 15000))) {
      console.error('✗ 假 SSH 服务没起来');
      process.exit(1);
    }
  }

  const ctx = {
    dataDir,
    dataRoot,
    cdpPort: CDP_PORT,
    sshPort: SSH_PORT,
    frps,
    local,
    app,
    eval: (expr) => cdp.evalIn(CDP_PORT, expr),
    waitFor,
    sleep,
    reload: () => cdp.reloadPage(CDP_PORT),
    /* 把视口模拟成指定尺寸（测最小窗口布局）；传空则恢复 */
    emulate: (w, h) => cdp.emulateViewport(CDP_PORT, w, h),
    /* 等某个选择器出现：单独跑某一个场景时界面可能还没画完，
     * 直接 querySelector(...).click() 会拿到 null。 */
    waitUi: (selector, label = '界面元素') =>
      waitFor(
        () => cdp.evalIn(CDP_PORT, `!!document.querySelector(${JSON.stringify(selector)})`),
        (v) => v === true,
        { timeout: 15000, label },
      ),
    /* 起一个独立实例（自己的数据目录、CDP 端口、单实例端口）。
     * 迁移类场景必须在**应用启动前**把老数据摆好，所以给了 seed(dir) 回调；
     * 场景自己负责 finally 里 stop()，否则会占着 CDP 端口影响后面的场景。 */
    startApp: async ({ seed, cdpOffset = 1 } = {}) => {
      const dir = fs.mkdtempSync(path.join(dataRoot, 'own-'));
      if (seed) seed(dir);
      const cdpPort = CDP_PORT + cdpOffset;
      const instancePort = INSTANCE_PORT + cdpOffset;
      const inst = await appHelper.start({ cdpPort, instancePort, dataDir: dir });
      const ready = await cdp.waitReady(cdpPort, 40);
      /* 端口可连 ≠ 界面可用：等侧栏渲染出来（index.html 解析完、app.js 首帧跑完）。 */
      if (ready) {
        try {
          await waitFor(
            () => cdp.evalIn(cdpPort, '!!document.querySelector(".nav-item")'),
            (v) => v === true,
            { timeout: 30000, label: '界面就绪' },
          );
        } catch {
          /* 起不来时让场景自己去报更有意义的错（比如读 app.log） */
        }
      }
      return {
        dir,
        cdpPort,
        ready,
        eval: (expr) => cdp.evalIn(cdpPort, expr),
        stop: () => inst.stop(),
        log: () => {
          try {
            return fs.readFileSync(inst.logPath, 'utf8');
          } catch {
            return '';
          }
        },
      };
    },
  };

  /* 每个场景开跑前确认主实例还活着：它中途崩掉时，后面每条都会报 ECONNREFUSED，
   * 看起来像「产品坏了」，实际是测试环境没了。这里重启一次并明确说明。 */
  const ensureAppAlive = async (scenarioId) => {
    if (await cdp.waitReady(CDP_PORT, 2)) return true;
    console.log(`ℹ ${scenarioId} 开跑前发现主实例已退出，正在重启`);
    try { appHelper.killPort(CDP_PORT); } catch { /* ignore */ }
    app = await appHelper.start({ cdpPort: CDP_PORT, instancePort: INSTANCE_PORT, dataDir });
    return cdp.waitReady(CDP_PORT, 40);
  };

  for (const scenario of scenarios) {
    const started = Date.now();
    const failures = [];
    const check = (name, ok, detail = '') => {
      if (!ok) failures.push(`${name}${detail ? ` —— ${detail}` : ''}`);
      return !!ok;
    };
    const skipReason = [];
    if ((scenario.needs || []).includes('frps') && !frps) skipReason.push('没有 frps 二进制');
    if ((scenario.needs || []).includes('local') && !local) skipReason.push('本地服务未启动');
    if ((scenario.needs || []).includes('frpc') && !app.hasFrpc) skipReason.push('没有 frpc.exe');
    if (skipReason.length) {
      results.push({ id: scenario.id, status: 'skipped', reason: skipReason.join('、'), ms: 0 });
      console.log(`⊘ ${scenario.id} ${scenario.title} —— 跳过（${skipReason.join('、')}）`);
      continue;
    }
    try {
      if (!(await ensureAppAlive(scenario.id))) throw new Error("主实例重启后仍连不上调试端口（环境问题，不是产品缺陷）");
      let runtimeSkip = null;
      await scenario.run({ ...ctx, check, sleep, skip: (reason) => { runtimeSkip = String(reason || '环境不满足'); } });
      const ms = Date.now() - started;
      if (runtimeSkip) {
        results.push({ id: scenario.id, status: 'skipped', reason: runtimeSkip, ms });
        console.log(`⊘ ${scenario.id} ${scenario.title}（${ms}ms）—— 跳过（${runtimeSkip}）`);
        continue;
      }
      if (failures.length) {
        results.push({ id: scenario.id, status: 'fail', failures, ms });
        console.log(`✗ ${scenario.id} ${scenario.title}（${ms}ms）`);
        for (const f of failures) console.log(`    · ${f}`);
      } else {
        results.push({ id: scenario.id, status: 'pass', ms });
        console.log(`✓ ${scenario.id} ${scenario.title}（${ms}ms）`);
      }
    } catch (error) {
      const ms = Date.now() - started;
      const message = String((error && error.message) || error);
      results.push({ id: scenario.id, status: 'error', error: message, ms });
      console.log(`✗ ${scenario.id} ${scenario.title}（${ms}ms）`);
      console.log(`    · 抛异常：${message.slice(0, 500)}`);
    }
  }

  const pass = results.filter((r) => r.status === 'pass').length;
  const fail = results.filter((r) => r.status === 'fail' || r.status === 'error').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  console.log(`\n合计 ${results.length}：通过 ${pass} / 失败 ${fail} / 跳过 ${skipped}`);
  for (const r of results.filter((x) => x.status === 'fail' || x.status === 'error')) {
    console.log(`  ✗ ${r.id}${r.failures ? `：${r.failures.join('；')}` : `：${r.error}`}`);
  }
  cleanup();
  process.exit(fail ? 1 : 0);
}

main().catch((error) => {
  console.error('✗ 跑批器异常：', error);
  process.exit(1);
});
