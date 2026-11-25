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

test('staleDeployments：续期后没重新部署到服务器的证书能被找出来', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frp-acme-stale-'));
  try {
    const dir = path.join(tmp, 'certs', 'a.example.com');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'fullchain.pem'), 'x');
    const meta = {
      domains: ['a.example.com'],
      notBefore: '2026-01-01T00:00:00Z',
      notAfter: '2027-01-01T00:00:00Z',
      nginx: { ok: true, serverHost: '1.2.3.4', notAfter: '2026-06-01T00:00:00Z' },
    };
    fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(meta));
    const mgr = new acme.AcmeManager({ userDataDir: tmp });
    const stale = mgr.staleDeployments('1.2.3.4');
    assert.equal(stale.length, 1);
    assert.equal(stale[0].domain, 'a.example.com');
    assert.equal(mgr.staleDeployments('9.9.9.9').length, 0, '换了服务器就不该再补部署到旧机');

    meta.nginx.notAfter = meta.notAfter;
    fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(meta));
    assert.equal(mgr.staleDeployments('1.2.3.4').length, 0, '已同步的证书不该反复重传');

    delete meta.nginx.notAfter;
    fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(meta));
    assert.equal(mgr.staleDeployments('1.2.3.4').length, 0, '老记录没有 notAfter 时跳过，避免每次连上都重传');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('issue/renew 串行执行：并发调用不会互相踩', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frp-acme-lock-'));
  try {
    const mgr = new acme.AcmeManager({ userDataDir: tmp });
    const order = [];
    let running = 0;
    let maxRunning = 0;
    mgr._issue = async (a) => { running += 1; maxRunning = Math.max(maxRunning, running); order.push('issue:' + a.domains[0]); await new Promise((r) => setTimeout(r, 30)); running -= 1; return { ok: true }; };
    mgr._renew = async (d) => { running += 1; maxRunning = Math.max(maxRunning, running); order.push('renew:' + d); await new Promise((r) => setTimeout(r, 30)); running -= 1; return { ok: true }; };
    await Promise.all([mgr.issue({ domains: ['a.test'] }), mgr.renew('b.test'), mgr.issue({ domains: ['c.test'] })]);
    assert.equal(maxRunning, 1, '同一时刻只应有一个签发在跑');
    assert.deepEqual(order, ['issue:a.test', 'renew:b.test', 'issue:c.test'], '按调用顺序排队');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('certTimes：metadata 没有 notAfter 时从证书文件补读', () => {
  const acme = require('../../src/main/acme.js');
  const path = require('path');
  const pem = path.join(__dirname, '..', '..', 'tests', 'e2e', 'fixtures', 'tls', 'fullchain.pem');
  const t = acme.certTimes(pem);
  assert.match(String(t.notAfter), /^20\d\d-\d\d-\d\dT/);
  /* 读不到就回 null，不抛 */
  const bad = acme.certTimes(path.join(__dirname, 'nope.pem'));
  assert.equal(bad.notAfter, null);
  assert.equal(bad.notBefore, null);
});
