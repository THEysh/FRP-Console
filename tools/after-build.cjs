'use strict';

/*
 * 构建后处理：生成可直接双击的启动器。
 *
 * 背景：本机（以及相当一部分以管理员身份运行的受限桌面）里 Chromium 的沙箱
 * 初始化会失败，进程在进入 main 之前就以退出码 3 静默结束——表现为“双击 exe 没反应”。
 * 这种失败发生在 JS 之前，代码里 appendSwitch 也来不及，只能由命令行带 --no-sandbox。
 *
 * 所以每次构建后：
 *   1) 在 dist 里生成「启动 FRP 控制台.cmd」（便携版 exe 需要它）；
 *   2) 在 dist/win-unpacked 里也放一份（免打包目录调试用）。
 */

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const pkg = require(path.join(root, 'package.json'));

const LAUNCHER_NAME = '启动 FRP 控制台.cmd';

function launcherText(exeName) {
  // 内容保持纯 ASCII：cmd.exe 按 OEM 代码页解析 .cmd，中文注释会被读成乱码。
  return [
    '@echo off',
    'cd /d "%~dp0"',
    'rem Chromium sandbox cannot start in some restricted/admin sessions; must disable it',
    'set ELECTRON_RUN_AS_NODE=',
    `start "" "%~dp0${exeName}" --no-sandbox %*`,
    '',
  ].join('\r\n');
}

function writeLauncher(dir, exeName) {
  if (!fs.existsSync(dir)) return null;
  const file = path.join(dir, LAUNCHER_NAME);
  fs.writeFileSync(file, launcherText(exeName), 'utf8');
  return file;
}

function main() {
  if (!fs.existsSync(dist)) {
    console.error('[after-build] 未找到 dist 目录，请先执行 electron-builder');
    process.exitCode = 1;
    return;
  }
  const written = [];

  const portable = `FRP-Console-${pkg.version}.exe`;
  if (fs.existsSync(path.join(dist, portable))) {
    const file = writeLauncher(dist, portable);
    if (file) written.push(file);
  } else {
    // 版本号对不上时，退回到目录里唯一的便携版 FRP-Console-*.exe
    // 注意排除安装包（FRP-Console-Setup-*.exe）：给它加 --no-sandbox 毫无意义
    const fallback = fs.readdirSync(dist).find((name) => /^FRP-Console-(?!Setup).*\.exe$/i.test(name));
    if (fallback) {
      const file = writeLauncher(dist, fallback);
      if (file) written.push(file);
    }
  }

  const unpacked = path.join(dist, 'win-unpacked');
  // 可执行文件名优先取 build.executableName（保持 ASCII，避免 .cmd 在 OEM 代码页下
  // 把中文 exe 名读成乱码而报“找不到文件”）；没配才退回 productName。
  const baseName = pkg.build && (pkg.build.executableName || pkg.build.productName)
    ? pkg.build.executableName || pkg.build.productName
    : pkg.productName;
  const unpackedExe = `${baseName}.exe`;
  if (fs.existsSync(path.join(unpacked, unpackedExe))) {
    const file = writeLauncher(unpacked, unpackedExe);
    if (file) written.push(file);
  }

  if (!written.length) {
    console.warn('[after-build] 没找到可用的 exe，跳过启动器生成');
    return;
  }
  for (const file of written) console.log(`[after-build] 已生成 ${path.relative(root, file)}`);
  console.log('[after-build] 双击那个 .cmd 启动；直接双击 exe 在本机需要 --no-sandbox，会没有反应。');
}

main();
