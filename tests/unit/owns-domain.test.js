'use strict';
/* 1.2.172：ownsDomain / proxyPublishesDomain 的回归——多连接下判断「这个域名属于哪条连接」。 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const conn = require(path.join(__dirname, '..', '..', 'src', 'main', 'connections.js'));

const modelWith = (proxies, serverAddr = '154.36.178.154') => ({ serverAddr, proxies });

test('proxyPublishesDomain：customDomains 精确命中，忽略大小写与通配符前缀', () => {
  const p = { type: 'http', customDomains: ['Finder.TheYsh.cn'] };
  assert.equal(conn.proxyPublishesDomain(p, 'finder.theysh.cn'), true);
  assert.equal(conn.proxyPublishesDomain(p, '*.finder.theysh.cn'), true, '通配符写法归一后同样命中');
  assert.equal(conn.proxyPublishesDomain(p, 'other.theysh.cn'), false);
});

test('proxyPublishesDomain：subdomain 前缀算作在发布该域名', () => {
  const p = { type: 'https', subdomain: 'demo' };
  assert.equal(conn.proxyPublishesDomain(p, 'demo'), true);
  assert.equal(conn.proxyPublishesDomain(p, 'demo.frp.theysh.cn'), true, '拼上 subDomainHost 也认');
  assert.equal(conn.proxyPublishesDomain(p, 'nope'), false);
});

test('proxyPublishesDomain：tcp/udp/stcp 这类没有域名的代理一律不认', () => {
  for (const type of ['tcp', 'udp', 'stcp', 'sudp', 'xtcp']) {
    assert.equal(conn.proxyPublishesDomain({ type, customDomains: ['a.cn'] }, 'a.cn'), false, `${type} 不该命中`);
  }
  assert.equal(conn.proxyPublishesDomain({ type: 'tcpmux', customDomains: ['mux.cn'] }, 'mux.cn'), true, 'tcpmux 也是按域名路由');
});

test('proxyPublishesDomain：空值/缺字段不炸', () => {
  assert.equal(conn.proxyPublishesDomain(null, 'a.cn'), false);
  assert.equal(conn.proxyPublishesDomain({ type: 'http' }, 'a.cn'), false);
  assert.equal(conn.proxyPublishesDomain({ type: 'http', customDomains: ['a.cn'] }, ''), false);
});

test('ownsDomain：整份配置里任意一条代理发布即可', () => {
  const model = modelWith([
    { type: 'tcp', remotePort: 7001 },
    { type: 'http', customDomains: ['finder.theysh.cn'] },
  ]);
  assert.equal(conn.ownsDomain(model, 'finder.theysh.cn'), true);
  assert.equal(conn.ownsDomain(model, 'missing.theysh.cn'), false);
  assert.equal(conn.ownsDomain(null, 'finder.theysh.cn'), false, '读不到配置时返回 false，不抛异常');
});
