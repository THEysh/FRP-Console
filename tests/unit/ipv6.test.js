'use strict';
/* IPv6 支持：frp 本身认 IPv6，我们的校验不能把它拦下来；
 * 但同时不能放松到让 999.1.1.1 这类地址通过。 */
const { test } = require('node:test');
const assert = require('node:assert');
const config = require('../../src/main/config.js');

const base = (patch) => ({
  serverAddr: '127.0.0.1',
  serverPort: 7000,
  auth: { method: 'token', token: 'tok-1234567890' },
  visitors: [],
  proxies: [{ name: 'v6', type: 'tcp', localIP: '::1', localPort: 8080, remotePort: 29001 }],
  _extra: {},
  ...patch,
});

const messages = (list) => list.map((item) => item.message).join(' | ');

test('localIP 允许 IPv6 回环地址', () => {
  const v = config.validate(base({}));
  assert.equal(v.errors.length, 0, messages(v.errors));
});

test('localIP 允许完整 IPv6 地址', () => {
  const v = config.validate(base({ proxies: [{ name: 'v6', type: 'tcp', localIP: '2001:db8::1', localPort: 8080, remotePort: 29002 }] }));
  assert.equal(v.errors.length, 0, messages(v.errors));
});

test('localIP 允许带方括号的 IPv6', () => {
  const v = config.validate(base({ proxies: [{ name: 'v6', type: 'tcp', localIP: '[::1]', localPort: 8080, remotePort: 29003 }] }));
  assert.equal(v.errors.length, 0, messages(v.errors));
});

test('999.1.1.1 依然被拒（不能因为 IPv6 支持就放松）', () => {
  const v = config.validate(base({ proxies: [{ name: 'v6', type: 'tcp', localIP: '999.1.1.1', localPort: 8080, remotePort: 29004 }] }));
  assert.ok(v.errors.some((e) => /不是合法的主机名或 IP/.test(e.message)), messages(v.errors));
});

test('serverAddr 填 IPv6 不再警告', () => {
  const v = config.validate(base({ serverAddr: '2001:db8::1', proxies: [] }));
  assert.equal(v.warnings.filter((w) => /不是常见的主机名或 IP/.test(w.message)).length, 0, messages(v.warnings));
});

test('serverAddr 填 ::1 也能通过（本地 IPv6 frps）', () => {
  const v = config.validate(base({ serverAddr: '::1', proxies: [] }));
  assert.equal(v.errors.length, 0, messages(v.errors));
});

test('IPv6 的 localIP 能原样写进配置', () => {
  const text = config.serialize(base({}));
  assert.ok(/localIP = "::1"/.test(text), text.split('\n').filter((l) => l.includes('localIP')).join(' | '));
});
