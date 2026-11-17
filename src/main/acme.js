'use strict';

/*
 * Let's Encrypt 证书签发管理（ACME + DNS-01）。
 * 不依赖 electron，userData 目录由调用方显式传入，便于用纯 node 单测。
 *
 * 证书放在 <userDataDir>/certs/<域名>/ 下：
 *   fullchain.pem   证书链（叶子 + 中间），给 frpc 的 plugin.crtPath
 *   chain.pem       仅中间链
 *   cert.pem        叶子证书
 *   key.pem         私钥，给 frpc 的 plugin.keyPath
 *   metadata.json   域名 / 到期时间 / 签发时间等
 *
 * ACME 账户密钥与 accountUrl 放在 <userDataDir>/acme-account.json。
 */

const fs = require('node:fs');
const path = require('node:path');
const acme = require('acme-client');
const { readJson, writeJsonAtomic, ensureDir } = require('./util');
const { dns01Name } = require('./dns');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* 等 TXT 记录真正发布到权威 DNS。用系统解析器轮询（尽力而为）：
 * Cloudflare 建完记录后到权威 NS 可见通常只要几秒，但 Let's Encrypt 有时查得太快会撞上 NXDOMAIN。 */
async function waitForTxt(name, expected, { timeoutMs = 30000, intervalMs = 4000, onTick = null } = {}) {
  const dnsPromises = require('node:dns').promises;
  const start = Date.now();
  const deadline = start + timeoutMs;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts += 1;
    try {
      const records = await dnsPromises.resolveTxt(name);
      const flat = (records || []).flat();
      if (flat.includes(expected)) return true;
    } catch { /* NXDOMAIN 或解析器暂时不可用，继续等 */ }
    if (typeof onTick === 'function') {
      try { onTick({ attempts, elapsed: Date.now() - start }); } catch { /* 进度回调异常不影响签发 */ }
    }
    await sleep(intervalMs);
  }
  return false;
}

