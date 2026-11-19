'use strict';
/* 端口矩阵：把「端口该不该通 / 为什么不通」算成一行判定。
 * 这里错一格，服务器页就会把云安全组的问题报成服务器防火墙的问题，
 * 或者把「隧道没跑」刷成一片红色告警。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const pm = require('../../src/main/portmatrix');

test('parseRuleSpec：单端口 / 范围 / 协议', () => {
  assert.deepEqual(pm.parseRuleSpec('7000/tcp'), { start: 7000, end: 7000, proto: 'tcp' });
  assert.deepEqual(pm.parseRuleSpec('16000-16010/udp'), { start: 16000, end: 16010, proto: 'udp' });
  assert.deepEqual(pm.parseRuleSpec('80:90/TCP'), { start: 80, end: 90, proto: 'tcp' });
  assert.equal(pm.parseRuleSpec('abc/tcp'), null);
  assert.equal(pm.parseRuleSpec('7000'), null);
});

test('judgePortRow：可选入口没人监听 → not-enabled（不再刷红）', () => {
  const row = pm.judgePortRow({ port: 443, proto: 'tcp', listen: false, fwActive: true, rule: true, optional: true });
  assert.equal(row.code, 'not-enabled');
  assert.equal(row.tone, 'muted');
  assert.equal(row.action, '');
});

test('judgePortRow：隧道没连这台服务器 → tunnel-stopped 而不是故障', () => {
  const row = pm.judgePortRow({ port: 23180, proto: 'tcp', group: 'proxy', listen: false, fwActive: true, rule: true, tunnelActive: false });
  assert.equal(row.code, 'tunnel-stopped');
  assert.equal(row.tone, 'warn');
});

test('judgePortRow：真没人监听 → not-listening，动作指向服务', () => {
  const row = pm.judgePortRow({ port: 7000, proto: 'tcp', listen: false, fwActive: true, rule: true });
  assert.equal(row.code, 'not-listening');
  assert.equal(row.action, 'service');
});

test('judgePortRow：没有防火墙但外面连不上 → cloud-blocked', () => {
  const row = pm.judgePortRow({ port: 7000, proto: 'tcp', listen: true, fwActive: false, reachable: false });
  assert.equal(row.code, 'cloud-blocked');
  assert.equal(row.action, 'cloud');
});

test('judgePortRow：防火墙已放行但外面连不上 → cloud-blocked（中间设备）', () => {
  const row = pm.judgePortRow({ port: 7000, proto: 'tcp', listen: true, fwActive: true, rule: true, reachable: false });
  assert.equal(row.code, 'cloud-blocked');
});

test('judgePortRow：防火墙没放行 → fw-blocked，动作是「去放行」', () => {
  const row = pm.judgePortRow({ port: 7000, proto: 'tcp', listen: true, fwActive: true, rule: false, reachable: false });
  assert.equal(row.code, 'fw-blocked');
  assert.equal(row.action, 'open');
});

test('judgePortRow：规则没写但实测通 → rule-missing-reachable（warn，不拦）', () => {
  const row = pm.judgePortRow({ port: 7000, proto: 'tcp', listen: true, fwActive: true, rule: false, reachable: true });
  assert.equal(row.code, 'rule-missing-reachable');
  assert.equal(row.tone, 'warn');
});

test('judgePortRow：UDP 没规则 → likely-fw-blocked；有规则 → ok（无法实测）', () => {
  assert.equal(pm.judgePortRow({ port: 7000, proto: 'udp', listen: true, fwActive: true, rule: false }).code, 'likely-fw-blocked');
  const ok = pm.judgePortRow({ port: 7000, proto: 'udp', listen: true, fwActive: true, rule: true });
  assert.equal(ok.code, 'ok');
  assert.match(ok.text, /UDP/);
});

test('buildPortMatrix：三组去重并补 listen / rule', () => {
  const rows = pm.buildPortMatrix({
    cfgPorts: [{ label: 'bindPort', port: 7000, proto: 'tcp' }],
    proxyPorts: [{ label: 'web', port: 23180, proto: 'tcp' }],
    sysPorts: [{ label: 'HTTPS', port: 443, proto: 'tcp', optional: true }],
    allowed: [{ spec: '7000/tcp' }],
    fwActive: true,
    listenPorts: { tcp: new Set([7000, 23180]), udp: new Set() },
    tunnelActive: true,
  });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].code, 'ok', '7000 已放行且有人监听');
  assert.equal(rows[1].code, 'fw-blocked', '代理端口没放行');
  assert.equal(rows[2].code, 'not-enabled', '443 是可选入口');
});

test('summarizeMatrix：分类计数与文案', () => {
  const rows = [
    pm.judgePortRow({ port: 7000, proto: 'tcp', listen: true, fwActive: true, rule: false }),
    pm.judgePortRow({ port: 7001, proto: 'tcp', listen: true, fwActive: false, reachable: false }),
    pm.judgePortRow({ port: 7002, proto: 'tcp', listen: true, fwActive: true, rule: true, reachable: true }),
  ];
  const s = pm.summarizeMatrix(rows);
  assert.equal(s.fwBlocked, 1);
  assert.equal(s.cloudBlocked, 1);
  assert.equal(s.total, 3);
  assert.equal(s.level, 'bad');
  assert.match(s.text, /2 个端口有问题/);
});

test('summarizeMatrix：只有未启用入口时给出「不影响使用」', () => {
  const s = pm.summarizeMatrix([pm.judgePortRow({ port: 443, proto: 'tcp', listen: false, optional: true, fwActive: true })]);
  assert.equal(s.level, 'ok');
  assert.equal(s.notEnabled, 1);
  assert.match(s.text, /还没启用/);
});

test('buildRuleTexts：精确清单去重并补 SSH', () => {
  const out = pm.buildRuleTexts(
    [{ label: 'bindPort', port: 7000, proto: 'tcp' }],
    [{ label: 'web', port: 7000, proto: 'tcp' }],
    [{ label: 'SSH', port: 22, proto: 'tcp' }],
    22,
  );
  const lines = out.exact.split('\n');
  assert.equal(lines.filter((l) => l.includes('7000')).length, 1, '重复端口只出现一次');
  assert.equal(lines.filter((l) => l.includes('22')).length, 1, 'SSH 不重复追加');
  assert.match(out.wide, /1-65535/);
});
