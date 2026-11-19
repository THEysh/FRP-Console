'use strict';
/* 证书库的纯逻辑：目录命名、通配符覆盖、剩余天数。
 * 覆盖判定错了会直接导致「代理表单说证书匹配」→ 填进去 frpc 启动失败。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const acme = require('../../src/main/acme');

test('certFolder：通配符用 wildcard. 前缀，非法字符被替换', () => {
  assert.equal(acme.certFolder('a.com'), 'a.com');
  assert.equal(acme.certFolder('*.a.com'), 'wildcard.a.com');
  assert.equal(acme.certFolder('a/b:c'), 'a_b_c');
});

test('coversDomain：同域名 / 通配符一层 / 不越层 / 不覆盖裸域', () => {
  assert.equal(acme.coversDomain('a.com', 'a.com'), true);
  assert.equal(acme.coversDomain('*.a.com', 'x.a.com'), true);
  assert.equal(acme.coversDomain('*.a.com', 'a.com'), false, '裸域不被 *. 覆盖');
  assert.equal(acme.coversDomain('*.a.com', 'x.y.a.com'), false, '只吃一层');
  assert.equal(acme.coversDomain('*.a.com', 'b.com'), false);
  assert.equal(acme.coversDomain('A.COM', 'a.com'), true, '大小写不敏感');
  assert.equal(acme.coversDomain('', 'a.com'), false);
});

test('daysLeft：按剩余天数向下取整，过期给 0 而不是负数', () => {
  const inTenDays = new Date(Date.now() + 10 * 86400000 + 3600000).toISOString();
  assert.equal(acme.daysLeft(inTenDays), 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString();
  assert.equal(acme.daysLeft(yesterday), 0);
  assert.equal(acme.daysLeft('not-a-date'), 0);
});
