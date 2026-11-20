'use strict';
/* parseSocketHolder：从 ss/netstat 一行里取出占用端口的进程。
 * 真机原话：LISTEN 6 5 0.0.0.0:7000 0.0.0.0:* users:(("python3",pid=4311,fd=3))
 * （第一版正则多写了一个左括号，导致「端口被别的程序占着」这条判断永远不生效，自检照样报绿。） */
const test = require('node:test');
const assert = require('node:assert');
const { parseSocketHolder } = require('../../src/main/util.js');

test('ss -p 的 python3 占用行', () => {
  const line = 'LISTEN 6 5 0.0.0.0:7000 0.0.0.0:* users:(("python3",pid=4311,fd=3))';
  assert.deepStrictEqual(parseSocketHolder(line), { name: 'python3', pid: '4311' });
});

test('frps 自己占着时也能识别', () => {
  const line = 'LISTEN 0 4096 0.0.0.0:7000 0.0.0.0:* users:(("frps",pid=1234,fd=5))';
  assert.deepStrictEqual(parseSocketHolder(line), { name: 'frps', pid: '1234' });
});

test('多监听者取第一个', () => {
  const line = 'LISTEN 0 4096 0.0.0.0:7000 0.0.0.0:* users:(("a",pid=1,fd=3),("b",pid=2,fd=4))';
  assert.deepStrictEqual(parseSocketHolder(line), { name: 'a', pid: '1' });
});

test('没有 -p 信息时返回 null（老内核/权限不足）', () => {
  assert.strictEqual(parseSocketHolder('LISTEN 0 4096 0.0.0.0:7000 0.0.0.0:*'), null);
  assert.strictEqual(parseSocketHolder(''), null);
  assert.strictEqual(parseSocketHolder(null), null);
});

test('netstat 的行（带 users:(( 形式）', () => {
  const line = 'tcp 0 0 0.0.0.0:7000 0.0.0.0:* LISTEN 1234/frps';
  assert.strictEqual(parseSocketHolder(line), null, 'netstat 没有 users:( 结构，返回 null 由上层兜底');
});
