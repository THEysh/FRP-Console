'use strict';
/* 1.2.129：sanitizeSettings 顺手清掉已删功能的字段。 */
const test = require('node:test');
const assert = require('node:assert');
const { sanitizeSettings, OBSOLETE_KEYS } = require('../../src/main/settings.js');

test('删掉 STAGING 与「停止服务前确认」遗留字段', () => {
  const out = sanitizeSettings({ acmeStaging: true, confirmStopService: true, logBuffer: 600 });
  for (const key of OBSOLETE_KEYS) assert.strictEqual(key in out, false, `${key} 应该被清掉`);
  assert.strictEqual(out.logBuffer, 600, '正常字段不受影响');
});

test('不认识的字段保持原样（不瞎删）', () => {
  const out = sanitizeSettings({ someFutureKey: 'x' });
  assert.strictEqual(out.someFutureKey, 'x');
});
