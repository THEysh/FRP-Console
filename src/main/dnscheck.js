'use strict';

/*
 * 域名解析检测（v1.2.58）
 *
 * 背景：以前只用 `dns.promises.resolve4()`（c-ares → 系统配置的 DNS 服务器）判断
 * 「域名有没有解析」。这条路径有两个盲区：
 *   1) 本机 DNS 服务器慢/丢包时，c-ares 要 20~30 秒才超时，前端 8 秒就放弃了，
 *      于是界面显示「未解析」，而域名其实早就解析好了；
 *   2) 域名以前被查过并返回 NXDOMAIN 时，递归解析器会按 SOA MINIMUM 做负缓存
 *      （Cloudflare 默认 1800 秒 = 30 分钟），刚在 CF 里加完记录，本机解析器
 *      仍会继续返回「不存在」，直到负缓存过期。
 * 所以这里改成「多来源并发查」：公共 DoH（Cloudflare / Google）+ 本机解析器 +
 * （可选）权威 NS，然后交叉给出结论，避免单一来源的盲区产生误导性报错。
 *
 * 纯 node 实现（https / dns），不依赖 electron，便于单测。
 */

const https = require('node:https');
const dns = require('node:dns');

/* 记录类型编号 → 名字（DoH 的 Answer[].type 是数字） */
const TYPE_NAME = { 1: 'A', 2: 'NS', 5: 'CNAME', 6: 'SOA', 15: 'MX', 16: 'TXT', 28: 'AAAA' };

const PROVIDERS = [
  { id: 'cf', label: 'Cloudflare 1.1.1.1', host: 'cloudflare-dns.com', path: '/dns-query' },
  { id: 'google', label: 'Google 8.8.8.8', host: 'dns.google', path: '/resolve' },
];

const LOCAL_TIMEOUT_MS = 2500;
const DOH_TIMEOUT_MS = 5000;

/* ------------------------------------------------------------------ */
/* DoH（DNS over HTTPS，JSON 接口）                                     */
/* ------------------------------------------------------------------ */

function dohQuery(provider, name, type = 'A') {
  const p = typeof provider === 'string'
    ? PROVIDERS.find((x) => x.id === provider)
    : provider;
  if (!p) return Promise.resolve({ ok: false, error: `未知的 DNS 服务商 ${provider}`, records: [] });
  const started = Date.now();
  const url = `https://${p.host}${p.path}?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`;
  return new Promise((resolve) => {
    let done = false;
    const finish = (payload) => {
      if (done) return;
      done = true;
      resolve({ ...payload, id: p.id, label: p.label, server: `${p.host}`, ms: Date.now() - started });
    };
    const req = https.request(url, {
      method: 'GET',
      headers: { accept: 'application/dns-json' },
      timeout: DOH_TIMEOUT_MS,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch { /* 非 JSON */ }
        if (!json) return finish({ ok: false, error: `HTTP ${res.statusCode} 响应无法解析`, records: [] });
        const status = json.Status;
        const records = (json.Answer || []).map((a) => ({
          type: TYPE_NAME[a.type] || String(a.type),
          value: String(a.data || '').replace(/\.$/, ''),
          ttl: Number(a.TTL) || 0,
        }));
        finish({
          ok: status === 0,
          status,
          nxdomain: status === 3,
          records,
          error: status === 3 ? 'NXDOMAIN（这条记录不存在）' : (status ? `DNS 状态码 ${status}` : ''),
          soaMinTtl: extractSoaMinTtl(json),
        });
      });
    });
    req.on('timeout', () => { req.destroy(); finish({ ok: false, error: '超时', records: [] }); });
    req.on('error', (e) => finish({ ok: false, error: `${e.code || ''} ${e.message}`.trim(), records: [] }));
    req.end();
  });
}

