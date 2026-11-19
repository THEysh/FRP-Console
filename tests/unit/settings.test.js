'use strict';
/* 服务器档案的身份与合并规则（v1.2.69）。
 * 「一个 IP 只能有一条档案」是数据层不变量：错在这里会让下拉框里堆出 20 多条同名项，
 * 用户在错的档案上填的端口/密码全都白填。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

/* settings.js 在模块顶层 require('electron')；单测里给一个最小替身即可，
 * 被测函数（纯数据变换）完全不碰 app / safeStorage。 */
const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: { getPath: () => process.cwd(), getAppPath: () => process.cwd(), getName: () => 'frp-console-test' },
      safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const settings = require('../../src/main/settings');
Module._load = originalLoad;

test('serverProfileKey：host + 端口，username 不参与', () => {
  assert.equal(settings.serverProfileKey({ host: '1.2.3.4', port: 22 }), '1.2.3.4:22');
  assert.equal(settings.serverProfileKey({ host: 'Example.COM.', port: 2222 }), 'example.com:2222');
  assert.equal(settings.serverProfileKey({ host: ' 1.2.3.4 ', username: 'root' }), '1.2.3.4:22', '端口缺省 22');
  assert.equal(settings.serverProfileKey({ host: '1.2.3.4', port: 2222, username: 'a' }), settings.serverProfileKey({ host: '1.2.3.4', port: 2222, username: 'b' }), '换账号不该多一条');
  assert.equal(settings.serverProfileKey({}), '', '没有 host 就没有身份');
});

test('mergeDuplicateServers：同一台机器合成一条，保留最近的、补齐空的', () => {
  const list = [
    { id: 'a', host: '1.2.3.4', port: 22, username: 'old', createdAt: 300, lastConnectedAt: 100 },
    { id: 'b', host: '1.2.3.4', port: 22, username: 'root', clientToken: 'tk', createdAt: 100, lastConnectedAt: 200 },
    { id: 'c', host: 'other.com', port: 2222, username: 'root' },
  ];
  const { servers, merged } = settings.mergeDuplicateServers(list);
  assert.equal(servers.length, 2, 'a+b 合成一条 + other.com 原样保留');
  const kept = servers.filter((s) => s.host === '1.2.3.4');
  assert.equal(kept.length, 1);
  assert.equal(kept[0].id, 'b', '保留最近连接过的那条');
  assert.equal(kept[0].clientToken, 'tk');
  assert.equal(kept[0].createdAt, 100, 'createdAt 取最早');
  assert.equal(kept[0].lastConnectedAt, 200, 'lastConnectedAt 取最新');
  assert.equal(merged.length, 1);
  assert.equal(merged[0].key, '1.2.3.4:22');
  assert.deepEqual(merged[0].dropped, ['a']);
});

test('mergeDuplicateServers：没有 host 的档案原样保留，不参与合并也不丢', () => {
  const { servers } = settings.mergeDuplicateServers([
    { id: 'k1', host: '', name: '半截新建' },
    { id: 'k2', host: '   ' },
    { id: 'x', host: 'a.com' },
  ]);
  assert.equal(servers.length, 3);
  assert.ok(servers.some((s) => s.id === 'k1'));
});

test('mergeDuplicateServers：同键不同端口是两台不同的机器', () => {
  const { servers, merged } = settings.mergeDuplicateServers([
    { id: 'a', host: '1.2.3.4', port: 22 },
    { id: 'b', host: '1.2.3.4', port: 2222 },
  ]);
  assert.equal(servers.length, 2);
  assert.equal(merged.length, 0);
});

test('mergeDuplicateServers：没有重复时幂等（第二次合并无变化）', () => {
  const once = settings.mergeDuplicateServers([
    { id: 'a', host: '1.2.3.4', port: 22, lastConnectedAt: 5 },
    { id: 'b', host: '1.2.3.4', port: 22, lastConnectedAt: 9 },
  ]);
  assert.equal(once.servers.length, 1);
  const twice = settings.mergeDuplicateServers(once.servers);
  assert.equal(twice.servers.length, 1);
  assert.equal(twice.merged.length, 0);
});
