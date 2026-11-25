'use strict';
/* 端口风险分类（1.2.197）：这是「一眼判断该不该发布到公网」的依据，
 * 分类错了会直接误导用户，所以钉死在这几条上。 */
const test = require('node:test');
const assert = require('node:assert');
const { riskOfPort } = require('../../src/main/netport.js');

test('高危端口：文件共享 / 远程桌面 / 数据库 → danger', () => {
  for (const port of [135, 139, 445, 3389, 5985, 5900, 1433, 3306, 5432, 6379, 27017, 9200, 11211]) {
    const risk = riskOfPort(port);
    assert.ok(risk, `${port} 应该有风险标记`);
    assert.strictEqual(risk.level, 'danger', `${port} 应该是 danger`);
    assert.ok(risk.label.length > 0, `${port} 应该给出人类可读的名字`);
  }
});

test('明文/登录类端口 → warn', () => {
  for (const port of [21, 22, 23]) {
    const risk = riskOfPort(port);
    assert.ok(risk, `${port} 应该有风险标记`);
    assert.strictEqual(risk.level, 'warn', `${port} 应该是 warn`);
  }
});

test('普通端口不打扰（web / 应用端口 / 高位端口）', () => {
  for (const port of [80, 443, 3000, 5000, 8080, 18080, 23089, 65535]) {
    assert.strictEqual(riskOfPort(port), null, `${port} 不该有风险标记`);
  }
});

test('端口以字符串传入也能认（netstat 解析出来的可能是字符串）', () => {
  assert.strictEqual(riskOfPort('6379').level, 'danger');
  assert.strictEqual(riskOfPort(' 445 ').level, 'danger');
  assert.strictEqual(riskOfPort('abc'), null);
});
