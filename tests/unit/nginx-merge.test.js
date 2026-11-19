'use strict';
/* 1.2.98：往 frp-console.conf 写某个域名的 80/443 段时，必须保留同一台机器上
 * 其它域名的段。以前是整份覆盖，结果「给 A 部署证书」把 B 的 443 站点抹掉，
 * B 的请求落到默认站点、拿到 A 的证书，浏览器报 ERR_TLS_CERT_ALTNAME_INVALID，
 * 而我们的健康检查把它说成「TLS 握手被中断 / 没备案」，方向全错。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeNginxConf, nginxServerBlockSpans } = require('../../src/main/ssh.js');

const BLOCK_80 = (name) => `server {\n    listen 80;\n    server_name ${name};\n    location / {\n        proxy_pass http://127.0.0.1:8080;\n    }\n}`;
const BLOCK_443 = (name, dir) => `server {\n    listen 443 ssl;\n    server_name ${name};\n    ssl_certificate ${dir}/fullchain.pem;\n    ssl_certificate_key ${dir}/key.pem;\n    location / {\n        proxy_pass http://127.0.0.1:8080;\n    }\n}`;

const FINDER_CONF = `# 由 FRP-Console 生成：nginx 在 80/443 终止 TLS，把 frp 域名的流量反代给 frps 的 HTTP vhost。
# 修改后请执行 nginx -t && systemctl reload nginx。
${BLOCK_80('finder.theysh.cn')}

${BLOCK_443('finder.theysh.cn', '/etc/nginx/ssl/finder.theysh.cn')}
`;

test('全新的文件：补头注释 + 写两段', () => {
  const out = mergeNginxConf('', { domains: ['a.com'], blocks: [BLOCK_80('a.com'), BLOCK_443('a.com', '/c/a')] });
  assert.match(out, /# 由 FRP-Console 生成/);
  assert.equal(nginxServerBlockSpans(out).length, 2);
  assert.match(out, /server_name a\.com;/);
});

test('已有别的域名：保留，不覆盖', () => {
  const out = mergeNginxConf(FINDER_CONF, { domains: ['jellyfin.theysh.cn'], blocks: [BLOCK_80('jellyfin.theysh.cn'), BLOCK_443('jellyfin.theysh.cn', '/c/j')] });
  assert.match(out, /server_name finder\.theysh\.cn;/);
  assert.match(out, /server_name jellyfin\.theysh\.cn;/);
  assert.equal(nginxServerBlockSpans(out).length, 4);
  /* finder 的 443 段必须还在——这正是原来丢失的那一段 */
  assert.match(out, /ssl_certificate \/etc\/nginx\/ssl\/finder\.theysh\.cn\/fullchain\.pem;/);
});

test('同一域名重复写：替换而不是叠加', () => {
  const out = mergeNginxConf(FINDER_CONF, { domains: ['finder.theysh.cn'], blocks: [BLOCK_80('finder.theysh.cn'), BLOCK_443('finder.theysh.cn', '/new/finder')] });
  const spans = nginxServerBlockSpans(out);
  assert.equal(spans.length, 2);
  assert.match(out, /\/new\/finder\/fullchain\.pem/);
  assert.doesNotMatch(out, /\/etc\/nginx\/ssl\/finder\.theysh\.cn\/fullchain\.pem/);
});

test('server_name 写多个域名时，整段一起替换', () => {
  const conf = `${BLOCK_80('a.com b.com')}\n\n${BLOCK_443('a.com b.com', '/c/ab')}\n`;
  const out = mergeNginxConf(conf, { domains: ['b.com'], blocks: [BLOCK_443('b.com', '/c/b')] });
  const spans = nginxServerBlockSpans(out);
  assert.equal(spans.length, 1);
  assert.match(out, /server_name b\.com;/);
});

test('块外的自定义指令（upstream 等）不被丢掉', () => {
  const conf = `upstream backend {\n    server 127.0.0.1:9000;\n}\n\n${BLOCK_443('a.com', '/c/a')}\n`;
  const out = mergeNginxConf(conf, { domains: ['a.com'], blocks: [BLOCK_443('a.com', '/c/a2')] });
  assert.match(out, /upstream backend/);
  assert.match(out, /127\.0\.0\.1:9000/);
  assert.equal(nginxServerBlockSpans(out).length, 1);
});

test('块内嵌套大括号（if/location）不会把块的边界算错', () => {
  const conf = `server {\n    listen 443 ssl;\n    server_name a.com;\n    location / {\n        if ($http_host = "") {\n            return 444;\n        }\n        proxy_pass http://127.0.0.1:8080;\n    }\n}\n\n${BLOCK_80('keep.com')}\n`;
  const out = mergeNginxConf(conf, { domains: ['a.com'], blocks: [BLOCK_443('a.com', '/c/a')] });
  assert.match(out, /server_name keep\.com;/);
  assert.doesNotMatch(out, /return 444;/);
  assert.equal(nginxServerBlockSpans(out).length, 2);
});

test('没有 server_name 的默认站点保持原样（它不会被当成目标域名）', () => {
  const conf = `server {\n    listen 443 ssl default_server;\n    ssl_certificate /etc/nginx/ssl/def/fullchain.pem;\n}\n`;
  const out = mergeNginxConf(conf, { domains: ['a.com'], blocks: [BLOCK_443('a.com', '/c/a')] });
  assert.equal(nginxServerBlockSpans(out).length, 2);
  assert.match(out, /default_server/);
});
