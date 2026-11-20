'use strict';
/* shouldRedeploy：自动续期之后要不要把新证书重新传上服务器。 */
const test = require('node:test');
const assert = require('node:assert');
const { shouldRedeploy } = require('../../src/main/acme.js');

test('当初没部署过 → 不自动上传', () => {
  assert.deepStrictEqual(shouldRedeploy(null, '8.148.198.61'), { deploy: false, reason: '' });
  assert.deepStrictEqual(shouldRedeploy({ ok: false, error: 'x' }, '8.148.198.61'), { deploy: false, reason: '' });
});

test('部署过，但现在没连服务器 → 不传，并说明原因', () => {
  const r = shouldRedeploy({ ok: true, serverHost: '8.148.198.61' }, '');
  assert.strictEqual(r.deploy, false);
  assert.match(r.reason, /没有连接服务器/);
});

test('部署过，连的就是当初那台 → 重新部署', () => {
  assert.deepStrictEqual(shouldRedeploy({ ok: true, serverHost: '8.148.198.61' }, '8.148.198.61'), {
    deploy: true,
    reason: '',
  });
});

test('部署过，但当前连的是另一台 → 不传，并点名两台机器', () => {
  const r = shouldRedeploy({ ok: true, serverHost: '8.148.198.61' }, '154.36.178.154');
  assert.strictEqual(r.deploy, false);
  assert.match(r.reason, /8\.148\.198\.61/);
  assert.match(r.reason, /154\.36\.178\.154/);
});

test('旧记录没有 serverHost（1.2.38 之前写的）→ 视为同一台，允许重传', () => {
  assert.strictEqual(shouldRedeploy({ ok: true }, '8.148.198.61').deploy, true);
});
