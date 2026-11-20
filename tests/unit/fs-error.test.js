'use strict';
/* explainFsError：把 shell 的写盘错误翻译成能动手的提示。
 * 真机取证（广州，chattr +i 后 root 也写不了）：
 *   部署证书 → install: cannot remove '/etc/nginx/conf.d/frp-console.conf': Operation not permitted
 *   保存配置 → cp: cannot create regular file '/etc/frp/frps.toml': Operation not permitted
 */
const test = require('node:test');
const assert = require('node:assert');
const { explainFsError } = require('../../src/main/ssh.js');

test('Operation not permitted 说明 root 也被拒的三种原因', () => {
  const s = explainFsError("install: cannot remove '/x.conf': Operation not permitted");
  assert.match(s, /root 也被拒绝/);
  assert.match(s, /chattr -i/);
  assert.match(s, /只读挂载|SELinux/);
});

test('Read-only file system 指向只读挂载', () => {
  assert.match(explainFsError('cp: cannot create regular file: Read-only file system'), /只读挂载/);
});

test('磁盘满', () => {
  assert.match(explainFsError('write error: No space left on device'), /磁盘满/);
});

test('Permission denied 提示 root/免密 sudo', () => {
  assert.match(explainFsError('cat: /etc/frp/frps.toml: Permission denied'), /root 或免密 sudo/);
});

test('打开文件数上限', () => {
  assert.match(explainFsError('Too many open files'), /file-max|nofile/);
});

test('认不出来的错误不瞎猜', () => {
  assert.strictEqual(explainFsError('something weird happened'), '');
  assert.strictEqual(explainFsError(''), '');
});
