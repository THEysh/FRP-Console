'use strict';
/* 域名解析结论的判定（纯函数）：四个来源各说各话时，给用户一句能照着做的话。
 * 判错的代价很具体——1.2.59 那次「记录已删除」被说成「已解析到服务器」。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const dns = require('../../src/main/dnscheck');

const A = (value, id = 'cf', extra = {}) => ({ id, ok: true, status: 0, records: [{ type: 'A', value }], ...extra });

test('judgeResolution：三来源都命中服务器 IP → ok，且注明三方一致', () => {
  const verdict = dns.judgeResolution({
    name: 'a.com',
    serverAddr: '1.2.3.4',
    sources: [A('1.2.3.4', 'cf'), A('1.2.3.4', 'google'), A('1.2.3.4', 'local'), A('1.2.3.4', 'authoritative')],
  });
  assert.equal(verdict.verdict, 'ok');
  assert.equal(verdict.matchesServer, true);
  assert.match(verdict.detail, /三方一致/);
});

test('judgeResolution：公共 DNS 明确 NXDOMAIN 但本机还有旧值 → stale', () => {
  const verdict = dns.judgeResolution({
    name: 'del.com',
    serverAddr: '1.2.3.4',
    sources: [
      { id: 'cf', ok: false, status: 3, nxdomain: true, records: [] },
      { id: 'google', ok: false, status: 3, nxdomain: true, records: [] },
      A('1.2.3.4', 'local'),
      A('1.2.3.4', 'authoritative'),
    ],
  });
  assert.equal(verdict.verdict, 'stale');
  assert.equal(verdict.stale, true);
  assert.deepEqual(verdict.addrs, ['1.2.3.4']);
});

test('judgeResolution：全都没有记录 → missing', () => {
  const verdict = dns.judgeResolution({
    name: 'none.com',
    serverAddr: '1.2.3.4',
    sources: [
      { id: 'cf', ok: false, status: 3, nxdomain: true, records: [] },
      { id: 'google', ok: false, status: 3, nxdomain: true, records: [] },
      { id: 'local', ok: false, error: 'ENOTFOUND', records: [] },
    ],
  });
  assert.equal(verdict.verdict, 'missing');
  assert.equal(verdict.tone, 'amber');
});

test('judgeResolution：解析到别的 IP → elsewhere，并点名当前服务器', () => {
  const verdict = dns.judgeResolution({
    name: 'wrong.com',
    serverAddr: '1.2.3.4',
    sources: [A('5.5.5.5', 'cf'), A('5.5.5.5', 'local')],
  });
  assert.equal(verdict.verdict, 'elsewhere');
  assert.equal(verdict.matchesServer, false);
  assert.match(verdict.detail, /1\.2\.3\.4/);
});

test('judgeResolution：Cloudflare 开了橙云 → proxied（仍算正常）', () => {
  const verdict = dns.judgeResolution({
    name: 'cf.com',
    serverAddr: '1.2.3.4',
    cfRecord: { proxied: true },
    sources: [A('104.16.0.1', 'cf'), A('104.16.0.1', 'local')],
  });
  assert.equal(verdict.verdict, 'proxied');
  assert.equal(verdict.tone, 'ok');
});

test('judgeResolution：所有来源都失败（网络限制）→ unreachable', () => {
  const verdict = dns.judgeResolution({
    name: 'x.com',
    serverAddr: '1.2.3.4',
    sources: [
      { id: 'cf', ok: false, error: 'ETIMEOUT', records: [] },
      { id: 'google', ok: false, error: 'ETIMEOUT', records: [] },
      { id: 'local', ok: false, error: 'ETIMEOUT', records: [] },
    ],
  });
  assert.equal(verdict.verdict, 'unreachable');
});

test('judgeResolution：权威 NS 被判定不可信时，它的旧值不参与“记录还在不在”', () => {
  const verdict = dns.judgeResolution({
    name: 'del2.com',
    serverAddr: '1.2.3.4',
    sources: [
      { id: 'cf', ok: false, status: 3, nxdomain: true, records: [] },
      { id: 'google', ok: false, status: 3, nxdomain: true, records: [] },
      { id: 'authoritative', ok: true, trusted: false, records: [{ type: 'A', value: '1.2.3.4' }] },
    ],
  });
  assert.equal(verdict.verdict, 'missing', '被污染的权威结果不能把结论拉成 stale');
  assert.match(verdict.detail, /1\.2\.3\.4/);
});

test('apexOf：取注册域', () => {
  assert.equal(dns.apexOf('a.b.example.com'), 'example.com');
  assert.equal(dns.apexOf('example.com'), 'example.com');
  assert.equal(dns.apexOf(''), '');
});

test('extractSoaMinTtl：从 SOA 记录里取负缓存时长', () => {
  const json = { Answer: [{ type: 6, data: 'cf.iana-servers.net. hostmaster.example.com. 1 7200 3600 1209600 1800' }] };
  assert.equal(dns.extractSoaMinTtl(json), 1800);
  assert.equal(dns.extractSoaMinTtl({}), 0);
});

test('全部来源失败但 Cloudflare 有记录：按 cf-only 归因，不误导成「查询失败」', () => {
  const sources = [
    { id: 'cf', label: 'Cloudflare 1.1.1.1', ok: false, error: 'ECONNRESET', records: [] },
    { id: 'google', label: 'Google 8.8.8.8', ok: false, error: '超时', records: [] },
    { id: 'local', label: '本机解析器（系统 DNS）', ok: false, error: 'ENODATA', records: [] },
    { id: 'authoritative', label: '权威 NS', ok: false, error: '拿不到权威 NS 列表', records: [] },
  ];
  const rec = { type: 'A', name: 'cf-probe.theysh.cn', content: '8.148.198.61', proxied: false };
  const hit = dns.judgeResolution({ sources, serverAddr: '8.148.198.61', cfRecord: rec, name: 'cf-probe.theysh.cn' });
  assert.equal(hit.verdict, 'cf-only');
  assert.equal(hit.tone, 'ok');
  assert.equal(hit.matchesServer, true);
  assert.deepEqual(hit.addrs, ['8.148.198.61']);
  assert.match(hit.title, /Cloudflare 里已指向这台服务器/);
  assert.match(hit.detail, /ECONNRESET/);
  const other = dns.judgeResolution({ sources, serverAddr: '1.2.3.4', cfRecord: rec, name: 'cf-probe.theysh.cn' });
  assert.equal(other.verdict, 'cf-only');
  assert.equal(other.tone, 'warn');
  assert.equal(other.matchesServer, false);
  assert.match(other.detail, /两者不一致/);
  const none = dns.judgeResolution({ sources, serverAddr: '8.148.198.61', cfRecord: null, name: 'cf-probe.theysh.cn' });
  assert.equal(none.verdict, 'unreachable');
});
