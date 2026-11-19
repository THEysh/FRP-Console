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

/* ---------------- sanitizeSettings（v1.2.94） ----------------
 * 这些值本来只有「保存路径」会夹，load 不夹 —— 于是写坏/手改过的 settings.json
 * 会原样进入运行期：设置页数字框显示 abc、runMode 两个单选都不亮。
 * 要求：类型对且值合法的一律原样保留，只修坏掉的那些。 */
test('sanitizeSettings：合法值原样保留', () => {
  const input = {
    version: 2,
    runMode: 'managed',
    adminPort: 7411,
    vhostHttpPort: 8080,
    vhostHttpsPort: 8443,
    pollIntervalMs: 1500,
    logBuffer: 800,
    closeToTray: false,
    stripProxyEnv: false,
    acmeEmail: 'a@b.com',
    certDirs: ['D:/certs'],
    proxyOpenPaths: { web: '/panel/' },
  };
  const out = settings.sanitizeSettings(input);
  for (const key of Object.keys(input)) assert.deepEqual(out[key], input[key], `${key} 被改了`);
});

test('sanitizeSettings：非法 runMode 一律归到 auto（service 也一样）', () => {
  assert.equal(settings.sanitizeSettings({ runMode: 'nonsense' }).runMode, 'auto');
  assert.equal(settings.sanitizeSettings({ runMode: 'service' }).runMode, 'auto');
  assert.equal(settings.sanitizeSettings({ runMode: 'managed' }).runMode, 'managed');
  assert.equal(settings.sanitizeSettings({}).runMode, 'auto');
});

test('sanitizeSettings：端口/轮询/缓冲按文档区间收敛', () => {
  const out = settings.sanitizeSettings({
    adminPort: 'abc',
    vhostHttpPort: 70000,
    vhostHttpsPort: -1,
    pollIntervalMs: 0,
    logBuffer: -5,
  });
  assert.equal(out.adminPort, 7400, '非数字回到默认');
  assert.equal(out.vhostHttpPort, 80, '越界回到默认');
  assert.equal(out.vhostHttpsPort, 443, '负数回到默认');
  assert.equal(out.pollIntervalMs, 3000, '0 会被加速成狂刷，必须抬高');
  assert.equal(out.logBuffer, 600, '负缓冲无意义');
});

test('sanitizeSettings：布尔/字符串类型不对回到默认，不动其它字段', () => {
  const out = settings.sanitizeSettings({ closeToTray: 'no', autoReload: 0, acmeEmail: 42, serviceName: null, hosts: ['keep'] });
  assert.equal(out.closeToTray, true, '非布尔值应回到默认 true');
  assert.equal(out.autoReload, true);
  assert.equal(out.acmeEmail, '', '42 不是邮箱');
  assert.equal(out.serviceName, 'frpc');
  assert.deepEqual(out.hosts, ['keep'], '不认识的字段不该被删');
});

test('sanitizeSettings：certDirs 与 proxyOpenPaths 结构兜底', () => {
  assert.deepEqual(settings.sanitizeSettings({ certDirs: 'D:/certs' }).certDirs, []);
  assert.deepEqual(settings.sanitizeSettings({ certDirs: ['a', '', null, 'b'] }).certDirs, ['a', 'b']);
  assert.equal(settings.sanitizeSettings({ certDirs: new Array(20).fill('x') }).certDirs.length, 8, '最多 8 个');
  assert.deepEqual(settings.sanitizeSettings({ proxyOpenPaths: ['/x'] }).proxyOpenPaths, {});
  assert.deepEqual(settings.sanitizeSettings({ proxyOpenPaths: null }).proxyOpenPaths, {});
});
