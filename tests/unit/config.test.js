'use strict';
/* frpc.toml 的解析 / 归一化 / 校验 / 地址推导。
 * 这些函数决定了「界面看到的是不是 frpc 真正读的东西」，出错的表现都是
 * 静默的（列表空白、地址少了端口、代理写不进去），所以用单测钉住。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../../src/main/config');
const { validate } = config;
const { probeTargetFor } = config;

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

test('代理名里的不可见字符（零宽空格 / BOM / 控制符）会被警告', () => {
  const mk = (name) => ({
    serverAddr: '127.0.0.1',
    serverPort: 7000,
    auth: { method: 'token', token: 'x' },
    proxies: [{ name, type: 'tcp', localIP: '127.0.0.1', localPort: 18091, remotePort: 24001 }],
  });
  for (const bad of ['a\u200bb', '\ufeffa', 'a\u0007b', 'a\u200eb']) {
    const result = validate(mk(bad));
    assert.ok(
      result.warnings.some((item) => /不可见字符/.test(String(item.message || item))),
      JSON.stringify({ bad, warnings: result.warnings }),
    );
    assert.strictEqual(
      result.errors.filter((item) => /不可见字符/.test(String(item.message || item))).length,
      0,
      JSON.stringify({ bad, errors: result.errors }),
    );
  }
  for (const good of ['ab', '中文代理-测试', 'p-🚀', 'a.b/c']) {
    const result = validate(mk(good));
    assert.strictEqual(
      result.warnings.filter((item) => /不可见字符/.test(String(item.message || item))).length,
      0,
      JSON.stringify({ good, warnings: result.warnings }),
    );
  }
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

test('只填 subdomain 时用服务器 subDomainHost 补成完整地址', () => {
  const model = { serverAddr: '127.0.0.1', serverPort: 7000, auth: { method: 'token', token: 'x' } };
  const proxy = { name: 's', type: 'http', localIP: '127.0.0.1', localPort: 18080, subdomain: 'demo' };

  const withSuffix = config.publicAddressFor(model, proxy, { vhostHttpPort: 28080, subDomainHost: 'frp.example.com' });
  assert.strictEqual(withSuffix, 'http://demo.frp.example.com:28080');

  const noSuffix = config.publicAddressFor(model, proxy, { vhostHttpPort: 28080 });
  assert.strictEqual(noSuffix, 'subdomain:demo');

  const target = probeTargetFor(model, proxy, { vhostHttpPort: 28080, subDomainHost: 'frp.example.com' });
  assert.strictEqual(target.host, 'demo.frp.example.com');
  assert.strictEqual(target.url, 'http://127.0.0.1:28080/');
});

test('https2http 插件代理的探测 URL 也带访问路径，并用 vhostHttpsPort', () => {
  const model = { serverAddr: '127.0.0.1', serverPort: 7000, auth: { method: 'token', token: 'x' } };
  const proxy = {
    name: 'p',
    type: 'https',
    localIP: '127.0.0.1',
    localPort: 18090,
    customDomains: ['plugin.example.com'],
    openPath: '/panel/',
    plugin: { type: 'https2http', localAddr: '127.0.0.1:18090', crtPath: 'C:/c.pem', keyPath: 'C:/k.pem' },
  };
  const target = probeTargetFor(model, proxy, { vhostHttpsPort: 28443 });
  assert.ok(target, '应当给出探测目标');
  assert.strictEqual(target.kind, 'http');
  assert.strictEqual(target.url, 'https://127.0.0.1:28443/panel/');
  assert.strictEqual(target.servername, 'plugin.example.com');
  assert.strictEqual(target.rejectUnauthorized, false);
  assert.strictEqual(target.openPath, '/panel/');
});

test('subdomain 与自定义域名同时填时给出警告（frp 仍按 subdomain 注册）', () => {
  const mk = (proxy) => ({
    serverAddr: '127.0.0.1',
    serverPort: 7000,
    auth: { method: 'token', token: 'x' },
    proxies: [{ name: 'p', type: 'http', localIP: '127.0.0.1', localPort: 18091, ...proxy }],
  });
  const both = validate(mk({ subdomain: 'demo', customDomains: ['demo.example.com'] }));
  assert.ok(both.warnings.some((item) => /subDomainHost/.test(String(item.message || item))), JSON.stringify(both.warnings));

  const domOnly = validate(mk({ customDomains: ['demo.example.com'] }));
  assert.strictEqual(domOnly.warnings.filter((item) => /subDomainHost/.test(String(item.message || item))).length, 0, JSON.stringify(domOnly.warnings));

  const subOnly = validate(mk({ subdomain: 'demo' }));
  assert.strictEqual(subOnly.warnings.filter((item) => /subDomainHost/.test(String(item.message || item))).length, 0, JSON.stringify(subOnly.warnings));
});

test('同一个域名同时配 http 和 https 不算冲突（走不同的 vhost 端口）', () => {
  const model = {
    serverAddr: '127.0.0.1',
    serverPort: 7000,
    auth: { method: 'token', token: 'x' },
    proxies: [
      { name: 'site-http', type: 'http', localIP: '127.0.0.1', localPort: 18091, customDomains: ['site.example.com'] },
      { name: 'site-https', type: 'https', localIP: '127.0.0.1', localPort: 18091, customDomains: ['site.example.com'] },
    ],
  };
  const result = validate(model);
  assert.strictEqual(result.errors.filter((item) => /已经被/.test(String(item.message || item))).length, 0, JSON.stringify(result.errors));
});

test('https 之间同域名仍然算冲突', () => {
  const model = {
    serverAddr: '127.0.0.1',
    serverPort: 7000,
    auth: { method: 'token', token: 'x' },
    proxies: [
      { name: 'a', type: 'https', localIP: '127.0.0.1', localPort: 18091, customDomains: ['dup2.example.com'] },
      { name: 'b', type: 'https', localIP: '127.0.0.1', localPort: 18091, customDomains: ['dup2.example.com'] },
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

/* 边界：1024 以下是特权端口，frps 非 root 时绑不上，至少要给一条警告 */
test('公网端口 <1024 会给特权端口警告', () => {
  const model = { serverAddr: '1.2.3.4', serverPort: 7000, auth: { method: 'token', token: 't0k' }, proxies: [{ name: 'p', type: 'tcp', localIP: '127.0.0.1', localPort: 8080, remotePort: 80 }] };
  const v = config.validate(model);
  assert.ok(v.warnings.some((w) => /特权端口/.test(w.message)), JSON.stringify(v.warnings));
});

