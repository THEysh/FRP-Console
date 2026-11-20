'use strict';
/* 从远端命令输出里解析事实的纯函数：服务识别、端口输入、防火墙规则、证书引用。
 * 它们错了不会报错，只会让界面显示错的结论（例如把 frpc 的 unit 当成 frps 重写）。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const ssh = require('../../src/main/ssh');

test('parseServiceUnits：解析 systemctl list-units 输出并去掉 .service', () => {
  const text = [
    '  frps.service    loaded active running frp server',
    '● frpc.service    loaded failed failed  frp client',
    '',
  ].join('\n');
  const items = ssh.parseServiceUnits(text);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { unit: 'frps', load: 'loaded', active: 'active', sub: 'running', description: 'frp server' });
  assert.equal(items[1].unit, 'frpc');
  assert.equal(items[1].sub, 'failed');
});

test('rankServiceUnits：frpc 在列表前面时仍然选中 frps', () => {
  const items = ssh.parseServiceUnits('frpc.service loaded active running client\nfrps.service loaded active running server');
  const ranked = ssh.rankServiceUnits(items);
  assert.equal(ranked[0].unit, 'frps');
  assert.equal(ranked[0].sure, true);
  assert.ok(!ranked.some((r) => r.unit === 'frpc'), 'frpc 必须被排除');
});

test('rankServiceUnits：只写 frp 的 unit 不“确定”，需要 ExecStart 再确认', () => {
  const ranked = ssh.rankServiceUnits(ssh.parseServiceUnits('frp.service loaded active running frp'));
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].sure, false);
});

test('rankServiceUnits：frps@lab 这种模板实例算确定', () => {
  const ranked = ssh.rankServiceUnits(ssh.parseServiceUnits('frps@lab.service loaded active running frps'));
  assert.equal(ranked[0].unit, 'frps@lab');
  assert.equal(ranked[0].sure, true);
});

test('rankServiceUnits：只有 frpc 时返回空（宁可不选，也不能动客户端）', () => {
  assert.deepEqual(ssh.rankServiceUnits(ssh.parseServiceUnits('frpc.service loaded active running client')), []);
});

test('parsePortInput：单端口 / 范围 / 反序 / 中文逗号', () => {
  const ok = ssh.parsePortInput('8080, 9000-9002，7000');
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.ranges.map((r) => `${r.start}-${r.end}`), ['8080-8080', '9000-9002', '7000-7000']);
  const reversed = ssh.parsePortInput('9002-9000');
  assert.deepEqual({ start: reversed.ranges[0].start, end: reversed.ranges[0].end }, { start: 9000, end: 9002 }, '反序范围要自动纠正');
});

test('parsePortInput：越界与乱写被拒', () => {
  assert.equal(ssh.parsePortInput('70000').ok, false);
  assert.equal(ssh.parsePortInput('abc').ok, false);
  assert.equal(ssh.parsePortInput('0').ok, false);
});

test('ufwAllowsPort：单端口 / 协议区分 / 范围 / Anywhere', () => {
  const status = [
    'Status: active',
    '',
    'To                         Action      From',
    '--                         ------      ----',
    '22/tcp                     ALLOW       Anywhere',
    '7000/tcp                   ALLOW       Anywhere',
    '16000:16010/udp            ALLOW       Anywhere',
    '80,443/tcp                 ALLOW       Anywhere',
  ].join('\n');
  assert.equal(ssh.ufwAllowsPort(status, 7000, 'tcp').allowed, true);
  assert.equal(ssh.ufwAllowsPort(status, 7000, 'udp').allowed, false, '协议必须区分');
  assert.equal(ssh.ufwAllowsPort(status, 16005, 'udp').allowed, true);
  assert.equal(ssh.ufwAllowsPort(status, 443, 'tcp').allowed, true);
  assert.equal(ssh.ufwAllowsPort(status, 9999, 'tcp').allowed, false);

  const wide = 'Status: active\nAnywhere                   ALLOW       Anywhere';
  assert.equal(ssh.ufwAllowsPort(wide, 12345, 'udp').allowed, true);
});

test('ufwAllowsPort：DENY / REJECT 不算放行', () => {
  const status = 'Status: active\n7000/tcp  DENY  Anywhere\n7001/tcp  REJECT  Anywhere';
  assert.equal(ssh.ufwAllowsPort(status, 7000, 'tcp').allowed, false);
  assert.equal(ssh.ufwAllowsPort(status, 7001, 'tcp').allowed, false);
});

test('parseCertRefs：跳备份文件、跳注释行、只认绝对路径', () => {
  const text = [
    '/etc/nginx/conf.d/frp-console.conf:12:    ssl_certificate /etc/nginx/ssl/a/fullchain.pem;',
    '/etc/nginx/conf.d/frp-console.conf.bak-frpconsole-1:12:    ssl_certificate /etc/nginx/ssl/b/fullchain.pem;',
    '/www/server/panel/vhost/nginx/x.conf:8:    # ssl_certificate /etc/nginx/ssl/c/fullchain.pem;',
    '/www/server/panel/vhost/nginx/y.conf:9:    ssl_certificate ssl/rel.pem;',
  ].join('\n');
  const refs = ssh.parseCertRefs(text);
  assert.equal(refs.length, 1);
  assert.deepEqual(refs[0], { path: '/etc/nginx/ssl/a/fullchain.pem', file: '/etc/nginx/conf.d/frp-console.conf', line: 12 });
});

test('parseMissingPaths：只认 MISSING 前缀', () => {
  const text = 'OK /etc/nginx/ssl/a/fullchain.pem\nMISSING /etc/nginx/ssl/b/fullchain.pem\nnoise';
  assert.deepEqual(ssh.parseMissingPaths(text), ['/etc/nginx/ssl/b/fullchain.pem']);
});

test('removeServerBlocks：按大括号配对摘掉命中块，块外内容原样保留', () => {
  const conf = [
    '# 头注释',
    'server {',
    '    listen 80;',
    '    server_name keep.example.com;',
    '}',
    'server {',
    '    listen 443 ssl;',
    '    ssl_certificate /etc/nginx/ssl/dead/fullchain.pem;',
    '    location / {',
    '        proxy_pass http://127.0.0.1:8080;',
    '    }',
    '}',
    '# 尾注释',
  ].join('\n');
  const out = ssh.removeServerBlocks(conf, ['/etc/nginx/ssl/dead/fullchain.pem']);
  assert.equal(out.removed, 1);
  assert.ok(out.text.includes('server_name keep.example.com;'));
  assert.ok(!out.text.includes('dead/fullchain.pem'));
  assert.ok(out.text.includes('# 头注释') && out.text.includes('# 尾注释'));
  assert.equal(out.text.split('server {').length - 1, 1, '只留下一个 server 块');
});

test('removeServerBlocks：块没闭合时不动（交给 nginx -t 判定）', () => {
  const broken = 'server {\n  listen 443 ssl;\n  ssl_certificate /dead/fullchain.pem;';
  const out = ssh.removeServerBlocks(broken, ['/dead/fullchain.pem']);
  assert.equal(out.removed, 0);
  assert.equal(out.text, broken);
});

const { maskedUnitFromUnitFiles } = require('../../src/main/ssh.js');

test('maskedUnitFromUnitFiles：认出被 mask 的 frps 单元', () => {
  const text = ['frps.service masked', 'frpc.service enabled', 'x-ui.service enabled'].join('\n');
  assert.equal(maskedUnitFromUnitFiles(text), 'frps.service');
});

test('maskedUnitFromUnitFiles：没有 mask 的 frps 就返回空', () => {
  const text = ['frps.service enabled', 'frpc.service enabled'].join('\n');
  assert.equal(maskedUnitFromUnitFiles(text), '');
});

test('maskedUnitFromUnitFiles：只认 frp 系列单元，别把 sshd 的 mask 当 frps', () => {
  const text = ['sshd.service masked', 'cron.service masked'].join('\n');
  assert.equal(maskedUnitFromUnitFiles(text), '');
});

test('maskedUnitFromUnitFiles：空输出/异常输入不抛错', () => {
  assert.equal(maskedUnitFromUnitFiles(''), '');
  assert.equal(maskedUnitFromUnitFiles(null), '');
});
