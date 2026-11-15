// 源码开发启动器：npm start / npm run dev 一条命令拉起源码版控制台。
//
// 为什么不直接 "electron ."：
//   1) electron 是 GUI 程序，从 cmd 启动时崩溃不打字到终端，出问题只能猜；
//   2) 源码版默认和安装版共用 %LOCALAPPDATA%\frp-console，安装版在跑（含托盘）
//      时源码版会静默退掉；单实例端口 47823 也会互相握手顶掉；
//   3) 部分受限会话里 ELECTRON_RUN_AS_NODE=1 会让 electron 变成纯 Node 跑主脚本，
//      直接 TypeError 崩溃。
// 本脚本三个问题一起解决：数据目录放项目内 .frp-console-data（gitignored）、
// 单实例端口用 47824（安装版是 47823）、子进程环境里删掉 ELECTRON_RUN_AS_NODE，
// 并且 stdio 继承终端，任何报错都能看到。默认补 --no-sandbox（管理员桌面需要）。
'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const electronPath = require('electron'); // electron npm 包在 Node 里导出二进制路径

const projectRoot = path.resolve(__dirname, '..');
const devDataDir = path.join(projectRoot, '.frp-console-data');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;            // 防「纯 Node 模式」启动
env.PORTABLE_EXECUTABLE_DIR = devDataDir;   // userData → .frp-console-data/frp-console-data
if (!env.FRP_INSTANCE_PORT) env.FRP_INSTANCE_PORT = '47824'; // 与安装版 47823 分开
env.DSH_DEV_CDP = '9345';                   // 仅供测试脚本约定：dev 模式的调试端口

const args = process.argv.slice(2);
if (!args.includes('--no-sandbox')) args.unshift('--no-sandbox');
args.unshift('--remote-debugging-port=9345'); // 源码开发/端到端测试统一用 9345
args.unshift(projectRoot);

console.log('[dev] 源码模式启动：数据目录 .frp-console-data（已 gitignore），单实例端口 47824');

const child = spawn(electronPath, args, {
  stdio: 'inherit',
  env,
  cwd: projectRoot,
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code == null ? 0 : code);
});
