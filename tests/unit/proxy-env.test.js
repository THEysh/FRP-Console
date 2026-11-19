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

/* 1.2.100 起：不再让用户选，默认永远摘掉 —— Windows 的「系统代理」只写注册表、
 * 不设 HTTP_PROXY，所以摘掉它不影响那种代理；而环境里一旦真有变量，frpc 会把到 frps
 * 的 TCP 握手交给 HTTP 代理，被挡回 502，表现成「连不上服务器」。
 * 逃生口两个：配置项 stripProxyEnv:false，或环境变量 FRP_CONSOLE_KEEP_PROXY=1。 */
function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('childEnv：默认就摘掉代理变量（settings 缺失也一样），且不动别的变量', () => {
  withEnv({ HTTP_PROXY: 'http://127.0.0.1:10808', ALL_PROXY: 'socks5://127.0.0.1:1080', FRP_TEST_KEEP: 'keep-me', FRP_CONSOLE_KEEP_PROXY: undefined }, () => {
    for (const settings of [undefined, {}, { stripProxyEnv: true }]) {
      const env = childEnv(settings);
      assert.equal(env.HTTP_PROXY, undefined, '应摘掉 HTTP_PROXY');
      assert.equal(env.ALL_PROXY, undefined, '应摘掉 ALL_PROXY');
      assert.equal(env.FRP_TEST_KEEP, 'keep-me', '别的变量要原样保留');
    }
    /* 不能改到 process.env 本身，否则同进程里别的子进程也被牵连 */
    assert.equal(process.env.HTTP_PROXY, 'http://127.0.0.1:10808');
  });
});

test('childEnv：老配置显式写了 stripProxyEnv:false 时继续尊重（升级不突变）', () => {
  withEnv({ HTTPS_PROXY: 'http://127.0.0.1:10808', FRP_CONSOLE_KEEP_PROXY: undefined }, () => {
    assert.equal(childEnv({ stripProxyEnv: false }).HTTPS_PROXY, 'http://127.0.0.1:10808');
  });
});

test('childEnv：环境变量 FRP_CONSOLE_KEEP_PROXY=1 是逃生口（frps 只能经代理访问时用）', () => {
  withEnv({ HTTPS_PROXY: 'http://127.0.0.1:10808', FRP_CONSOLE_KEEP_PROXY: '1' }, () => {
    assert.equal(childEnv({ stripProxyEnv: true }).HTTPS_PROXY, 'http://127.0.0.1:10808');
    assert.equal(childEnv({}).HTTPS_PROXY, 'http://127.0.0.1:10808');
  });
});

test('childEnv：逃生口只认 "1"，别的值仍然照常摘掉', () => {
  withEnv({ HTTPS_PROXY: 'http://127.0.0.1:10808', FRP_CONSOLE_KEEP_PROXY: 'true' }, () => {
    assert.equal(childEnv({}).HTTPS_PROXY, undefined);
  });
});
