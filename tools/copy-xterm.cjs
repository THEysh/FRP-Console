#!/usr/bin/env node
/*
 * 把 @xterm/* 的浏览器产物拷进 src/renderer/vendor/xterm/。
 *
 * 渲染层是裸 JS + <script> 标签（没有 webpack/vite），node_modules 不会被打包，
 * 所以用「拷贝 + 提交」的方式引入 xterm.js：
 *   - src/renderer/vendor/xterm/ 下的文件随 build.files 的 src 通配一起进安装包
 *   - 升级 @xterm/* 版本时重跑本脚本即可
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'src', 'renderer', 'vendor', 'xterm');

const files = [
  ['node_modules/@xterm/xterm/lib/xterm.js', 'xterm.js'],
  ['node_modules/@xterm/xterm/css/xterm.css', 'xterm.css'],
  ['node_modules/@xterm/addon-fit/lib/addon-fit.js', 'addon-fit.js'],
  ['node_modules/@xterm/addon-web-links/lib/addon-web-links.js', 'addon-web-links.js'],
];

fs.mkdirSync(outDir, { recursive: true });
for (const [src, name] of files) {
  const from = path.join(root, src);
  const to = path.join(outDir, name);
  if (!fs.existsSync(from)) {
    console.error(`missing: ${src}（先 npm install）`);
    process.exit(1);
  }
  fs.copyFileSync(from, to);
  console.log(`copied ${src} -> src/renderer/vendor/xterm/${name} (${fs.statSync(to).size} bytes)`);
}
