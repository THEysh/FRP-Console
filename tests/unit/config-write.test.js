'use strict';
/* 边界输入：配置文件只读时保存代理。
 * 期望：不抛异常、不静默成功，而是给出一条能行动的中文原因（只读/被占用）。 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../../src/main/config.js');

const MODEL = {
  serverAddr: '127.0.0.1',
  serverPort: 7000,
  auth: { method: 'token', token: 'unit-token-1234567890' },
  log: { to: './frpc.log', level: 'info' },
  proxies: [{ name: 'p1', type: 'tcp', localIP: '127.0.0.1', localPort: 18080, remotePort: 24000 }],
  visitors: [],
  _extra: {},
};

test('explainWriteError 把常见 errno 翻成中文', () => {
  const p = 'C:/tmp/frpc.toml';
  assert.match(config.explainWriteError(p, { code: 'EPERM' }), /不可写.*只读|只读文件/);
  assert.match(config.explainWriteError(p, { code: 'EACCES' }), /不可写/);
  assert.match(config.explainWriteError(p, { code: 'EBUSY' }), /占用/);
  assert.match(config.explainWriteError(p, { code: 'ENOSPC' }), /磁盘空间不足/);
  assert.match(config.explainWriteError(p, { code: 'ENOENT' }), /目录不存在/);
  assert.match(config.explainWriteError(p, new Error('随便什么错')), /配置文件写入失败/);
});

test('只读的 frpc.toml：writeConfig 返回 ok:false 而不是抛异常', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frp-ro-'));
  const file = path.join(dir, 'frpc.toml');
  fs.writeFileSync(file, 'serverAddr = "127.0.0.1"\nserverPort = 7000\n', 'utf8');
  fs.chmodSync(file, 0o444); // 只读
  try {
    const res = config.writeConfig(file, { ...MODEL, auth: { method: 'token', token: 'changed-token-000000' } });
    /* root/管理员在 Windows 上可能仍能写：两种结果都合法，但绝不能抛异常 */
    if (res.ok === false) {
      assert.match(res.error, /不可写|占用|写入失败/);
      assert.equal(fs.readdirSync(dir).filter((n) => n.includes('.tmp-')).length, 0, '失败时不该留下临时文件');
    } else {
      assert.equal(res.changed, true);
    }
  } finally {
    try { fs.chmodSync(file, 0o666); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('正常写入仍然成功且带 changed 标记', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frp-rw-'));
  const file = path.join(dir, 'frpc.toml');
  try {
    const first = config.writeConfig(file, MODEL);
    assert.equal(first.ok, true);
    assert.equal(first.changed, true);
    const second = config.writeConfig(file, MODEL);
    assert.equal(second.changed, false, '同一份内容不该重复写盘');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
