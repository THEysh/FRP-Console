'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { KnownHosts, fingerprintOf, targetKey } = require('../../src/main/knownhosts');

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-'));
  return path.join(dir, 'known-hosts.json');
}

const keyA = crypto.randomBytes(64);
const keyB = crypto.randomBytes(64);

test('指纹是 OpenSSH 风格：SHA256: + base64，且不带 = 补位', () => {
  const fp = fingerprintOf(keyA);
  assert.match(fp, /^SHA256:[A-Za-z0-9+/]+$/);
  assert.ok(!fp.endsWith('='));
  assert.strictEqual(fingerprintOf(keyA), fp, '同一把密钥必须稳定');
  assert.notStrictEqual(fingerprintOf(keyB), fp, '不同密钥必须不同');
  assert.strictEqual(fingerprintOf(null), '');
  assert.strictEqual(fingerprintOf(Buffer.alloc(0)), '');
});

test('host:port 是固定键，端口缺省 22，主机名大小写归一', () => {
  assert.strictEqual(targetKey('Example.COM', 22), 'example.com:22');
  assert.strictEqual(targetKey('example.com'), 'example.com:22');
  assert.strictEqual(targetKey(' 10.0.0.1 ', 2222), '10.0.0.1:2222');
});

test('首次见到（new）→ 记为 known → 换密钥变 changed', () => {
  const kh = new KnownHosts(tempFile());
  const first = kh.check('10.0.0.5', 22, keyA);
  assert.strictEqual(first.status, 'new');
  assert.strictEqual(first.previous, '');

  kh.trust('10.0.0.5', 22, first.fingerprint);
  assert.strictEqual(kh.check('10.0.0.5', 22, keyA).status, 'known');

  const changed = kh.check('10.0.0.5', 22, keyB);
  assert.strictEqual(changed.status, 'changed');
  assert.strictEqual(changed.previous, first.fingerprint, '要把旧指纹一起带出来给用户看');
  assert.notStrictEqual(changed.fingerprint, changed.previous);
});

test('信任记录会落盘，重新加载后依然生效（重启后不能忘了）', () => {
  const file = tempFile();
  const kh = new KnownHosts(file);
  kh.trust('10.0.0.6', 2222, fingerprintOf(keyA));

  const again = new KnownHosts(file);
  assert.strictEqual(again.check('10.0.0.6', 2222, keyA).status, 'known');
  assert.strictEqual(again.check('10.0.0.6', 22, keyA).status, 'new', '端口不同视为不同目标');
  assert.deepStrictEqual(again.list().map((h) => h.target), ['10.0.0.6:2222']);
});

test('forget 之后回到 new；坏文件不影响启动', () => {
  const file = tempFile();
  const kh = new KnownHosts(file);
  kh.trust('10.0.0.7', 22, fingerprintOf(keyA));
  kh.forget('10.0.0.7', 22);
  assert.strictEqual(kh.check('10.0.0.7', 22, keyA).status, 'new');

  const broken = tempFile();
  fs.writeFileSync(broken, '{ 这不是 JSON', 'utf8');
  const kh2 = new KnownHosts(broken);
  assert.deepStrictEqual(kh2.list(), [], '坏文件应当当作空表，而不是抛错');
  assert.strictEqual(kh2.check('10.0.0.8', 22, keyA).status, 'new');
});

test('打开文件时忽略格式不对的条目（手工改坏也不会误信）', () => {
  const file = tempFile();
  fs.writeFileSync(file, JSON.stringify({ v: 1, hosts: { 'a:22': 'SHA256:good', 'b:22': 'md5:xx', 'c:22': 123 } }), 'utf8');
  const kh = new KnownHosts(file);
  assert.deepStrictEqual(kh.list(), [{ target: 'a:22', host: 'a', port: 22, fingerprint: 'SHA256:good' }]);
});
