'use strict';
/* 一条命令跑完本地全部静态与单元检查，不依赖 npm。
 *
 * 为什么需要它：Windows 上 `npm` 实际是 `npm.cmd`（批处理），Git Bash / MSYS 里
 * 直接 exec 会得到 exit 126（找到但不可执行），于是 `npm test` 在这些 shell 里只会
 * 静默失败。CI（Ubuntu）不受影响，这里只是给本地补一条不依赖 npm 的等价入口。
 *
 * 用法：node tools/test-all.cjs
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const steps = [
  ['语法检查', 'check-syntax.cjs'],
  ['单元测试', 'run-unit.cjs'],
  ['机密扫描', 'check-secrets.cjs'],
];

let failed = 0;
for (const [label, script] of steps) {
  const started = Date.now();
  const res = spawnSync(process.execPath, [path.join(__dirname, script)], { stdio: 'inherit' });
  const ms = Date.now() - started;
  if (res.status !== 0) {
    failed += 1;
    console.error(`✗ ${label} 失败（exit ${res.status === null ? 'null' : res.status}，${ms}ms）`);
  } else {
    console.log(`✓ ${label} 通过（${ms}ms）`);
  }
}

if (failed) {
  console.error(`\n合计 ${steps.length} 步：${steps.length - failed} 通过 / ${failed} 失败`);
  process.exit(1);
}
console.log(`\n合计 ${steps.length} 步全部通过`);
