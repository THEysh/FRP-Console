'use strict';

/*
 * 部署脚本：把 dist/win-unpacked 安装到用户级目录，并生成带 --no-sandbox 的快捷方式。
 *
 * 为什么不用 NSIS 安装包：
 *   本机（管理员受限桌面）里 Chromium 沙箱初始化失败，进程在 main 之前就以退出码 3 结束，
 *   所以启动命令必须带 --no-sandbox。NSIS 安装器在本机静默运行时无法落盘（只能写进
 *   %TEMP%\Low），改用“直接部署 + 快捷方式”的方式更可控。
 *
 * 用法：
 *   npx electron tools/deploy.cjs            # 部署 + 建快捷方式
 *   npx electron tools/deploy.cjs --dry-run  # 只看路径，不动文件
 *
 * 注意：必须由 electron 运行（用到 shell.writeShortcutLink），不能当普通 node 脚本跑。
 */

const { app, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const pkg = require(path.join(__dirname, '..', 'package.json'));

const EXE_NAME = `${(pkg.build && pkg.build.executableName) || pkg.productName}.exe`;
const SHORTCUT_NAME = 'FRP 控制台';
const SHORTCUT_ARGS = '--no-sandbox';

const root = path.resolve(__dirname, '..');
const src = path.join(root, 'dist', 'win-unpacked');
const localAppData = process.env.LOCALAPPDATA || app.getPath('appData');
const dst = path.join(localAppData, 'Programs', 'frp-console');
const exePath = path.join(dst, EXE_NAME);

const dryRun = process.argv.includes('--dry-run');
// 只重建快捷方式，不复制文件（应用已部署好时用）
const shortcutsOnly = process.argv.includes('--shortcuts-only');

// Electron 在 Windows 上是 GUI 子系统，从命令行调用时 stdout 可能不落到控制台，
// 因此同时写一份日志文件，便于排查。
const logFile = path.join(process.env.TEMP || process.env.LOCALAPPDATA || '.', 'frp-deploy.log');

function log(text) {
  const line = `[deploy] ${text}`;
  process.stdout.write(`${line}\n`);
  try {
    fs.appendFileSync(logFile, `${line}\n`, 'utf8');
  } catch { /* 写不了日志就算了 */ }
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

function makeShortcut(lnkPath) {
  fs.mkdirSync(path.dirname(lnkPath), { recursive: true });
  const ok = shell.writeShortcutLink(lnkPath, 'create', {
    target: exePath,
    args: SHORTCUT_ARGS,
    cwd: dst,
    icon: exePath,
    iconIndex: 0,
    description: 'FRP 内网穿透控制台：代理管理、端口扫描、frps 远程管理',
  });
  const back = ok ? shell.readShortcutLink(lnkPath) : null;
  log(`${ok ? '已写入' : '写入失败'} ${lnkPath}`);
  if (back) log(`   target=${back.target}  args=${back.args}`);
  return ok;
}

function main() {
  log(`源目录 ${src}`);
  log(`目标目录 ${dst}`);
  if (!fs.existsSync(path.join(src, EXE_NAME))) {
    log(`找不到 ${EXE_NAME}，请先执行 npm run dist:dir`);
    app.exit(1);
    return;
  }
  if (dryRun) {
    log('dry-run：跳过复制与快捷方式');
    app.exit(0);
    return;
  }

  if (!shortcutsOnly) {
    copyDir(src, dst);
    const size = (() => {
      let total = 0;
      const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) walk(p);
          else total += fs.statSync(p).size;
        }
      };
      walk(dst);
      return (total / 1024 / 1024).toFixed(1);
    })();
    log(`已复制 ${size} MB`);
  } else {
    log('--shortcuts-only：跳过文件复制');
  }

  const desktop = path.join(app.getPath('desktop'), `${SHORTCUT_NAME}.lnk`);
  const startMenu = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${SHORTCUT_NAME}.lnk`);
  const a = makeShortcut(desktop);
  const b = makeShortcut(startMenu);
  log(a && b ? '完成：桌面与开始菜单快捷方式均带 --no-sandbox' : '有快捷方式创建失败，请查看上面的输出');
  app.exit(a && b ? 0 : 1);
}

app.whenReady().then(main);
