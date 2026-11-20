'use strict';
/* explainServiceError：systemctl 的英文原话 → 能动手的提示 */
const test = require('node:test');
const assert = require('node:assert');
const { explainServiceError } = require('../../src/main/ssh.js');

test('Unit not found → 指路「从零初始化」或重建服务', () => {
  const s = explainServiceError('Failed to start frps.service: Unit frps.service not found.', 'frps');
  assert.match(s, /not found/);
  assert.match(s, /从零初始化/);
});

test('masked → 提示 unmask', () => {
  assert.match(explainServiceError('Failed to start frps.service: Unit frps.service is masked.', 'frps'), /unmask frps/);
});

test('start-limit → reset-failed + journalctl', () => {
  const s = explainServiceError('Job for frps.service failed because start request repeated too quickly.', 'frps');
  assert.match(s, /reset-failed/);
  assert.match(s, /journalctl/);
});

test('控制进程退出 → 去看日志', () => {
  const s = explainServiceError('Job for frps.service failed because the control process exited with error code.', 'frps');
  assert.match(s, /journalctl|frps\.log/);
});

test('认不出来的保持原样（不瞎猜）', () => {
  assert.strictEqual(explainServiceError('something else', 'frps'), 'something else');
  assert.strictEqual(explainServiceError('', 'frps'), '');
});
