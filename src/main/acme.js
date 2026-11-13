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
async function waitForTxt(name, expected, { timeoutMs = 30000, intervalMs = 4000 } = {}) {
  const dnsPromises = require('node:dns').promises;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const records = await dnsPromises.resolveTxt(name);
      const flat = (records || []).flat();
      if (flat.includes(expected)) return true;
    } catch { /* NXDOMAIN 或解析器暂时不可用，继续等 */ }
    await sleep(intervalMs);
  }
  return false;
}

function certFolder(domain) {
  /* "*." 在 Windows 目录名里合法，但容易和字面量混淆，改成 wildcard. 前缀。 */
  return String(domain || '').replace(/^\*\./, 'wildcard.').replace(/[\\/:*?"<>|]/g, '_');
}

/* STAGING 与生产证书分目录存放：生产沿用原来的 `wildcard.域名/`（不破坏已存在的
 * 生产证书路径），STAGING 放到 `wildcard.域名.staging/`。这样「误开 STAGING 再签」
 * 只会写进 .staging 目录，绝不会覆盖生产证书。 */
function certFolderFor(domain, staging) {
  const base = certFolder(domain);
  return staging ? `${base}.staging` : base;
}

function daysLeft(notAfter) {
  const t = new Date(notAfter).getTime();
  if (!t) return 0;
  return Math.max(0, Math.floor((t - Date.now()) / 86400000));
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
      // accountUrls 按目录（staging/production）分开存：两个目录的账户 URL 不能混用，
      // 否则签完 staging 再签 production 会拿 staging 的账户 ID 去 production 目录。
      const urls = (existing.accountUrls && typeof existing.accountUrls === 'object')
        ? existing.accountUrls
        : {};
      return {
        accountKey: existing.accountKey,
        accountUrls: {
          staging: String(urls.staging || ''),
          production: String(urls.production || ''),
        },
      };
    }
    // 首次：本地生成一把 2048 位 RSA 账户密钥（ACME 账户密钥，与证书密钥无关）。
    const accountKey = (await acme.crypto.createPrivateKey(2048)).toString('utf8');
    const account = { accountKey, accountUrls: { staging: '', production: '' } };
    writeJsonAtomic(this.accountFile, account);
    return account;
  }

  async saveAccountUrl(accountUrl, staging) {
    const account = await this.loadAccount();
    account.accountUrls[staging ? 'staging' : 'production'] = String(accountUrl || '');
    writeJsonAtomic(this.accountFile, account);
  }

  async clientFor({ staging, email }) {
    const account = await this.loadAccount();
    const directoryUrl = staging
      ? acme.directory.letsencrypt.staging
      : acme.directory.letsencrypt.production;
    const urlKey = staging ? 'staging' : 'production';
    const client = new acme.Client({
      directoryUrl,
      accountKey: account.accountKey,
      accountUrl: account.accountUrls[urlKey] || undefined,
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
  async issue({ domains, email = '', staging = true, dns }) {
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

    const { client, account } = await this.clientFor({ staging, email });
    const urlKey = staging ? 'staging' : 'production';
    const beforeUrl = account.accountUrls[urlKey] || '';

    try {
      // auto() 内部会在没有 accountUrl 时自动注册账户；这里拿它保存下来复用。
      const [key, csr] = await acme.crypto.createCsr({
        keySize: 2048,
        commonName,
        altNames: unique,
      });

      // 每个授权标识符的 TXT 记录 id，供 challengeRemoveFn 删除。
      const challengeRecords = new Map();

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
          const rec = await dns.create(identifier, keyAuthorization);
          challengeRecords.set(identifier, rec);
          // 等 TXT 真正发布到权威 DNS 再让 Let's Encrypt 验证（Cloudflare 通常几秒内，
          // 但 LE 可能查太快撞上 NXDOMAIN）。用系统解析器尽力轮询。
          await waitForTxt(dns01Name(identifier), keyAuthorization);
        },
        challengeRemoveFn: async (authz) => {
          const identifier = authz.identifier && authz.identifier.value ? authz.identifier.value : commonName;
          const rec = challengeRecords.get(identifier);
          if (rec) await dns.remove(identifier, rec.id);
          challengeRecords.delete(identifier);
        },
      });

      if (!beforeUrl) {
        await this.saveAccountUrl(client.getAccountUrl(), staging);
      }

      return this.storeCertificate({ fullchain, key, domains: unique, email, staging });
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  }

  storeCertificate({ fullchain, key, domains, email, staging }) {
    const primary = domains[0];
    const folder = certFolderFor(primary, !!staging);
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
      staging: !!staging,
      notBefore: info.notBefore ? info.notBefore.toISOString() : null,
      notAfter: info.notAfter ? info.notAfter.toISOString() : null,
      issuedAt: Date.now(),
    });

    return {
      ok: true,
      domain: primary,
      domains,
      staging: !!staging,
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

  list() {
    ensureDir(this.certsDir);
    const result = [];
    try {
      for (const entry of fs.readdirSync(this.certsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const meta = readJson(path.join(this.certsDir, entry.name, 'metadata.json'), null);
        if (!meta || !Array.isArray(meta.domains) || !meta.domains.length) continue;
        const dir = path.join(this.certsDir, entry.name);
        const fullchainPath = path.join(dir, 'fullchain.pem');
        const keyPath = path.join(dir, 'key.pem');
        const certPath = path.join(dir, 'cert.pem');
        result.push({
          folder: entry.name,
          domain: meta.domains[0],
          domains: meta.domains,
          email: meta.email || '',
          staging: !!meta.staging,
          notBefore: meta.notBefore || null,
          notAfter: meta.notAfter || null,
          daysLeft: daysLeft(meta.notAfter),
          issuedAt: meta.issuedAt || 0,
          exists: fs.existsSync(fullchainPath) && fs.existsSync(keyPath),
          crtPath: fullchainPath,
          keyPath,
          certPath,
        });
      }
    } catch { /* ignore */ }
    result.sort((a, b) => (b.issuedAt || 0) - (a.issuedAt || 0));
    return result;
  }

  get(domain, { staging } = {}) {
    const primary = certFolder(domain);
    const matches = this.list().filter((c) => c.domain === domain || certFolder(c.domain) === primary);
    if (staging !== undefined) return matches.find((c) => !!c.staging === !!staging) || null;
    return matches[0] || null;
  }

  /* 续期：对同一批域名重新走一次签发。 */
  async renew(domain, { email = '', staging = true, dns } = {}) {
    const existing = this.get(domain, { staging });
    if (!existing) return { ok: false, error: `本地没有 ${domain} 的${staging ? ' STAGING ' : '生产 '}证书，请直接签发` };
    return this.issue({ domains: existing.domains, email: email || existing.email, staging: !!existing.staging, dns });
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
          staging: !!cert.staging,
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

  removeLocal(domain, { staging } = {}) {
    const entry = staging === undefined ? this.get(domain) : this.get(domain, { staging });
    const dir = entry && entry.folder
      ? path.join(this.certsDir, entry.folder)
      : path.join(this.certsDir, certFolderFor(domain, !!staging));
    try {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }
}

module.exports = { AcmeManager, daysLeft, certFolder, certFolderFor, dns01Name };