/* 从 SOA 响应里取负缓存上限（RFC 2308：NXDOMAIN 的缓存时长 = min(SOA TTL, SOA MINIMUM)） */
function extractSoaMinTtl(json) {
  const soa = (json && json.Answer || []).find((a) => a.type === 6);
  if (!soa) {
    const auth = (json && json.Authority) || [];
    const anySoa = auth.find((a) => a.type === 6);
    if (!anySoa) return 0;
    const parts = String(anySoa.data || '').split(/\s+/);
    const min = Number(parts[6]);
    return Number.isFinite(min) ? Math.min(min, Number(anySoa.TTL) || min) : 0;
  }
  const parts = String(soa.data || '').split(/\s+/);
  const min = Number(parts[6]);
  return Number.isFinite(min) ? Math.min(min, Number(soa.TTL) || min) : 0;
}

/* ------------------------------------------------------------------ */
/* 本机解析器（c-ares，走系统配置的 DNS）                                */
/* ------------------------------------------------------------------ */

function withCap(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve({ ...fallback, ms, timeout: true }), ms)),
  ]);
}

function localQuery(name) {
  const started = Date.now();
  /* 注意用 dns.Resolver（回调式），不要用 dns.promises.Resolver：
   * 后者只有 Promise API，传回调会被当成 options，返回的 Promise 没人接 →
   * 域名不存在时抛未处理的 ENOTFOUND rejection，直接把进程带崩。 */
  const resolver = new dns.Resolver({ timeout: LOCAL_TIMEOUT_MS, tries: 1 });
  const call = (fn) => new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve({ ok: false, error: '超时' }); } }, LOCAL_TIMEOUT_MS);
    fn((err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) resolve({ ok: false, error: String(err.code || err.message || err) });
      else resolve({ ok: true, records: value });
    });
  });
  const work = Promise.all([
    call((cb) => resolver.resolve4(name, cb)),
    call((cb) => resolver.resolve6(name, cb)),
    call((cb) => resolver.resolveCname(name, cb)),
  ]).then(([a, aaaa, cname]) => {
    const records = [];
    const ttl = 0;
    if (a.ok) (a.records || []).forEach((v) => records.push({ type: 'A', value: v, ttl }));
    if (aaaa.ok) (aaaa.records || []).forEach((v) => records.push({ type: 'AAAA', value: v, ttl }));
    if (cname.ok) (cname.records || []).forEach((v) => records.push({ type: 'CNAME', value: String(v).replace(/\.$/, ''), ttl }));
    const errors = [a, aaaa, cname].filter((x) => !x.ok).map((x) => x.error);
    const nxdomain = errors.some((e) => /NXDOMAIN|ENOTFOUND|NOTFOUND/i.test(e));
    return {
      id: 'local',
      label: '本机解析器（系统 DNS）',
      server: 'system',
      ok: records.length > 0,
      records,
      ms: Date.now() - started,
      error: records.length ? '' : (nxdomain ? 'NXDOMAIN / ENOTFOUND' : (errors[0] || '无结果')),
    };
  });
  /* 本机 DNS 坏掉时会吊很久（c-ares 反复重试），把整体压到 3.5 秒，
   * 否则一次「检测」要转十几秒，别的前端超时又把它变成「未解析」。 */
  return withCap(work, 3500, { id: 'local', label: '本机解析器（系统 DNS）', server: 'system', ok: false, records: [], error: '超时（本机 DNS 无响应）' });
}

/* ------------------------------------------------------------------ */
/* 权威 NS（先经 DoH 拿到 NS，再直连 53 端口问一次；不通用时容错）        */
/* ------------------------------------------------------------------ */

function apexOf(name) {
  const clean = String(name || '').replace(/^\*\./, '').replace(/\.$/, '');
  const parts = clean.split('.');
  if (parts.length <= 2) return clean;
  return parts.slice(-2).join('.');
}

/* ------------------------------------------------------------------ */
/* 「DNS 是否被本地拦截/劫持」自检                                       */
/* ------------------------------------------------------------------ */

