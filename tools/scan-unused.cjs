'use strict';

/* 粗略扫描：未被渲染层引用的图标 / CSS 类。
 * 只作为提示，删之前仍需人工确认（动态拼接的 class 会漏判）。 */

const fs = require('node:fs');

const app = fs.readFileSync('src/renderer/app.js', 'utf8');
const html = fs.readFileSync('src/renderer/index.html', 'utf8');
const css = fs.readFileSync('src/renderer/styles.css', 'utf8');

const iconBlock = app.slice(app.indexOf('const ICON_PATHS'), app.indexOf('function icon('));
const iconKeys = [...iconBlock.matchAll(/^\s{2}([a-z0-9]+):\s*'/gm)].map((m) => m[1]);
const unusedIcons = iconKeys.filter((key) => {
  // 图标名有两种用法：icon('name') 直接调用，或作为数据字段（如 NAV_ITEMS 的 icon: 'name'）
  const usedInJs = new RegExp(`['"]${key}['"]`).test(app);
  const usedInHtml = new RegExp(`['"]${key}['"]`).test(html);
  return !usedInJs && !usedInHtml;
});
console.log(`图标共 ${iconKeys.length}，未引用：${unusedIcons.join(', ') || '无'}`);

const classNames = [...new Set([...css.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]{2,})/g)].map((m) => m[1]))];
const unusedClasses = classNames.filter((name) => {
  const re = new RegExp(`\\b${name}\\b`);
  return !re.test(app) && !re.test(html);
});
console.log(`CSS 类共 ${classNames.length}，未引用：${unusedClasses.length}`);
if (unusedClasses.length) console.log('  ' + unusedClasses.join(', '));
