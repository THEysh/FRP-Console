'use strict';
/* 超长日志行必须被截断：一行 200 KB 会把 IPC 与日志页一起拖慢，
 * 而它对人没有任何价值（frpc 打整份 JSON/证书时才出现）。 */
const test = require('node:test');
const assert = require('node:assert');
const { clampLine, MAX_LINE_CHARS, parseLine, stripLeadingMeta } = require('../../src/main/log.js');

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

test(
  '行首的时间戳与 [I] 标记被剥掉，正文只剩有效信息',
  () => {
    const line = parseLine('2026-11-26 00:17:24.612 [I] [client/service.go:295] try to connect to server...', 9);
    assert.ok(line);
    assert.strictEqual(line.body, '[client/service.go:295] try to connect to server...');
    assert.match(line.text, /^2026-11-26/, 'text 仍是原文，导出/复制用');
  },
);

test(
  '没有前缀的行 body 与原文一致；只有时间戳的行不变成空',
  () => {
    assert.strictEqual(stripLeadingMeta('[web] start proxy success'), '[web] start proxy success');
    assert.strictEqual(stripLeadingMeta('2026-11-26 00:17:24.612'), '2026-11-26 00:17:24.612');
  },
);
