'use strict';
/* E2E 用的「起一个干净实例」封装。
 *
 * 关键约束（都是踩过的坑）：
 *  - 必须用自己的 PORTABLE_EXECUTABLE_DIR：否则会读写用户真实配置
 *    （%LOCALAPPDATA%\frp-console），测试会改掉别人正在用的代理。
 *  - 必须换 FRP_INSTANCE_PORT：默认 47823 被安装版占着时会顶掉真实实例。
 *  - 必须删掉 ELECTRON_RUN_AS_NODE：会话里带着它时 electron 会当纯 node 跑，
 *    报 `Cannot read properties of undefined (reading 'setName')`。
 *  - 用 detached + stdio:'ignore' 起：让测试脚本退出前能自己 kill 干净，
 *    也能避免 electron 的日志把 runner 的输出淹掉。
 */
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function electronBinary() {
  const exe = process.platform === 'win32' ? 'electron.exe' : 'electron';
  const full = path.join(ROOT, 'node_modules', 'electron', 'dist', exe);
  if (!fs.existsSync(full)) throw new Error(`找不到 electron：${full}（先执行 npm ci）`);
  return full;
}

/* 内置 frpc 的候选位置：vendor（打包前下载）、.e2e 实验区、环境变量。 */
function frpcBinary() {
  const candidates = [
    process.env.FRP_E2E_FRPC,
    path.join(ROOT, 'vendor', 'frpc', 'frpc.exe'),
    path.join(ROOT, '.e2e', 'lab', 'app1', 'frpc.exe'),
    path.join(ROOT, 'resources', 'frpc', 'frpc.exe'),
  ].filter(Boolean);
  return candidates.find((p) => {
    try {
      return fs.statSync(p).size > 100000;
    } catch {
      return false;
    }
  }) || '';
}

/* 上一次跑留下的实例可能还占着同一个 CDP 端口（关窗口/退出慢，或上一轮被中途杀掉）。
 * 不清掉的话 waitReady 会连到「正在消失的页面」，求值报 Execution context was destroyed /
 * Target closed —— 表现成随机失败，还会让人误以为是产品 bug。 */
function killPort(port) {
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const pids = new Set();
    const needle = `:${port} `;
    for (const line of out.split('\n')) {
      if (!line.includes(needle)) continue;
      if (!/LISTENING/i.test(line)) continue;
      const parts = line.trim().split(/\s+/);
      const pid = Number(parts[parts.length - 1]);
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
    for (const pid of pids) {
      try {
        execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
      } catch {
        /* 已经没了 */
      }
    }
    return pids.size;
  } catch {
    return 0;
  }
}

async function start(options = {}) {
  const cdpPort = Number(options.cdpPort || 9450);
  const instancePort = Number(options.instancePort || 47950);
  /* 数据目录必须放在**工作区里面**：Electron 的 process_singleton 要在 userData 里
   * 建锁文件，系统临时目录（%TEMP%）在当前沙箱下会被拒（Error code: 5），
   * 表现是「应用启动即退出、CDP 连不上」。默认放 .e2e-tmp/（已加入 .gitignore），
   * 需要时用 E2E_DATA_ROOT 指到别处。 */
  const root = options.dataRoot || process.env.E2E_DATA_ROOT || path.join(ROOT, '.e2e-tmp');
  fs.mkdirSync(root, { recursive: true });
  const dir = options.dataDir || fs.mkdtempSync(path.join(root, 'run-'));
  fs.mkdirSync(dir, { recursive: true });

  const frpc = frpcBinary();
  if (frpc) fs.copyFileSync(frpc, path.join(dir, 'frpc.exe'));

  /* 预置一份「干净安装」的 settings + starter 配置。
   * 不预置的话，应用会去 appDir / cwd 里 findConfig()，把仓库里遗留的
   * .frp-console-data\frpc.toml（开发时留下的代理）当成自己的配置——
   * 于是「全新安装」的断言看到 1 条别人的隧道，测出来的结论全是假的。 */
  const userData = path.join(dir, 'frp-console-data');
  fs.mkdirSync(userData, { recursive: true });
  const configPath = path.join(userData, 'frpc.toml');
  const settingsPath = path.join(userData, 'settings.json');
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(
      configPath,
      ['serverAddr = ""', 'serverPort = 7000', '', '[log]', 'to = "./frpc.log"', 'level = "info"', ''].join('\n'),
      'utf8',
    );
  }
  if (!fs.existsSync(settingsPath)) {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          version: 2,
          frpcPath: frpc ? path.join(dir, 'frpc.exe') : '',
          configPath,
          logPath: path.join(userData, 'frpc.log'),
          runMode: 'auto',
          adminPort: 7412,
          pollIntervalMs: 3000,
        },
        null,
        2,
      ),
      'utf8',
    );
  }

  /* 起之前先把占着这个 CDP 端口的旧实例清掉（见 killPort 注释）。 */
  killPort(cdpPort);

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.PORTABLE_EXECUTABLE_DIR = dir;
  env.FRP_INSTANCE_PORT = String(instancePort);

  /* 主进程的 stdout/stderr 落到文件里：启动失败（CDP 连不上）时这是唯一的线索，
   * 以前用 stdio:'ignore' 只能看到「没起来」，完全不知道为什么。 */
  const logPath = path.join(dir, 'app.log');
  const logFd = fs.openSync(logPath, 'a');
  const child = spawn(electronBinary(), ['.', '--no-sandbox', `--remote-debugging-port=${cdpPort}`], {
    cwd: ROOT,
    env,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  });
  child.unref();
  try {
    fs.closeSync(logFd);
  } catch {
    /* 子进程已继承 */
  }

  return {
    child,
    dir,
    cdpPort,
    instancePort,
    hasFrpc: !!frpc,
    frpcPath: frpc,
    logPath,
    stop() {
      if (!child.pid) return;
      try {
        /* /T 连子进程一起杀：托管模式下 frpc.exe 是 electron 的子进程，
         * 留着它会占住 remotePort，下一次跑就会「proxy already exists」。 */
        execFileSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
      } catch {
        /* 已经退了 */
      }
    },
  };
}

module.exports = { start, electronBinary, frpcBinary, killPort, ROOT };