/* 往 TEST-NET-1（192.0.2.123，永远不该有 DNS 服务）发一次查询：
 * 如果 5 毫秒就有人答了，说明本机/运营商在网络层做了 DNS 劫持或透明代理，
 * 那么「本机解析器」和「权威 NS 直连」拿到的结果都不可信（多是劫持方的缓存），
 * 只有走 HTTPS 的 DoH 是干净的。真机上很多国产安全软件/加速器就是这么干的。 */
function probeDnsInterception(name = 'example.com') {
  const started = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (payload) => { if (!settled) { settled = true; resolve({ ...payload, ms: Date.now() - started }); } };
    const timer = setTimeout(() => finish({ intercepted: false, answered: false }), 900);
    try {
      const r = new dns.Resolver({ timeout: 600, tries: 1 });
      r.setServers(['192.0.2.123']);
      r.resolve4(name, (err, addrs) => {
        clearTimeout(timer);
        if (err) return finish({ intercepted: false, answered: false });
        finish({ intercepted: true, answered: true, addrs: addrs || [] });
      });
    } catch {
      clearTimeout(timer);
      finish({ intercepted: false, answered: false });
    }
  });
}

async function authoritativeQuery(name) {
  const work = (async () => {
  const apex = apexOf(name);
  const ns = await dohQuery('cf', apex, 'NS');
  const nsHosts = (ns.records || []).filter((r) => r.type === 'NS').map((r) => r.value);
  if (!nsHosts.length) {
    return { id: 'authoritative', label: '权威 NS', server: '', ok: false, records: [], error: '拿不到权威 NS 列表', nsHosts: [] };
  }
  const host = nsHosts[0];
  const a = await dohQuery('cf', host, 'A');
  const ip = (a.records || []).find((r) => r.type === 'A');
  if (!ip) {
    return { id: 'authoritative', label: `权威 NS（${host}）`, server: host, ok: false, records: [], error: 'NS 没有可用 A 记录', nsHosts };
  }
  const started = Date.now();
  /* 先确认本机 53 端口有没有被劫持：被劫持时「直连权威 NS」其实是在问劫持方的缓存，
   * 拿到的结果是旧值，不能当证据（这正是「CF 里已删、面板却说权威还有」的来源）。 */
  const intercept = await probeDnsInterception(name);
  const result = await new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve({ ok: false, error: 'UDP 53 超时（本机出网可能拦了 DNS）' }); } }, 3000);
    const r = new dns.Resolver({ timeout: 2000, tries: 1 });
    r.setServers([ip.value]);
    r.resolve4(name, (err, addrs) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) resolve({ ok: false, error: String(err.code || err.message || err) });
      else resolve({ ok: true, records: (addrs || []).map((v) => ({ type: 'A', value: v, ttl: 0 })) });
    });
  });
  const intercepted = !!intercept.intercepted;
  return {
    id: 'authoritative',
    label: `权威 NS（${host}）`,
    server: `${host} (${ip.value})`,
    ok: !!result.ok,
    records: result.records || [],
    ms: Date.now() - started,
    error: result.error || '',
    nsHosts,
    intercepted,
    trusted: !intercepted,
    interceptNote: intercepted
      ? `本机 UDP 53 被拦截/透明代理（往 192.0.2.123 发查询也在 ${intercept.ms} ms 内被应答），这次结果可能是劫持方缓存，不能作为依据`
      : '',
  };
  })();
  /* 权威 NS 只是「多一个佐证」，本机 53 出网被拦时不该拖慢整体（UDP 超时 3 秒 + 两次 DoH）。 */
  return withCap(work, 4200, { id: 'authoritative', label: '权威 NS', server: '', ok: false, records: [], error: '查询超时（本机 UDP 53 可能被拦）', trusted: false });
}

/* ------------------------------------------------------------------ */
/* 汇总与结论                                                          */
/* ------------------------------------------------------------------ */

