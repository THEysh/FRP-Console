'use strict';
/* L0 静态检查：每个源文件过一遍 `node --check`。
 *
 * 为什么需要它：改代码时最容易留下的是语法错误（少一个括号、多一个逗号），
 * 而 Electron 主进程的语法错误表现为「双击没反应」，渲染进程的表现为
 * 「界面空白」——两者都不会告诉你哪一行坏了。本地手动跑一次 3 秒，
 * 放进 CI 后每次提交都能挡住。
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = ['src', 'tools', 'tests'];

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walk(full, out);
    } else if (/\.(c|m)?js$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const files = TARGETS.flatMap((t) => walk(path.join(ROOT, t)));
const failures = [];
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const detail = String((error.stderr || error.stdout || error.message || '')).trim().split('\n').slice(0, 6).join('\n');
    failures.push({ file: path.relative(ROOT, file), detail });
  }
}

if (failures.length) {
  console.error(`✗ 语法检查失败：${failures.length}/${files.length} 个文件`);
  for (const f of failures) console.error(`\n${f.file}\n${f.detail}\n`);
  process.exit(1);
}
console.log(`✓ 语法检查通过（${files.length} 个文件）`);
