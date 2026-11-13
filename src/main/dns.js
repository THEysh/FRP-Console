'use strict';

/*
 * DNS-01 验证的域名服务商适配层。
 * 只依赖 Node 内置 https / url，不依赖 electron，方便用纯 node 单测。
 *
 * 每个 provider 实现三个方法，供 src/main/acme.js 的 ACME DNS-01 流程调用：
 *   create(domain, txtValue) -> { id, name }    id 用于删除
 *   remove(domain, id)                         删除 TXT（404 当作已删）
 *   verify(domain, txtValue) -> boolean        查权威记录是否已出现（可选）
 *
 * domain 传的是 ACME 授权里的标识符（可能是 "*.example.com"），
 * 这里统一去掉前导 "*." 再拼 _acme-challenge 前缀。
 */

const https = require('node:https');
const { URL } = require('node:url');

function stripWildcard(domain) {
  return String(domain || '').replace(/^\*\./, '').replace(/\.$/, '');
}

function dns01Name(domain) {
  return `_acme-challenge.${stripWildcard(domain)}`;
}

/* 从域名里取注册域（apex）。Cloudflare 的 zone 是按 apex 建的，
 * 查 zone id 要用 apex 而不是完整子域名。这里按最后两段取，
 * 对 .cn/.com 这类两段后缀足够；co.uk 等复合后缀不在当前目标范围。 */
function apexOf(domain) {
  const name = stripWildcard(domain);
  const parts = name.split('.');
  if (parts.length <= 2) return name;
  return parts.slice(-2).join('.');
}

function requestJson(url, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch { /* 非 JSON 响应 */ }
        resolve({ status: res.statusCode, data: parsed, raw: data });
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function cfError(res, fallback) {
  const err = res && res.data && Array.isArray(res.data.errors) && res.data.errors[0];
  if (err) return `Cloudflare：${err.message || err.code || '未知错误'}`;
  if (res && res.status) return `Cloudflare：HTTP ${res.status}`;
  return fallback || 'Cloudflare 请求失败';
}

class CloudflareDns {
  constructor({ token }) {
    this.token = String(token || '');
    this.base = 'https://api.cloudflare.com/client/v4';
  }

  _headers() {
    return { Authorization: `Bearer ${this.token}` };
  }

  async _zoneId(domain) {
    const apex = apexOf(domain);
    const res = await requestJson(`${this.base}/zones?name=${encodeURIComponent(apex)}`, {
      method: 'GET',
      headers: this._headers(),
    });
    if (res.status !== 200 || !res.data || !res.data.success) {
      throw new Error(cfError(res, `查询 Cloudflare zone ${apex} 失败`));
    }
    const zone = (res.data.result || [])[0];
    if (!zone) {
      throw new Error(`Cloudflare 账号里找不到域名 ${apex}（token 权限不足，或域名不在该账号下）`);
    }
    return zone.id;
  }

  async create(domain, txtValue) {
    const zoneId = await this._zoneId(domain);
    const name = dns01Name(domain);
    const res = await requestJson(`${this.base}/zones/${zoneId}/dns_records`, {
      method: 'POST',
      headers: this._headers(),
      body: { type: 'TXT', name, content: txtValue, ttl: 120 },
    });
    if (res.status !== 200 || !res.data || !res.data.success) {
      throw new Error(cfError(res, `添加 TXT 记录 ${name} 失败`));
    }
    return { id: res.data.result.id, name };
  }

  async remove(domain, id) {
    if (!id) return;
    try {
      const zoneId = await this._zoneId(domain);
      await requestJson(`${this.base}/zones/${zoneId}/dns_records/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: this._headers(),
      });
    } catch (e) {
      /* 删除失败不阻断整个签发流程：验证 TXT 残留无危害，且 Let's Encrypt 下次
       * 重签会用新 token 覆盖同名记录。这里静默记录即可。 */
      console.error(`[dns] 删除 TXT 记录失败（${domain} ${id}）：${(e && e.message) || e}`);
    }
  }

  async verify(domain, txtValue) {
    const zoneId = await this._zoneId(domain);
    const name = dns01Name(domain);
    const res = await requestJson(`${this.base}/zones/${zoneId}/dns_records?type=TXT&name=${encodeURIComponent(name)}`, {
      method: 'GET',
      headers: this._headers(),
    });
    const records = (res.data && res.data.result) || [];
    return records.some((r) => String(r.content || '').includes(txtValue));
  }
}

module.exports = {
  CloudflareDns,
  dns01Name,
  stripWildcard,
  apexOf,
};