/* 把各来源的记录去重合并成「公共 DNS 认为有哪些记录」 */
function mergeRecords(sources) {
  const out = [];
  const seen = new Set();
  for (const s of sources) {
    for (const r of s.records || []) {
      const key = `${r.type}|${r.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
  }
  return out;
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/* 结论判定（纯函数，单测覆盖）：
 * sources: [{id,label,ok,records,nxdomain,error}]，serverAddr: 当前 frps 服务器 IP
 * cfRecord: 可选，Cloudflare 里这条记录（用来判断橙云代理）
 * 返回 { verdict, tone, title, detail, addrs, matchesServer } */
function judgeResolution({ sources, serverAddr, cfRecord = null, name = '' }) {
  const list = Array.isArray(sources) ? sources : [];
  const publicSources = list.filter((s) => s.id !== 'local' && s.id !== 'authoritative');
  const local = list.find((s) => s.id === 'local');
  const auth = list.find((s) => s.id === 'authoritative');
  const publicRecords = mergeRecords(publicSources);
  const localRecords = (local && local.records) || [];
  /* 权威 NS 直连一旦被本机 DNS 劫持/透明代理污染（见 probeDnsInterception），
   * 它给的多半是劫持方的缓存，不能当证据用。 */
  const authTrusted = !auth || auth.trusted !== false;
  const authRecords = authTrusted ? ((auth && auth.records) || []) : [];
  const publicAddrs = publicRecords.filter((r) => IPV4.test(r.value)).map((r) => r.value);
  const localAddrs = localRecords.filter((r) => IPV4.test(r.value)).map((r) => r.value);
  const authAddrs = authRecords.filter((r) => IPV4.test(r.value)).map((r) => r.value);
  const untrustedAddrs = (!authTrusted && auth ? (auth.records || []) : [])
    .filter((r) => IPV4.test(r.value)).map((r) => r.value);
  const allFailed = list.every((s) => !s.ok);
  /* 公共 DoH「有没有应答」：应答了 NXDOMAIN 和「根本没连上」是两件事，
   * 前者能确定记录不存在，后者只能说明本机网络有问题。 */
  const publicAnswered = publicSources.filter((s) => typeof s.status === 'number');
  const publicNx = publicAnswered.length > 0 && publicAnswered.every((s) => s.nxdomain);
  const server = String(serverAddr || '').trim();
  const matchesServer = !!(server && IPV4.test(server) && (publicAddrs.includes(server) || localAddrs.includes(server)));
  const nxdomainEverywhere = list.length > 0 && list.every((s) => !s.ok && /NXDOMAIN|ENOTFOUND|不存/.test(String(s.error || '')));
  const proxied = !!(cfRecord && cfRecord.proxied);

  if (publicNx) {
    const staleAddrs = [...new Set([...localAddrs, ...authAddrs])];
    if (staleAddrs.length) {
      return {
        verdict: 'stale',
        tone: 'warn',
        title: '记录已删除，本机缓存还留着旧值',
        detail: `公共 DNS（1.1.1.1 / 8.8.8.8）已明确返回 NXDOMAIN —— ${name || '这个域名'} 在 Cloudflare 里已经没有对应记录。但本机解析器/本地缓存仍能解析到 ${staleAddrs.join('、')}，这是缓存残留：A 记录的 TTL（通常 120 秒）到期、或执行一次 ipconfig /flushdns 之后就会消失，公网新访问已经拿不到这个域名。`,
        addrs: staleAddrs,
        matchesServer: false,
        stale: true,
      };
    }
    return {
      verdict: 'missing',
      tone: 'amber',
      title: '没有这条记录',
      detail: `公共 DNS 明确返回 NXDOMAIN：${name || '该域名'} 在权威 DNS 里不存在。${untrustedAddrs.length ? `本机 UDP 53 被拦截/透明代理污染，它还报 ${untrustedAddrs.join('、')}（旧缓存），已忽略。` : ''}请在 Cloudflare 里加一条 A 记录（指向服务器 IP），灰云（仅 DNS）最省事。`,
      addrs: [],
      matchesServer: false,
    };
  }

  if (publicRecords.length || localRecords.length || authRecords.length) {
    if (publicAddrs.length && !localAddrs.length) {
      const localErr = String((local && local.error) || '');
      /* 本机「明确说没有」(NXDOMAIN) 和「根本没答上来」(超时) 是两件事：
       * 前者才是负缓存延迟，后者是本机 DNS 坏了/被拦，两者给的建议完全不同。 */
      if (!/NXDOMAIN|ENOTFOUND/.test(localErr) && localErr) {
        return {
          verdict: 'public-only',
          tone: 'warn',
          title: '公共 DNS 已解析，本机解析器没答上来',
          detail: `1.1.1.1 / 8.8.8.8 已经查到 ${publicAddrs.join('、')}；本机解析器返回「${localErr}」（多半是本机 DNS 不可用、公司网络/VPN 拦了 53 端口，或 hosts 干扰）。这只影响本机自己解析这个域名，不影响证书签发、不影响别人公网访问。`,
          addrs: publicAddrs,
          matchesServer,
        };
      }
      return {
        verdict: 'public-only',
        tone: 'warn',
        title: '公共 DNS 已解析，本机解析器还没更新',
        detail: `1.1.1.1 / 8.8.8.8 已经能查到 ${publicAddrs.join('、')}，但本机解析器返回「不存在」。这通常是本机 DNS 缓存或上游递归解析器的负缓存（NXDOMAIN 会在 SOA MINIMUM 内被缓存，Cloudflare 默认最长 30 分钟）。不影响证书签发与公网访问，稍后重试即可。`,
        addrs: publicAddrs,
        matchesServer,
      };
    }
    if ((publicAddrs.length || localAddrs.length) && server && !matchesServer) {
      return {
        verdict: proxied ? 'proxied' : 'elsewhere',
        tone: proxied ? 'ok' : 'warn',
        title: proxied ? '已解析（Cloudflare 代理开启，返回的是 CF 的 IP）' : '已解析，但没有指向当前服务器',
        detail: proxied
          ? `这条记录在 Cloudflare 里开着橙色云朵，公共 DNS 返回 ${(publicAddrs[0] || localAddrs[0])}（Cloudflare 边缘 IP），这是正常现象：流量会经 Cloudflare 回源到 ${server}。`
          : `解析结果是 ${[...new Set([...publicAddrs, ...localAddrs])].join('、')}，当前服务器是 ${server}。要么 A 记录写错了，要么 DNS 还没传播完。`,
        addrs: [...new Set([...publicAddrs, ...localAddrs])],
        matchesServer,
      };
    }
    if (matchesServer) {
      const who = [];
      if (publicAddrs.includes(server)) who.push('公共 DNS');
      if (localAddrs.includes(server)) who.push('本机解析器');
      if (authAddrs.includes(server)) who.push('权威 NS');
      return {
        verdict: 'ok',
        tone: 'ok',
        title: `已解析到 ${server}`,
        detail: `${who.join(' / ') || '部分来源'} 返回了 ${server}${who.length >= 3 ? '（三方一致）' : ''}。`,
        addrs: [...new Set([...publicAddrs, ...localAddrs])],
        matchesServer,
      };
    }
    return {
      verdict: 'ok',
      tone: 'ok',
      title: '已解析',
      detail: `解析结果：${[...new Set([...publicAddrs, ...localAddrs])].join('、') || publicRecords[0].value}`,
      addrs: [...new Set([...publicAddrs, ...localAddrs])],
      matchesServer,
    };
  }
  if (nxdomainEverywhere || publicNx) {
    const localNote = local && !local.ok && !/NXDOMAIN|ENOTFOUND/.test(String(local.error || ''))
      ? `（本机解析器这次没答上来：${local.error}；不影响结论）`
      : '';
    return {
      verdict: 'missing',
      tone: 'amber',
      title: '没有这条记录',
      detail: `公共 DNS 明确返回 NXDOMAIN：${name || '该域名'} 在权威 DNS 里不存在。请在 Cloudflare 里加一条 A 记录（指向服务器 IP），灰云（仅 DNS）最省事。${localNote}`,
      addrs: [],
      matchesServer: false,
    };
  }
  if (allFailed) {
    /* 四个解析来源全都没拿到结果时，还有一条线索可用：Cloudflare API 是走 HTTPS 的，
     * 常常在本机 53 端口被封/被劫持的情况下依然能读到记录。这时候最该说的是
     * 「记录本身在、指向对不对」，而不是笼统的「查询失败」——后者会把人引去查网络。
     * （2026-11 真机取证：本机 DoH 被拦，面板只显示「查询失败」，用户以为记录没配好。） */
    const cfValue = cfRecord ? String(cfRecord.content || '').trim() : '';
    if (cfRecord && cfValue) {
      const cfPointsHere = !!(server && IPV4.test(server) && cfValue === server);
      const proxyNote = cfRecord.proxied
        ? '这条记录开着橙色云朵（Cloudflare 代理），公网访问会被 CF 边缘接走再回源。'
        : '这条记录是灰色云朵（仅 DNS），公网直接连服务器。';
      const fails = list.map((s) => `${s.label || s.id || '来源'}${s.error ? '（' + s.error + '）' : ''}`).join('、');
      return {
        verdict: 'cf-only',
        tone: cfPointsHere || cfRecord.proxied ? 'ok' : 'warn',
        title: cfPointsHere ? 'Cloudflare 里已指向这台服务器（本机解析没答上来）' : 'Cloudflare 里有这条记录（本机解析没答上来）',
        detail: `Cloudflare 里查到了 ${cfRecord.type} ${cfRecord.name} → ${cfValue}。${proxyNote} 本机四个解析来源都没拿到结果：${fails}。这只说明本机 DNS 出网被拦（公司网络 / VPN / 杀软网络防护），不改变 Cloudflare 上的记录，也不影响证书签发和别人的公网访问。${cfPointsHere ? '' : (server ? `注意：这条记录指向 ${cfValue}，当前服务器是 ${server}，两者不一致。` : '')}`,
        addrs: [cfValue],
        matchesServer: cfPointsHere,
        cfOnly: true,
      };
    }
    return {
      verdict: 'unreachable',
      tone: 'warn',
      title: '查询失败：拿不到 DNS 结果',
      detail: '公共 DoH（1.1.1.1 / 8.8.8.8）与本机解析器都没返回结果，通常是本机网络限制（公司代理、VPN、杀软网络防护）把 DNS 出网拦了。可以先用 https://1.1.1.1/help 验证。',
      addrs: [],
      matchesServer: false,
    };
  }
  return {
    verdict: 'unknown',
    tone: 'warn',
    title: '结果不一致或为空',
    detail: '部分来源有结果、部分没有，稍后重试；也可以展开面板看每个来源的具体返回。',
    addrs: [...new Set([...publicAddrs, ...localAddrs])],
    matchesServer,
  };
}

/* 一次查全：本机 + 两个公共 DoH + 权威，并行。 */
async function resolveName(name) {
  const clean = String(name || '').trim().toLowerCase();
  if (!clean) return { name: '', sources: [], error: '缺少域名' };
  const targets = clean.startsWith('*.') ? clean : clean;
  const [local, cf, google, auth] = await Promise.all([
    localQuery(targets).catch((e) => ({ id: 'local', label: '本机解析器', ok: false, records: [], error: String(e && e.message) })),
    dohQuery('cf', targets, 'A'),
    dohQuery('google', targets, 'A'),
    authoritativeQuery(targets).catch((e) => ({ id: 'authoritative', label: '权威 NS', ok: false, records: [], error: String(e && e.message) })),
  ]);
  const sources = [cf, google, local, auth];
  return { name: clean, sources, soaMinTtl: cf.soaMinTtl || google.soaMinTtl || 0 };
}

module.exports = {
  PROVIDERS,
  dohQuery,
  localQuery,
  authoritativeQuery,
  resolveName,
  judgeResolution,
  mergeRecords,
  apexOf,
  extractSoaMinTtl,
  TYPE_NAME,
};