test('公网端口 >=1024 不会误报特权端口', () => {
  const model = { serverAddr: '1.2.3.4', serverPort: 7000, auth: { method: 'token', token: 't0k' }, proxies: [{ name: 'p', type: 'tcp', localIP: '127.0.0.1', localPort: 8080, remotePort: 18080 }] };
  const v = config.validate(model);
  assert.ok(!v.warnings.some((w) => /特权端口/.test(w.message)), JSON.stringify(v.warnings));
});

/* 边界：只差大小写的两个代理名 frpc 允许，但人分不清，给一条警告 */
test('代理名只差大小写时给警告', () => {
  const model = {
    serverAddr: '1.2.3.4',
    serverPort: 7000,
    auth: { method: 'token', token: 't0k' },
    proxies: [
      { name: 'web1', type: 'tcp', localIP: '127.0.0.1', localPort: 80, remotePort: 18080 },
      { name: 'WEB1', type: 'tcp', localIP: '127.0.0.1', localPort: 80, remotePort: 18081 },
    ],
  };
  const v = config.validate(model);
  assert.equal(v.errors.length, 0, JSON.stringify(v.errors));
  assert.ok(v.warnings.some((w) => /只差大小写/.test(w.message)), JSON.stringify(v.warnings));
});

test('完全不同的名字不会误报大小写警告', () => {
  const model = {
    serverAddr: '1.2.3.4',
    serverPort: 7000,
    auth: { method: 'token', token: 't0k' },
    proxies: [
      { name: 'web1', type: 'tcp', localIP: '127.0.0.1', localPort: 80, remotePort: 18080 },
      { name: 'web2', type: 'tcp', localIP: '127.0.0.1', localPort: 80, remotePort: 18081 },
    ],
  };
  const v = config.validate(model);
  assert.ok(!v.warnings.some((w) => /只差大小写/.test(w.message)), JSON.stringify(v.warnings));
});

