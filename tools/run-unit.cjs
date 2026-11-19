'use strict';
/* 跨平台跑单测：自己收集 tests/unit/*.test.js 再交给 `node --test`。
 * 为什么不用 `node --test tests/unit/`：Windows 上这个目录参数会被当成模块路径
 * （Cannot find module …\tests\unit），而 `tests/unit/*.test.js` 在 cmd 里又不展开通配符。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const dir = path.resolve(__dirname, '..', 'tests', 'unit');
if (!fs.existsSync(dir)) {
  console.error(`✗ 找不到测试目录：${dir}`);
  process.exit(1);
}
const files = fs
  .readdirSync(dir)
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => path.join(dir, name));

if (!files.length) {
  console.error('✗ tests/unit 下没有 *.test.js');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
