'use strict';
/* frpc.toml 的解析 / 归一化 / 校验 / 地址推导。
 * 这些函数决定了「界面看到的是不是 frpc 真正读的东西」，出错的表现都是
 * 静默的（列表空白、地址少了端口、代理写不进去），所以用单测钉住。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../../src/main/config');
const { validate } = config;

function model(extra = {}) {
  return config.normalize({
    serverAddr: '1.2.3.4',
    serverPort: 7000,
    auth: { method: 'token', token: 'tok' },
    proxies: [],
    ...extra,
  });
}

test('normalize：缺省值安全（空地址 / 7000 / loginFailExit 默认 true）', () => {
  const m = config.normalize({});
  assert.equal(m.serverAddr, '');
  assert.equal(m.serverPort, 7000);
  assert.equal(m.loginFailExit, true);
  assert.equal(m.auth.token, '');
  assert.deepEqual(m.proxies, []);
});

test('normalize：顶层字段类型不对记成 shapeError，并在 validate 里升为 error', () => {
  const m = config.normalize({ proxies: 'oops' });
  assert.equal(m.proxies.length, 0);
  const v = config.validate(m);
  assert.ok(v.errors.some((e) => /proxies 的类型不对/.test(e.message)), '应报 proxies 类型错误');
});

test('normalizeProxy：stcp 上的 remotePort 会被丢掉（frpc 会拒绝整份配置）', () => {
  const m = model({ proxies: [{ name: 'p', type: 'stcp', localPort: 80, remotePort: 9000, secretKey: 'k' }] });
  assert.equal(m.proxies[0].remotePort, undefined);
});

test('normalizeProxy：http + https2http 插件自动纠正成 https', () => {
  const m = model({
    proxies: [{ name: 'p', type: 'http', localPort: 80, customDomains: ['a.com'], plugin: { type: 'https2http', crtPath: 'c', keyPath: 'k' } }],
  });
  assert.equal(m.proxies[0].type, 'https');
});

test('normalizeProxy：方案 Y（nginx 终止 TLS）下插件代理降级为纯 http', () => {
  const m = config.normalize(
    { serverAddr: '1.2.3.4', proxies: [{ name: 'p', type: 'https', localPort: 80, customDomains: ['a.com'], plugin: { type: 'https2http', crtPath: 'c', keyPath: 'k' } }] },
    { nginxProxyEnabled: true },
  );
  assert.equal(m.proxies[0].type, 'http');
  assert.equal(m.proxies[0].plugin, undefined);
});

test('validate：服务器地址为空 / 带协议 / 带空格都算 error', () => {
  const bad = (raw) => config.validate(config.normalize(raw)).errors.some((e) => e.field === 'serverAddr');
  assert.equal(bad({}), true);
  assert.equal(bad({ serverAddr: 'http://1.2.3.4' }), true);
  assert.equal(bad({ serverAddr: '1.2.3.4 x' }), true);
  assert.equal(bad({ serverAddr: '1.2.3.4' }), false);
});

test('validate：serverPort 必须是 1-65535', () => {
  const bad = (port) => config.validate({ ...model(), serverPort: port }).errors.some((e) => e.field === 'serverPort');
  assert.equal(bad(0), true);
  assert.equal(bad(70000), true);
  assert.equal(bad(7000), false);
});

test('validate：代理重名被拒', () => {
  const m = model({
    proxies: [
      { name: 'dup', type: 'tcp', localPort: 80, remotePort: 5001 },
      { name: 'dup', type: 'tcp', localPort: 81, remotePort: 5002 },
    ],
  });
  assert.ok(config.validate(m).errors.some((e) => /dup/.test(e.message)));
});

test('validate：tcp 公网端口重复被拒', () => {
  const m = model({
    proxies: [
      { name: 'a', type: 'tcp', localPort: 80, remotePort: 5000 },
      { name: 'b', type: 'tcp', localPort: 81, remotePort: 5000 },
    ],
  });
  assert.ok(config.validate(m).errors.some((e) => /5000/.test(e.message)));
});

test('validate：http 代理必须有 customDomains 或 subdomain', () => {
  const m = model({ proxies: [{ name: 'h', type: 'http', localPort: 80 }] });
  assert.ok(config.validate(m).errors.some((e) => /域名|subdomain/i.test(e.message)));
});

test('validate：stcp 缺 secretKey 只给 warning，不当 error', () => {
  const m = model({ proxies: [{ name: 's', type: 'stcp', localPort: 80 }] });
  const v = config.validate(m);
  assert.equal(v.errors.length, 0);
  assert.ok(v.warnings.some((w) => /secretKey/i.test(`${w.field} ${w.message}`)));
});

test('validate：浏览器禁用端口（10080）给 warning 而不是拦下', () => {
  const m = model({ proxies: [{ name: 't', type: 'tcp', localPort: 80, remotePort: 10080 }] });
  const v = config.validate(m);
  assert.equal(v.errors.length, 0);
  assert.ok(v.warnings.some((w) => /10080/.test(w.message)));
});

test('suggestRemotePort：从 10000 起找，跳过已用端口与浏览器黑名单', () => {
  assert.equal(config.suggestRemotePort(model()), 10000);
  const taken = model({ proxies: [{ name: 'x', type: 'tcp', localPort: 1, remotePort: 10000 }] });
  assert.equal(config.suggestRemotePort(taken), 10001);
  const upTo79 = model({
    proxies: Array.from({ length: 80 }, (_, i) => ({ name: `p${i}`, type: 'tcp', localPort: 1, remotePort: 10000 + i })),
  });
  assert.equal(config.suggestRemotePort(upTo79), 10081, '10080 必须被跳过');
  assert.equal(config.suggestRemotePort(model(), 'http'), null, 'http 没有公网端口');
});

test('publicAddressFor：tcp / http / 方案 Y 三种形态', () => {
  const m = model();
  assert.equal(config.publicAddressFor(m, { type: 'tcp', remotePort: 23180 }), '1.2.3.4:23180');
  const httpProxy = { type: 'http', customDomains: ['a.com'] };
  assert.equal(config.publicAddressFor(m, httpProxy), 'http://a.com');
  assert.equal(config.publicAddressFor(m, httpProxy, { vhostHttpPort: 8080 }), 'http://a.com:8080');
  assert.equal(config.publicAddressFor(m, httpProxy, { nginxProxyEnabled: true }), 'https://a.com');
});

test('probeTargetFor：访问路径拼进 URL，https 带 SNI，无域名返回 null', () => {
  const m = model();
  const http = config.probeTargetFor(m, { type: 'http', customDomains: ['a.com'], openPath: 'panel/' }, { vhostHttpPort: 8080 });
  assert.equal(http.url, 'http://1.2.3.4:8080/panel/');
  assert.equal(http.host, 'a.com');
  assert.equal(http.openPath, '/panel/');

  const y = config.probeTargetFor(m, { type: 'http', customDomains: ['a.com'], openPath: '/web/' }, { nginxProxyEnabled: true });
  assert.equal(y.url, 'https://1.2.3.4/web/');
  assert.equal(y.servername, 'a.com');
  assert.equal(y.rejectUnauthorized, false);
  assert.equal(y.port, 443);

  const tcp = config.probeTargetFor(m, { type: 'tcp', remotePort: 23180 });
  assert.equal(tcp.port, 23180);

  assert.equal(config.probeTargetFor(m, { type: 'http' }), null);
});

test('重复的自定义域名会被拦下（同一个域名只能给一条 http/https/tcpmux 代理）', () => {
  const model = {
    serverAddr: '127.0.0.1',
    serverPort: 7000,
    auth: { method: 'token', token: 'x' },
    proxies: [
      { name: 'a', type: 'http', localIP: '127.0.0.1', localPort: 18091, customDomains: ['dup.example.com'] },
      { name: 'b', type: 'http', localIP: '127.0.0.1', localPort: 18091, customDomains: ['dup.example.com'] },
    ],
  };
  const result = validate(model);
  assert.ok(result.errors.some((item) => /已经被「a」占用/.test(String(item.message || item))), JSON.stringify(result.errors));
});

test('重复的子域名会被拦下', () => {
  const model = {
    serverAddr: '127.0.0.1',
    serverPort: 7000,
    auth: { method: 'token', token: 'x' },
    proxies: [
      { name: 'a', type: 'http', localIP: '127.0.0.1', localPort: 18091, subdomain: 'same' },
      { name: 'b', type: 'http', localIP: '127.0.0.1', localPort: 18091, subdomain: 'same' },
    ],
  };
  const result = validate(model);
  assert.ok(result.errors.some((item) => /已经被「a」占用/.test(String(item.message || item))), JSON.stringify(result.errors));
});

test('域名各不相同就不报错', () => {
  const model = {
    serverAddr: '127.0.0.1',
    serverPort: 7000,
    auth: { method: 'token', token: 'x' },
    proxies: [
      { name: 'a', type: 'http', localIP: '127.0.0.1', localPort: 18091, customDomains: ['a.example.com'] },
      { name: 'b', type: 'http', localIP: '127.0.0.1', localPort: 18091, customDomains: ['b.example.com'] },
    ],
  };
  assert.equal(validate(model).errors.length, 0);
});

test('域名不能以点开头/结尾或有连续的点（泛域名仍允许）', () => {
  const base = (domains) =>
    config.validate({
      serverAddr: '1.2.3.4',
      serverPort: 7000,
      auth: { method: 'token', token: 't' },
      proxies: [{ name: 'p1', type: 'http', localIP: '127.0.0.1', localPort: 80, customDomains: domains }],
    });
  const bad = ['.a.com', 'a.com.', 'a..com'];
  for (const d of bad) {
    const res = base([d]);
    assert.equal(res.errors.length, 1, `${d} 应被拒`);
    /* \`a.com.` 会先被 isDomainLike 拦下（另一条文案），这里只要求「一定被拒且有中文说明」 */
    assert.match(res.errors[0].message, /域名/);
  }
  for (const d of ['a.com', '*.a.com', 'sub.a.com']) {
    const res = base([d]);
    assert.equal(res.errors.length, 0, `${d} 应被接受，实际：${JSON.stringify(res.errors)}`);
  }
});

