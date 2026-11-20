'use strict';
/* 插件代理的 localAddr 兜底：frpc 对 https2http/https2https 要求必须有 localAddr，
 * 缺了它会拒绝加载整份配置 —— 一条代理写错，所有代理一起起不来。 */
const { test } = require('node:test');
const assert = require('node:assert');
const config = require('../../src/main/config.js');

const BASE = {
  name: 'web',
  type: 'https',
  localIP: '127.0.0.1',
  localPort: 18091,
  customDomains: ['web.example.com'],
  plugin: { type: 'https2http', crtPath: 'C:/certs/a.pem', keyPath: 'C:/certs/a.key' },
};

const opts = { nginxProxyEnabled: false };

test('没填 localAddr 时按 localIP:localPort 兜底', () => {
  const proxy = config.makeProxy(BASE, opts);
  assert.equal(proxy.plugin.type, 'https2http');
  assert.equal(proxy.plugin.localAddr, '127.0.0.1:18091');
});

test('填了 localAddr 就按用户写的来', () => {
  const proxy = config.makeProxy({ ...BASE, plugin: { ...BASE.plugin, localAddr: '10.0.0.5:8080' } }, opts);
  assert.equal(proxy.plugin.localAddr, '10.0.0.5:8080');
});

test('没填 localIP 时兜底成 127.0.0.1', () => {
  const proxy = config.makeProxy({ ...BASE, localIP: '' }, opts);
  assert.equal(proxy.plugin.localAddr, '127.0.0.1:18091');
});

test('本地端口无效时不瞎写 localAddr（交给校验报错）', () => {
  const proxy = config.makeProxy({ ...BASE, localPort: 0 }, opts);
  assert.equal(proxy.plugin && proxy.plugin.localAddr, undefined);
});

test('nginx 反代模式（方案 Y）下插件被摘掉，回到纯 http', () => {
  const proxy = config.makeProxy(BASE, { nginxProxyEnabled: true });
  assert.equal(proxy.type, 'http');
  assert.equal(proxy.plugin, undefined);
});
