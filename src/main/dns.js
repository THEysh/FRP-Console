'use strict';

/*
 * DNS-01 验证的域名服务商适配层 + 证书页的 DNS 记录面板（v1.2.58）。
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

function requestJson(url, { method = 'GET', headers = {}, body = null, timeout = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method,
      timeout,
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
    /* 没有超时的话，api.cloudflare.com 被网络挡掉时 IPC 会永远挂着，
     * 前端只能干等（表现为「点开 DNS 面板一直转圈」）。 */
    req.on('timeout', () => { req.destroy(new Error(`Cloudflare 请求超时（${Math.round(timeout / 1000)} 秒）`)); });
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

  /* 验证 token 是否有效：GET /user/tokens/verify。
   * 注意：Cloudflare 的 verify 端点只认「用户级」token（cfut_ 开头），
   * 对「账户级」token（cfat_ 开头）会返回 401 Invalid API Token——
   * 但那不代表 token 失效，账户级 token 完全能读写 DNS。
   * 所以 verify 端点 401 时，回退到实际调一次 API（zones 列表）判断有效性。 */
  async verifyToken() {
    const res = await requestJson(`${this.base}/user/tokens/verify`, {
      method: 'GET',
      headers: this._headers(),
    });
    if (res.status === 200 && res.data && res.data.success) {
      const r = res.data.result || {};
      return { status: r.status || '', active: r.status === 'active', method: 'verify' };
    }
    // 401 / Invalid API Token：大概率是账户级 token，改用实际调用验证。
    if (res.status === 401 || /Invalid API Token/i.test(cfError(res, ''))) {
      const z = await requestJson(`${this.base}/zones?per_page=1`, {
        method: 'GET',
        headers: this._headers(),
      });
      if (z.status === 200 && z.data && z.data.success) {
        return { status: 'active', active: true, method: 'zones', note: '账户级 token，已改用实际 API 调用验证' };
      }
      throw new Error(cfError(z, 'token 无效或权限不足（签发证书需 Zone.Zone:Read + Zone.DNS:Edit 权限）'));
    }
    throw new Error(cfError(res, 'token 校验失败'));
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

  /* 给某个名字建/改 A 记录，指向 frps 服务器 IP。域名向导「一键建解析」用。
   * 名字不带通配符时就是 A 记录；带 *. 时 Cloudflare 存的名字本身就是 "*.x"。
   * 已存在同名 A 记录则更新其 content，不存在才新建。 */
  async setARecord(domain, ip) {
    const name = stripWildcard(domain);
    const zoneId = await this._zoneId(name);
    const host = name === apexOf(name) ? name : name;
    const list = await requestJson(`${this.base}/zones/${zoneId}/dns_records?type=A&name=${encodeURIComponent(host)}`, {
      method: 'GET',
      headers: this._headers(),
    });
    if (list.status !== 200 || !list.data || !list.data.success) {
      throw new Error(cfError(list, `查询 A 记录 ${host} 失败`));
    }
    const existing = (list.data.result || [])[0];
    if (existing) {
      if (String(existing.content) === String(ip)) {
        return { id: existing.id, name: existing.name, content: existing.content, updated: false };
      }
      const upd = await requestJson(`${this.base}/zones/${zoneId}/dns_records/${existing.id}`, {
        method: 'PUT',
        headers: this._headers(),
        body: { type: 'A', name: existing.name, content: ip, ttl: 120, proxied: false },
      });
      if (upd.status !== 200 || !upd.data || !upd.data.success) {
        throw new Error(cfError(upd, `更新 A 记录 ${host} 失败`));
      }
      return { id: upd.data.result.id, name: upd.data.result.name, content: upd.data.result.content, updated: true };
    }
    const create = await requestJson(`${this.base}/zones/${zoneId}/dns_records`, {
      method: 'POST',
      headers: this._headers(),
      body: { type: 'A', name: host, content: ip, ttl: 120, proxied: false },
    });
    if (create.status !== 200 || !create.data || !create.data.success) {
      throw new Error(cfError(create, `添加 A 记录 ${host} 失败`));
    }
    return { id: create.data.result.id, name: create.data.result.name, content: create.data.result.content, updated: true };
  }
  /* ---- 证书页「DNS 记录」面板用：任意类型记录的查/增/删（v1.2.58） ---- */

  /* 列出某个域名下的记录。
   * name 可以是 "finder.theysh.cn"、也可以是通配符 "*.theysh.cn"（Cloudflare 里存的就是 "*"）。
   * zone 级别的全量记录用 listZoneRecords 取（用于「同 zone 其它记录」参考）。 */
  async listRecords(domain, { type = '' } = {}) {
    const zoneId = await this._zoneId(domain);
    const name = String(domain || '').trim().toLowerCase().replace(/\.$/, '');
    const qs = new URLSearchParams({ per_page: '100', order: 'name', direction: 'asc' });
    if (name && !name.startsWith('*.')) qs.set('name', name);
    if (type) qs.set('type', String(type).toUpperCase());
    const res = await requestJson(`${this.base}/zones/${zoneId}/dns_records?${qs.toString()}`, {
      method: 'GET',
      headers: this._headers(),
    });
    if (res.status !== 200 || !res.data || !res.data.success) {
      throw new Error(cfError(res, `列出 ${name} 的 DNS 记录失败`));
    }
    let records = (res.data.result || []).map((r) => ({
      id: r.id,
      type: r.type,
      name: r.name,
      content: r.content,
      ttl: Number(r.ttl) || 0,
      proxied: !!r.proxied,
      proxiable: !!r.proxiable,
      modified: r.modified_on || '',
      created: r.created_on || '',
    }));
    /* 通配符：Cloudflare 的 API 用 name=*.x 过滤不生效，这里在本地按前缀筛一遍 */
    if (name.startsWith('*.')) {
      const apexName = name.slice(2);
      records = records.filter((r) => r.name === `*.${apexName}` || r.name === apexName);
    }
    return { zoneId, name, records };
  }

  async createRecord(domain, { type, name, content, ttl = 120, proxied = false }) {
    const zoneId = await this._zoneId(domain);
    const fullName = String(name || '').trim() || stripWildcard(domain);
    const body = {
      type: String(type || 'A').toUpperCase(),
      name: fullName,
      content: String(content || '').trim(),
      ttl: Number(ttl) || 120,
    };
    /* 只有 A/AAAA/CNAME 支持橙云代理，TXT 等传了会报错 */
    if (body.type !== 'TXT') body.proxied = !!proxied;
    const res = await requestJson(`${this.base}/zones/${zoneId}/dns_records`, {
      method: 'POST',
      headers: this._headers(),
      body,
    });
    if (res.status !== 200 || !res.data || !res.data.success) {
      throw new Error(cfError(res, `添加 ${body.type} 记录 ${fullName} 失败`));
    }
    const r = res.data.result;
    return { id: r.id, type: r.type, name: r.name, content: r.content, ttl: r.ttl, proxied: !!r.proxied };
  }

  async deleteRecord(domain, id) {
    if (!id) throw new Error('缺少记录 id');
    const zoneId = await this._zoneId(domain);
    const res = await requestJson(`${this.base}/zones/${zoneId}/dns_records/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: this._headers(),
    });
    if (res.status !== 200 || !res.data || !res.data.success) {
      throw new Error(cfError(res, '删除 DNS 记录失败'));
    }
    return { id };
  }
}

module.exports = {
  CloudflareDns,
  dns01Name,
  stripWildcard,
  apexOf,
};
