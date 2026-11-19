'use strict';
/* 通用工具与「监听地址分类」。
 * classifyHost 决定服务发现页给端口贴什么标签（回环/全网/Docker/内网/公网），
 * 贴错会让人以为一个只对本机开放的端口暴露在公网上。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const util = require('../../src/main/util');
const netport = require('../../src/main/netport');

test('classifyHost：回环 / 全网 / Docker / 内网 / 公网', () => {
  assert.equal(netport.classifyHost('127.0.0.1'), 'loopback');
  assert.equal(netport.classifyHost('::1'), 'loopback');
  assert.equal(netport.classifyHost('0.0.0.0'), 'all');
  assert.equal(netport.classifyHost('[::]'), 'all');
  assert.equal(netport.classifyHost('::'), 'all');
  assert.equal(netport.classifyHost('172.17.0.1'), 'docker');
  assert.equal(netport.classifyHost('172.31.5.5'), 'docker');
  assert.equal(netport.classifyHost('192.168.1.10'), 'lan');
  assert.equal(netport.classifyHost('10.0.0.8'), 'lan');
  assert.equal(netport.classifyHost('169.254.1.1'), 'lan');
  assert.equal(netport.classifyHost('8.8.8.8'), 'public');
  assert.equal(netport.classifyHost(''), 'other');
});

test('classifyHost：IPv4 映射的 IPv6 还原后再分类', () => {
  assert.equal(netport.classifyHost('::ffff:127.0.0.1'), 'loopback');
  assert.equal(netport.classifyHost('::ffff:192.168.1.1'), 'lan');
});

test('randomToken：长度可控、只用免混淆字符集', () => {
  const token = util.randomToken();
  assert.equal(token.length, 24);
  assert.match(token, /^[abcdefghijkmnpqrstuvwxyz23456789]+$/);
  assert.notEqual(util.randomToken(), util.randomToken(), '两次不能一样');
  assert.equal(util.randomToken(8).length, 8);
  assert.equal(util.randomToken(4).length, 8, '下限 8');
  assert.equal(util.randomToken(999).length, 64, '上限 64');
});

test('parseTimestamp：行首时间戳解析，无时间戳返回 null', () => {
  const ms = util.parseTimestamp('2026-01-02 03:04:05.123 [I] hello');
  assert.equal(typeof ms, 'number');
  assert.match(new Date(ms).toISOString(), /^2026-01-0/);
  assert.equal(util.parseTimestamp('[I] hello'), null);
  assert.equal(util.parseTimestamp(''), null);
});

test('logLevelOf：优先用日志级别标记，其次按关键字兜底', () => {
  assert.equal(util.logLevelOf('2026-01-02 03:04:05 [D] debug line'), 'debug');
  assert.equal(util.logLevelOf('[I] start'), 'info');
  assert.equal(util.logLevelOf('[W] careful'), 'warn');
  assert.equal(util.logLevelOf('[E] boom'), 'error');
  assert.equal(util.logLevelOf('frpc: something bad'), 'error');
  assert.equal(util.logLevelOf('plain text'), 'info');
});

test('formatDuration：秒 / 分 / 小时 / 天', () => {
  assert.equal(util.formatDuration(0), '0 秒');
  assert.equal(util.formatDuration(5000), '5 秒');
  assert.equal(util.formatDuration(65000), '1 分 5 秒');
  assert.equal(util.formatDuration(3665000), '1 小时 1 分');
  assert.equal(util.formatDuration(90000000), '1 天 1 小时');
});

test('hashText：稳定且区分内容', () => {
  assert.equal(util.hashText('abc'), util.hashText('abc'));
  assert.notEqual(util.hashText('abc'), util.hashText('abd'));
  assert.match(util.hashText('abc'), /^[0-9a-f]{40}$/);
});
