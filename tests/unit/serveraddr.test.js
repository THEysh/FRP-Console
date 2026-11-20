'use strict';
/* 服务器地址的边界：带端口 / 带协议 / 空值 / IPv6。 */
const { test } = require('node:test');
const assert = require('node:assert');
const config = require('../../src/main/config.js');

const mk = (serverAddr, extra = {}) => ({
  serverAddr,
  serverPort: 7000,
  auth: { method: 'token', token: 'tok-1234567890' },
  visitors: [],
  proxies: [],
  _extra: {},
  ...extra,
});

const errors = (v) => v.errors.map((e) => e.message).join(' | ');

test('地址里带端口被拦下（这是最常见的填错）', () => {
  const v = config.validate(mk('127.0.0.1:7000'));
  assert.ok(/不要带 :端口/.test(errors(v)), errors(v));
});

test('域名带端口同样被拦下', () => {
  const v = config.validate(mk('frp.example.com:7000'));
  assert.ok(/不要带 :端口/.test(errors(v)), errors(v));
});

test('IPv6 字面量不被误判成「带端口」', () => {
  assert.equal(config.validate(mk('2001:db8::1')).errors.length, 0);
  assert.equal(config.validate(mk('[::1]')).errors.length, 0);
  assert.equal(config.validate(mk('::1')).errors.length, 0);
});

test('带 http:// 前缀仍然被拦下', () => {
  const v = config.validate(mk('http://frp.example.com'));
  assert.ok(/不要带 http:\/\//.test(errors(v)), errors(v));
});

test('空地址被拦下', () => {
  const v = config.validate(mk(''));
  assert.ok(/不能为空/.test(errors(v)), errors(v));
});

test('普通域名不加任何警告', () => {
  const v = config.validate(mk('frp.example.com'));
  assert.equal(v.warnings.filter((w) => /不是常见的主机名或 IP/.test(w.message)).length, 0);
});
