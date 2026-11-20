'use strict';
/* frps 面板口令轮换的文本改写：两种写法都要认，认不出要如实返回 null。 */
const test = require('node:test');
const assert = require('node:assert');
const { rotateWebPassword } = require('../../src/main/frpsconfig');

test('段落写法：替换已有 password', () => {
  const src = '[webServer]\naddr = "0.0.0.0"\nport = 4096\npassword = "old"\n';
  const out = rotateWebPassword(src, 'NEWPASS1');
  assert.match(out, /password = "NEWPASS1"/);
  assert.ok(!out.includes('"old"'));
  assert.match(out, /port = 4096/);
});

test('段落写法：没有 password 行时补一行，且落在该段内', () => {
  const src = '[webServer]\naddr = "127.0.0.1"\n\n[log]\nto = "console"\n';
  const out = rotateWebPassword(src, 'P2');
  const lines = out.split('\n');
  const webAt = lines.indexOf('[webServer]');
  const logAt = lines.indexOf('[log]');
  const pwAt = lines.indexOf('password = "P2"');
  assert.ok(webAt >= 0 && pwAt > webAt && pwAt < logAt, out);
});

test('点号写法：补 webServer.password', () => {
  const src = 'bindPort = 7000\nwebServer.addr = "0.0.0.0"\nwebServer.port = 4096\n';
  const out = rotateWebPassword(src, 'P3');
  assert.match(out, /webServer\.password = "P3"/);
});

test('点号写法：替换已有值', () => {
  const src = 'webServer.password = "old"\nwebServer.port = 4096\n';
  const out = rotateWebPassword(src, 'P4');
  assert.match(out, /webServer\.password = "P4"/);
  assert.ok(!out.includes('"old"'));
});

test('没有面板段时返回 null（交给界面提示）', () => {
  assert.equal(rotateWebPassword('bindPort = 7000\n', 'P5'), null);
  assert.equal(rotateWebPassword('', 'P5'), null);
});

test('口令里的引号会被剥掉，不会写出坏 TOML', () => {
  const out = rotateWebPassword('[webServer]\npassword = "old"\n', 'a"b');
  assert.match(out, /password = "ab"/);
});
