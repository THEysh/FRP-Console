'use strict';
/* 「不继承系统代理」这个开关到底在管什么：
 * - 只在「应用托管进程」模式 spawn frpc 时生效（childEnv 摘掉这些变量）；
 * - 只有进程环境里真的有这些变量时才有意义 —— Windows 的「系统代理」只写注册表，
 *   不设 HTTP_PROXY，所以那种代理本来就不影响 frpc。
 * proxyEnvKeys() 就是给设置页回答「现在到底有没有」用的。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { proxyEnvKeys } = require('../../src/main/util.js');
const { childEnv } = require('../../src/main/frpc.js');

test('空环境里没有任何代理变量', () => {
  assert.deepEqual(proxyEnvKeys({}), []);
  assert.deepEqual(proxyEnvKeys(undefined), proxyEnvKeys(process.env));
});

test('大写、小写都算', () => {
  assert.deepEqual(proxyEnvKeys({ HTTP_PROXY: 'http://127.0.0.1:10808' }), ['HTTP_PROXY']);
  assert.deepEqual(proxyEnvKeys({ all_proxy: 'socks5://127.0.0.1:1080' }), ['all_proxy']);
  assert.deepEqual(proxyEnvKeys({ HTTPS_PROXY: 'a', NO_PROXY: 'localhost' }).sort(), ['HTTPS_PROXY', 'NO_PROXY']);
});

test('空值与纯空格不算（那等于没设）', () => {
  assert.deepEqual(proxyEnvKeys({ HTTP_PROXY: '', https_proxy: '   ' }), []);
});

test('同名的两个大小写只报存在的那几个', () => {
  assert.deepEqual(proxyEnvKeys({ HTTP_PROXY: 'a', http_proxy: 'b' }).sort(), ['HTTP_PROXY', 'http_proxy']);
});

test('childEnv：默认（stripProxyEnv 未设/为真）摘掉代理变量，且不动别的变量', () => {
  const saved = { ...process.env };
  process.env.HTTP_PROXY = 'http://127.0.0.1:10808';
  process.env.ALL_PROXY = 'socks5://127.0.0.1:1080';
  process.env.FRP_TEST_KEEP = 'keep-me';
  try {
    const env = childEnv({});
    assert.equal(env.HTTP_PROXY, undefined);
    assert.equal(env.ALL_PROXY, undefined);
    assert.equal(env.FRP_TEST_KEEP, 'keep-me');
    /* 不能改到 process.env 本身，否则同进程里别的子进程也被牵连 */
    assert.equal(process.env.HTTP_PROXY, 'http://127.0.0.1:10808');
  } finally {
    delete process.env.HTTP_PROXY;
    delete process.env.ALL_PROXY;
    delete process.env.FRP_TEST_KEEP;
    for (const k of Object.keys(saved)) if (!(k in process.env)) process.env[k] = saved[k];
  }
});

test('childEnv：显式关掉开关时原样继承（用户就想让 frpc 走代理）', () => {
  process.env.HTTPS_PROXY = 'http://127.0.0.1:10808';
  try {
    const env = childEnv({ stripProxyEnv: false });
    assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:10808');
  } finally {
    delete process.env.HTTPS_PROXY;
  }
});