const { connFingerprint } = require('../../src/main/config.js');

test('connFingerprint 只认连接参数，改代理不影响它', () => {
  const a = connFingerprint({ serverAddr: '1.2.3.4', serverPort: 7000, auth: { method: 'token', token: 't1' }, proxies: [{ name: 'x' }] });
  const b = connFingerprint({ serverAddr: '1.2.3.4', serverPort: 7000, auth: { method: 'token', token: 't1' }, proxies: [{ name: 'y' }] });
  assert.equal(a, b);
});

test('connFingerprint 对地址/端口/token 变化敏感', () => {
  const base = { serverAddr: '1.2.3.4', serverPort: 7000, auth: { method: 'token', token: 't1' } };
  const fp = connFingerprint(base);
  assert.notEqual(fp, connFingerprint({ ...base, serverAddr: '5.6.7.8' }));
  assert.notEqual(fp, connFingerprint({ ...base, serverPort: 7001 }));
  assert.notEqual(fp, connFingerprint({ ...base, auth: { method: 'token', token: 't2' } }));
  assert.equal(connFingerprint(null), '');
});

test('normalize：serverAddr 写成 [::1] 时剥掉方括号（frpc 会拼成 [[::1]]:7000）', () => {
  const m = config.normalize({ serverAddr: '[::1]', serverPort: 7000 });
  assert.equal(m.serverAddr, '::1');
  const m2 = config.normalize({ serverAddr: '  [fd00::1]  ', serverPort: 7000 });
  assert.equal(m2.serverAddr, 'fd00::1');
});

test('normalize：普通主机名与 IPv4 不受影响', () => {
  assert.equal(config.normalize({ serverAddr: 'frp.example.com' }).serverAddr, 'frp.example.com');
  assert.equal(config.normalize({ serverAddr: '1.2.3.4' }).serverAddr, '1.2.3.4');
});


test('formatHostPort：IPv6 加方括号，IPv4/域名原样', () => {
  const { formatHostPort } = config;
  assert.equal(formatHostPort('::1', 24601), '[::1]:24601');
  assert.equal(formatHostPort('[::1]', 24601), '[::1]:24601');
  assert.equal(formatHostPort('fd00::1', 80), '[fd00::1]:80');
  assert.equal(formatHostPort('127.0.0.1', 7000), '127.0.0.1:7000');
  assert.equal(formatHostPort('example.com', 7000), 'example.com:7000');
  assert.equal(formatHostPort('', 7000), '');
  assert.equal(formatHostPort('::1', 0), '');
});

test('IPv6 服务器地址下，tcp 代理的公网地址与探测 URL 都带方括号', () => {
  const { publicAddressFor, probeTargetFor } = config;
  const model = { serverAddr: '::1', serverPort: 7000, proxies: [{ name: 'a', type: 'tcp', localIP: '127.0.0.1', localPort: 18080, remotePort: 24601, openPath: '/' }] };
  const proxy = model.proxies[0];
  assert.equal(publicAddressFor(model, proxy, {}), '[::1]:24601');
  const target = probeTargetFor(model, proxy, {});
  assert.equal(target.kind, 'tcp');
  assert.equal(target.host, '::1');
  assert.equal(target.port, 24601);
});
