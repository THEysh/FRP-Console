'use strict';
/* 证书库的纯逻辑：目录命名、通配符覆盖、剩余天数。
 * 覆盖判定错了会直接导致「代理表单说证书匹配」→ 填进去 frpc 启动失败。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const acme = require('../../src/main/acme');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

test('removeLocal：目录不存在时明确回 removed:false，不再假装删掉了', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frp-acme-rm-'));
  try {
    const mgr = new acme.AcmeManager({ userDataDir: tmp });
    const miss = mgr.removeLocal('nope.example.com');
    assert.equal(miss.ok, true);
    assert.equal(miss.removed, false);
    const dir = path.join(tmp, 'certs', 'gone.example.com');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'fullchain.pem'), 'x');
    const hit = mgr.removeLocal('gone.example.com');
    assert.equal(hit.ok, true);
    assert.equal(hit.removed, true);
    assert.equal(fs.existsSync(dir), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
