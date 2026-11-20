'use strict';
/* 超长日志行必须被截断：一行 200 KB 会把 IPC 与日志页一起拖慢，
 * 而它对人没有任何价值（frpc 打整份 JSON/证书时才出现）。 */
const test = require('node:test');
const assert = require('node:assert');
const { clampLine, MAX_LINE_CHARS, parseLine } = require('../../src/main/log.js');

test('短行原样保留', () => {
  const s = '2026-11-21 01:00:00 [I] [web] start proxy success';
  assert.strictEqual(clampLine(s), s);
});

test('等于上限时不截断', () => {
  const s = 'Y'.repeat(MAX_LINE_CHARS);
  assert.strictEqual(clampLine(s).length, MAX_LINE_CHARS);
});

test('超过上限时截断并说明原长与省略了多少', () => {
  const s = 'X'.repeat(MAX_LINE_CHARS + 5000);
  const out = clampLine(s);
  assert.ok(out.length > MAX_LINE_CHARS);
  assert.ok(out.length < MAX_LINE_CHARS + 120, `说明文字不该太长：${out.length}`);
  assert.match(out, /这一行共 7000 字符/);
  assert.match(out, /已截断后面 5000 个/);
});

test('parseLine 走截断，且时间戳/级别仍解析正确', () => {
  const line = parseLine(`2026-11-21 01:00:00 [E] [web] ${'Z'.repeat(9000)}`, 1);
  assert.ok(line);
  assert.strictEqual(line.level, 'error');
  assert.ok(line.text.length < MAX_LINE_CHARS + 120);
  assert.ok(line.time);
});

test('空白行仍然被丢掉', () => {
  assert.strictEqual(parseLine('   ', 2), null);
});