test('域名超过 253 字符会被拒（DNS 上限）', () => {
  const long = `${'a'.repeat(250)}.example.com`;
  const res = config.validate({
    serverAddr: '1.2.3.4',
    serverPort: 7000,
    auth: { method: 'token', token: 't' },
    proxies: [{ name: 'p1', type: 'http', localIP: '127.0.0.1', localPort: 80, customDomains: [long] }],
  });
  assert.equal(res.errors.length, 1);
  assert.match(res.errors[0].message, /太长/);
});

/* 边界：服务器 allowPorts 很小且已用满时，端口建议与随机都必须如实返回 null，
 * 不能悄悄给一个「反正 frpc 会拒绝」的端口。 */
test('allowPorts 用满后 suggestRemotePort 返回 null', () => {
  const model = { serverAddr: '1.2.3.4', serverPort: 7000, proxies: [{ name: 'a', type: 'tcp', remotePort: 20000 }] };
  assert.equal(config.suggestRemotePort(model, 'tcp', { allowPorts: [{ single: 20000 }] }), null);
});

test('allowPorts 用满后 randomRemotePort 也返回 null', () => {
  const model = { serverAddr: '1.2.3.4', serverPort: 7000, proxies: [{ name: 'a', type: 'tcp', remotePort: 20000 }] };
  assert.equal(config.randomRemotePort(model, 'tcp', { allowPorts: [{ single: 20000 }] }), null);
});

test('allowPorts 还有空闲时只在白名单里挑', () => {
  const model = { serverAddr: '1.2.3.4', serverPort: 7000, proxies: [{ name: 'a', type: 'tcp', remotePort: 20000 }] };
  const port = config.suggestRemotePort(model, 'tcp', { allowPorts: [{ single: 20000 }, { single: 20001 }] });
  assert.equal(port, 20001);
});