function certFolder(domain) {
  /* "*." 在 Windows 目录名里合法，但容易和字面量混淆，改成 wildcard. 前缀。 */
  return String(domain || '').replace(/^\*\./, 'wildcard.').replace(/[\\/:*?"<>|]/g, '_');
}

/* 通配符覆盖判定：`*.example.com` 覆盖 `app.example.com`，但不覆盖 `example.com` 本身、
 * 也不覆盖 `a.b.example.com`（只吃一层标签）。用于「填写的域名是否已被某张证书覆盖」的软提示。 */
function coversDomain(pattern, host) {
  const p = String(pattern || '').trim().toLowerCase();
  const h = String(host || '').trim().toLowerCase();
  if (!p || !h) return false;
  if (p === h) return true;
  if (p.startsWith('*.')) {
    const suffix = p.slice(1); // ".example.com"
    if (!h.endsWith(suffix)) return false;
    const label = h.slice(0, h.length - suffix.length); // "app"
    return label && !label.includes('.');
  }
  return false;
}

function daysLeft(notAfter) {
  const t = new Date(notAfter).getTime();
  if (!t) return 0;
  return Math.max(0, Math.floor((t - Date.now()) / 86400000));
}

/* 读一张证书文件（crtPath 通常指向 fullchain.pem）实际覆盖的域名（SAN/CN），
 * 返回扁平数组。用于「代理里填的域名和证书绑定的域名是否一致」的软校验。 */
function readCertCoverage(crtPath) {
  try {
    const pem = fs.readFileSync(String(crtPath || ''), 'utf8');
    const info = acme.crypto.readCertificateInfo(pem);
    const cn = info.domains && info.domains.commonName;
    const sans = (info.domains && Array.isArray(info.domains.altNames)) ? info.domains.altNames : [];
    const domains = [cn, ...sans].filter(Boolean).map((d) => String(d));
    return { ok: true, domains };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

class AcmeManager {
  constructor({ userDataDir }) {
    this.userDataDir = userDataDir;
    this.certsDir = path.join(userDataDir, 'certs');
    this.accountFile = path.join(userDataDir, 'acme-account.json');
  }

  /* ---------------- 账户 ---------------- */

  async loadAccount() {
    const existing = readJson(this.accountFile, null);
    if (existing && existing.accountKey && typeof existing.accountKey === 'string') {
      // 旧版本曾按 staging/production 分目录存 accountUrls；现在只签生产证书，
      // 读取时兼容旧结构，直接取 production 那份。
      const urls = (existing.accountUrls && typeof existing.accountUrls === 'object')
        ? existing.accountUrls
        : {};
      return {
        accountKey: existing.accountKey,
        accountUrl: String(urls.production || ''),
      };
    }
    // 首次：本地生成一把 2048 位 RSA 账户密钥（ACME 账户密钥，与证书密钥无关）。
    const accountKey = (await acme.crypto.createPrivateKey(2048)).toString('utf8');
    const account = { accountKey, accountUrl: '' };
    writeJsonAtomic(this.accountFile, account);
    return account;
  }

  async saveAccountUrl(accountUrl) {
    const account = await this.loadAccount();
    account.accountUrl = String(accountUrl || '');
    writeJsonAtomic(this.accountFile, account);
  }

  async clientFor({ email }) {
    const account = await this.loadAccount();
    const directoryUrl = acme.directory.letsencrypt.production;
    const client = new acme.Client({
      directoryUrl,
      accountKey: account.accountKey,
      accountUrl: account.accountUrl || undefined,
      backoffAttempts: 20,
      backoffMin: 2000,
      backoffMax: 10000,
    });
    return { client, account, email: String(email || '').trim() };
  }

  /* ---------------- 签发 ---------------- */

  /*
   * 签发一张新证书。dns 是 dns.js 里的 provider 实例（CloudflareDns 等）。
   * domains 至少一项，第一项作为 CSR 的 commonName，其余进 altNames。
   * 返回 { ok, domain, notAfter, crtPath, keyPath, fullchainPath }。
   */
  async issue({ domains, email = '', dns, onProgress = null }) {
    const prog = (label, percent) => {
      if (typeof onProgress === 'function') {
        try { onProgress({ label, percent }); } catch { /* 进度回调异常不影响签发 */ }
      }
    };
    if (!dns || typeof dns.create !== 'function' || typeof dns.remove !== 'function') {
      return { ok: false, error: '缺少 DNS 验证提供者（Cloudflare token 未配置）' };
    }
    const list = (Array.isArray(domains) ? domains : String(domains || '').split(/[,，\s]+/))
      .map((d) => String(d).trim())
      .filter(Boolean);
    if (!list.length) return { ok: false, error: '请至少填写一个要签发的域名' };
    // 去重并保持顺序；首项是 commonName。
    const unique = Array.from(new Set(list));
    const commonName = unique[0];

    prog('初始化 ACME 客户端…', 5);
    const { client, account } = await this.clientFor({ email });
    const beforeUrl = account.accountUrl || '';

    try {
      prog('生成密钥与证书请求…', 10);
      // auto() 内部会在没有 accountUrl 时自动注册账户；这里拿它保存下来复用。
      const [key, csr] = await acme.crypto.createCsr({
        keySize: 2048,
        commonName,
        altNames: unique,
      });

      // 每个授权标识符的 TXT 记录 id，供 challengeRemoveFn 删除。
      const challengeRecords = new Map();
      let challengeIndex = 0;

      prog('创建订单并提交域名…', 15);
      const fullchain = await client.auto({
        csr,
        email: email || undefined,
        termsOfServiceAgreed: true,
        challengePriority: ['dns-01'],
        /* acme-client 的本地 verifyDnsChallenge 会用系统 DNS 去查
         * `_acme-challenge.<identifier>`，而通配符域名的 TXT 实际挂在
         * `_acme-challenge.<去掉*的域名>` 上，它会查错位置；沙箱里的
         * 系统 DNS 也未必可靠。这里跳过本地预检，交给 Let's Encrypt
         * 服务器自己做权威验证（它会把 *. 正确去掉）。 */
        skipChallengeVerification: true,
        challengeCreateFn: async (authz, challenge, keyAuthorization) => {
          // keyAuthorization 对 dns-01 已经是被 sha256 后 base64url 的最终 TXT 值。
          const identifier = authz.identifier && authz.identifier.value ? authz.identifier.value : commonName;
          const idx = challengeIndex++;
          const base = 25 + idx * 18;
          prog(`验证域名 ${identifier}：创建 TXT 记录…`, Math.min(80, base));
          const rec = await dns.create(identifier, keyAuthorization);
          challengeRecords.set(identifier, rec);
          // 等 TXT 真正发布到权威 DNS 再让 Let's Encrypt 验证（Cloudflare 通常几秒内，
          // 但 LE 可能查太快撞上 NXDOMAIN）。用系统解析器尽力轮询。
          await waitForTxt(dns01Name(identifier), keyAuthorization, {
            timeoutMs: 30000,
            intervalMs: 4000,
            onTick: ({ attempts, elapsed }) => {
              prog(`验证域名 ${identifier}：等待 DNS 传播（第 ${attempts} 次检查，已 ${Math.round(elapsed / 1000)}s）…`, Math.min(82, base + attempts * 6));
            },
          });
        },
        challengeRemoveFn: async (authz) => {
          const identifier = authz.identifier && authz.identifier.value ? authz.identifier.value : commonName;
          const rec = challengeRecords.get(identifier);
          if (rec) await dns.remove(identifier, rec.id);
          challengeRecords.delete(identifier);
        },
      });

      if (!beforeUrl) {
        await this.saveAccountUrl(client.getAccountUrl());
      }

      prog('保存证书到本机…', 90);
      return this.storeCertificate({ fullchain, key, domains: unique, email });
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  }

  storeCertificate({ fullchain, key, domains, email }) {
    const primary = domains[0];
    const folder = certFolder(primary);
    const dir = path.join(this.certsDir, folder);
    ensureDir(dir);

    const chainPems = acme.crypto.splitPemChain(fullchain);
    const leaf = chainPems[0] || '';
    const chain = chainPems.slice(1).join('\n');
    const info = acme.crypto.readCertificateInfo(fullchain);

    fs.writeFileSync(path.join(dir, 'fullchain.pem'), fullchain + '\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'cert.pem'), leaf + '\n', 'utf8');
    if (chain) fs.writeFileSync(path.join(dir, 'chain.pem'), chain + '\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'key.pem'), key.toString('utf8'), 'utf8');
    writeJsonAtomic(path.join(dir, 'metadata.json'), {
      domains,
      email: String(email || ''),
      notBefore: info.notBefore ? info.notBefore.toISOString() : null,
      notAfter: info.notAfter ? info.notAfter.toISOString() : null,
      issuedAt: Date.now(),
    });

    return {
      ok: true,
      domain: primary,
      domains,
      folder,
      notBefore: info.notBefore ? info.notBefore.toISOString() : null,
      notAfter: info.notAfter ? info.notAfter.toISOString() : null,
      daysLeft: daysLeft(info.notAfter),
      crtPath: path.join(dir, 'fullchain.pem'),
      keyPath: path.join(dir, 'key.pem'),
      certPath: path.join(dir, 'cert.pem'),
    };
  }

  /* ---------------- 查询 ---------------- */

  /* 把服务器上已有的证书（宝塔 / certbot / 别的工具签的）导入本机库。
   * 只落本机文件，不动服务器；导入后的元数据带 imported 标记，便于 UI 标来源。 */
  importCertificate({ domain, certPem, keyPem, source = 'server', serverHost = '', remoteCertPath = '', remoteKeyPath = '' }) {
    const primary = String(domain || '').trim().toLowerCase();
    if (!primary) return { ok: false, error: '缺少域名' };
    if (!certPem || !keyPem) return { ok: false, error: '证书或私钥内容为空' };
    let info = null;
    try {
      info = acme.crypto.readCertificateInfo(certPem);
    } catch (e) {
      return { ok: false, error: `证书无法解析：${(e && e.message) || e}` };
    }
    const domains = (Array.isArray(info.domains) && info.domains.length ? info.domains : [primary])
      .map((d) => String(d || '').trim().toLowerCase())
      .filter(Boolean);
    const folder = certFolder(primary);
    const dir = path.join(this.certsDir, folder);
    ensureDir(dir);
    const chainPems = acme.crypto.splitPemChain(certPem);
    const leaf = chainPems[0] || '';
    const chain = chainPems.slice(1).join('\n');
    fs.writeFileSync(path.join(dir, 'fullchain.pem'), certPem.replace(/\s*$/, '') + '\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'cert.pem'), leaf + '\n', 'utf8');
    if (chain) fs.writeFileSync(path.join(dir, 'chain.pem'), chain + '\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'key.pem'), keyPem.replace(/\s*$/, '') + '\n', 'utf8');
    const metaPath = path.join(dir, 'metadata.json');
    const prev = readJson(metaPath, null) || {};
    writeJsonAtomic(metaPath, {
      ...prev,
      domains,
      email: prev.email || '',
      notBefore: info.notBefore ? info.notBefore.toISOString() : null,
      notAfter: info.notAfter ? info.notAfter.toISOString() : null,
      issuedAt: prev.issuedAt || Date.now(),
      imported: {
        from: String(source || 'server'),
        serverHost: String(serverHost || ''),
        remoteCertPath: String(remoteCertPath || ''),
        remoteKeyPath: String(remoteKeyPath || ''),
        at: Date.now(),
      },
      // 导入的证书「服务器上本来就有」，不需要再部署；保留 nginx 记录以体现来源
      nginx: prev.nginx || (serverHost
        ? { ok: true, serverNames: [primary], serverHost: String(serverHost), imported: true, at: Date.now() }
        : null),
    });
    return {
      ok: true,
      domain: primary,
      domains,
      folder,
      notAfter: info.notAfter ? info.notAfter.toISOString() : null,
      daysLeft: daysLeft(info.notAfter),
      crtPath: path.join(dir, 'fullchain.pem'),
      keyPath: path.join(dir, 'key.pem'),
      certPath: path.join(dir, 'cert.pem'),
    };
  }

  /* extraDirs：额外只读扫描的证书目录（例如安装版的 %LOCALAPPDATA%\frp-console\certs），
   * 让源码版也能看到安装版签/导入的证书，不用复制文件。 */
  list({ extraDirs = [] } = {}) {
    ensureDir(this.certsDir);
    const result = [];
    const seen = new Set();
    const collect = (baseDir, origin) => {
      try {
        for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          // 旧版本曾把 STAGING 假证书放到 `<域名>.staging` 目录，这里直接跳过，不再显示。
          if (entry.name.endsWith('.staging')) continue;
          if (seen.has(entry.name)) continue;
          const dir = path.join(baseDir, entry.name);
          const meta = readJson(path.join(dir, 'metadata.json'), null);
          if (!meta || !Array.isArray(meta.domains) || !meta.domains.length) continue;
          const fullchainPath = path.join(dir, 'fullchain.pem');
          const keyPath = path.join(dir, 'key.pem');
          const certPath = path.join(dir, 'cert.pem');
          seen.add(entry.name);
          result.push({
            folder: entry.name,
            origin,
            domain: meta.domains[0],
            domains: meta.domains,
            email: meta.email || '',
            notBefore: meta.notBefore || null,
            notAfter: meta.notAfter || null,
            daysLeft: daysLeft(meta.notAfter),
            issuedAt: meta.issuedAt || 0,
            exists: fs.existsSync(fullchainPath) && fs.existsSync(keyPath),
            crtPath: fullchainPath,
            keyPath,
            certPath,
            nginx: meta.nginx || null,
            imported: meta.imported || null,
          });
        }
      } catch { /* ignore */ }
    };
    collect(this.certsDir, 'local');
    for (const extra of extraDirs || []) {
      const dir = String(extra || '').trim();
      if (!dir || path.resolve(dir) === path.resolve(this.certsDir)) continue;
      if (!fs.existsSync(dir)) continue;
      collect(dir, 'install');
    }
    result.sort((a, b) => (b.issuedAt || 0) - (a.issuedAt || 0));
    return result;
  }

  get(domain) {
    const primary = certFolder(domain);
    const matches = this.list().filter((c) => c.domain === domain || certFolder(c.domain) === primary);
    return matches[0] || null;
  }

  /* 记录一张证书最近一次「部署到服务器 nginx」的结果（成功或失败都记），
   * 供证书列表/域名向导显示「已部署 / 未部署」，避免签了证书但没部署到 nginx
   * 时界面还显示一切就绪、浏览器访问 https://域名 却被拒绝。 */
  markNginx(domain, nginxResult, serverHost = '') {
    const cert = this.get(String(domain || '').trim());
    if (!cert) return false;
    const metaPath = path.join(this.certsDir, cert.folder, 'metadata.json');
    const meta = readJson(metaPath, null) || {};
    meta.nginx = nginxResult && typeof nginxResult === 'object'
      ? { ...nginxResult, serverHost: String(serverHost || ''), at: Date.now() }
      : null;
    writeJsonAtomic(metaPath, meta);
    return true;
  }

  /* 续期：对同一批域名重新走一次签发。 */
  async renew(domain, { email = '', dns, onProgress = null } = {}) {
    const existing = this.get(domain);
    if (!existing) return { ok: false, error: `本地没有 ${domain} 的证书，请直接签发` };
    return this.issue({ domains: existing.domains, email: email || existing.email, dns, onProgress });
  }

  /* 自动续期：把「剩余天数 ≤ days」的证书逐张重签，返回结果汇总。
   * 只处理有 DNS 渠道能签的；每张失败不影响其它张。 */
  async renewIfExpiring({ days = 30, dns } = {}) {
    if (!dns || typeof dns.create !== 'function') {
      return { renewed: [], errors: [{ domain: '', error: '缺少 DNS 验证提供者' }] };
    }
    const certs = this.list().filter((c) => c.exists && c.daysLeft <= days);
    const renewed = [];
    const errors = [];
    for (const cert of certs) {
      try {
        const result = await this.issue({
          domains: cert.domains,
          email: cert.email,
          dns,
        });
        if (result.ok) renewed.push({ domain: cert.domain, daysLeft: result.daysLeft, notAfter: result.notAfter });
        else errors.push({ domain: cert.domain, error: result.error });
      } catch (e) {
        errors.push({ domain: cert.domain, error: String((e && e.message) || e) });
      }
    }
    return { renewed, errors };
  }

  removeLocal(domain) {
    const entry = this.get(domain);
    const dir = entry && entry.folder
      ? path.join(this.certsDir, entry.folder)
      : path.join(this.certsDir, certFolder(domain));
    try {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }
}

module.exports = { AcmeManager, daysLeft, certFolder, coversDomain, readCertCoverage, dns01Name };
