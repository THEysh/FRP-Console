'use strict';
/* 多连接数据层（src/main/connections.js）。
 *
 * 这一层最容易出的错不是崩溃，而是「迁移把用户的配置弄丢」和「两条连接共用一个端口」。
 * 所以这里重点钉三件事：迁移幂等、端口不撞、代理身份带连接前缀。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const conn = require('../../src/main/connections');

test('keyOf / splitKey：代理身份带连接前缀，可逆', () => {
  const key = conn.keyOf('c-1', 'nas');
  assert.equal(key, 'c-1::nas');
  assert.deepEqual(conn.splitKey(key), { connectionId: 'c-1', name: 'nas' });
  // 代理名里本身带冒号也不能被切错（frp 允许 name 里有 - _ . 等，稳妥起见按第一个 :: 切）
  assert.deepEqual(conn.splitKey(conn.keyOf('c-2', 'a::b')), { connectionId: 'c-2', name: 'a::b' });
  // 没有前缀时退化成整串（兼容老缓存键）
  assert.deepEqual(conn.splitKey('legacy'), { connectionId: '', name: 'legacy' });
});

test('normalizeConnection：字段收敛与默认值', () => {
  const c = conn.normalizeConnection({ name: '  日本  ', adminPort: 99999 });
  assert.equal(c.name, '日本', '名字去空白');
  assert.equal(c.adminPort, 7400, '非法端口回默认');
  assert.equal(c.enabled, true);
  assert.equal(c.autoReconnect, true);
  assert.match(c.id, /^c-[0-9a-f]{8}$/, '没给 id 时生成');
  const off = conn.normalizeConnection({ id: 'c-x', enabled: false, autoReconnect: false });
  assert.equal(off.enabled, false);
  assert.equal(off.autoReconnect, false);
});

test('migrateConnections：老数据（只有顶层路径）变成一条连接', () => {
  const raw = {
    configPath: 'C:/data/frpc.toml',
    logPath: 'C:/data/frpc.log',
    adminPort: 7400,
    clientServerId: 'srv-jp',
    servers: [{ id: 'srv-jp', name: '日本', host: '154.36.178.154' }],
  };
  const r = conn.migrateConnections(raw);
  assert.equal(r.changed, true);
  assert.equal(r.connections.length, 1);
  const c = r.connections[0];
  assert.equal(c.id, conn.DEFAULT_CONNECTION_ID, '第一条固定 id，便于后续迁移认得出');
  assert.equal(c.serverId, 'srv-jp', '档案绑定要带过去');
  assert.equal(c.name, '日本', '名字取档案名，下拉里能认');
  assert.equal(c.configPath, 'C:/data/frpc.toml');
  assert.equal(c.logPath, 'C:/data/frpc.log');
  assert.equal(c.adminPort, 7400);
  assert.equal(r.activeConnectionId, c.id);
});

test('migrateConnections：没有档案时也能造出一条可用的默认连接', () => {
  const r = conn.migrateConnections({ configPath: '', adminPort: 7411 });
  assert.equal(r.connections.length, 1);
  assert.equal(r.connections[0].name, '默认连接');
  assert.equal(r.connections[0].adminPort, 7411);
  assert.equal(r.connections[0].serverId, '');
});

test('migrateConnections：幂等（第二次不再判为变化）', () => {
  const first = conn.migrateConnections({ configPath: 'a.toml', adminPort: 7400 });
  const state = { configPath: 'a.toml', adminPort: 7400, connections: first.connections, activeConnectionId: first.activeConnectionId };
  const second = conn.migrateConnections(state);
  assert.equal(second.changed, false, '重复调用必须稳定，否则每次启动都写盘');
  assert.deepEqual(second.connections, first.connections);
});

test('migrateConnections：多条连接保留，active 无效时落回第一条', () => {
  const r = conn.migrateConnections({
    connections: [
      { id: 'c-a', name: 'A', adminPort: 7400, configPath: 'a.toml' },
      { id: 'c-b', name: 'B', adminPort: 7412, configPath: 'b.toml' },
    ],
    activeConnectionId: 'c-gone',
  });
  assert.equal(r.connections.length, 2);
  assert.equal(r.activeConnectionId, 'c-a');
  assert.equal(r.changed, true, 'active 被修正也算变化');
});

test('端口冲突：两条连接填了同一个管理端口时顺延，不改用户文件', () => {
  const r = conn.dedupeAdminPorts([
    { id: 'c-a', adminPort: 7400 },
    { id: 'c-b', adminPort: 7400 },
    { id: 'c-c', adminPort: 7401 },
  ]);
  assert.equal(r.changed, true);
  assert.deepEqual(r.connections.map((c) => c.adminPort), [7400, 7401, 7402], '第二个让到 7401，第三个再让到 7402');
});

test('nextFreePort：跳过已占用，越界回绕', () => {
  assert.equal(conn.nextFreePort(new Set([7400, 7401]), 7400), 7402);
  assert.equal(conn.nextFreePort(new Set(), 7500), 7500);
  assert.equal(conn.nextFreePort(new Set([65535]), 65535), 7400, '到顶回绕，不会给出 65536');
});

test('applyLegacyPaths：设置页改路径后写回当前连接', () => {
  const list = [
    { id: 'c-a', configPath: 'a.toml', logPath: 'a.log', adminPort: 7400 },
    { id: 'c-b', configPath: 'b.toml', logPath: 'b.log', adminPort: 7412 },
  ];
  const r = conn.applyLegacyPaths(list, 'c-b', { configPath: 'b2.toml' });
  assert.equal(r.changed, true);
  assert.equal(r.connections[0].configPath, 'a.toml', '另一条不能被改');
  assert.equal(r.connections[1].configPath, 'b2.toml');
  const noop = conn.applyLegacyPaths(r.connections, 'c-b', { configPath: 'b2.toml' });
  assert.equal(noop.changed, false, '值没变就不算改动');
});

test('上限：连接数被截到 MAX_CONNECTIONS', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ id: `c-${i}`, adminPort: 7400 + i }));
  const r = conn.migrateConnections({ connections: many });
  assert.equal(r.connections.length, conn.MAX_CONNECTIONS);
});
