'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/* SSH 主机密钥固定（TOFU：首次信任，之后比对）。
 *
 * 之前 connect() 没传 hostHash/hostVerifier，SSH 就算「主机密钥变了」也照连——
 * 而本程序要用户交 root 密码，一旦 22 端口被劫持（同网段 ARP 欺骗、DNS 投毒、
 * 恶意热点），密码和后续所有下发命令都会落到对方手里。
 *
 * 策略：
 *  - 第一次见到某台机器 → 记下指纹，照常连（否则每台新机器都要手动确认）。
 *  - 之后指纹必须一致；不一致就拒绝连接并把两个指纹都给用户看。
 *    （换系统/换机器/换 host key 属于正常情况，用户在界面上确认后才能信任新指纹。）
 */

/** 把一个主机公钥算成 OpenSSH 风格的指纹：SHA256:base64（去掉 = 补位）。 */
function fingerprintOf(key) {
  if (!key || !key.length) return '';
  const digest = crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
  return `SHA256:${digest}`;
}

/** host:port → 固定的键（端口 22 也写出来，避免 22/2222 混在一起）。 */
function targetKey(host, port = 22) {
  return `${String(host || '').trim().toLowerCase()}:${Number(port) || 22}`;
}

class KnownHosts {
  constructor(file, { allowNew = true } = {}) {
    this.file = file;
    this.allowNew = allowNew;
    this.map = this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const hosts = raw && typeof raw.hosts === 'object' && raw.hosts ? raw.hosts : {};
      const out = {};
      for (const [k, v] of Object.entries(hosts)) {
        if (typeof v === 'string' && v.startsWith('SHA256:')) out[k] = v;
      }
      return out;
    } catch {
      return {};
    }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const body = JSON.stringify({ v: 1, hosts: this.map }, null, 2);
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, body, 'utf8');
      fs.renameSync(tmp, this.file);
    } catch {
      /* 存不下来只影响下次比对，不影响本次连接 */
    }
  }

  /** 只读比对，不落盘：known / new / changed。 */
  check(host, port, key) {
    const target = targetKey(host, port);
    const fp = fingerprintOf(key);
    const previous = this.map[target] || '';
    if (!fp) return { status: 'unknown', target, fingerprint: '', previous };
    if (!previous) return { status: 'new', target, fingerprint: fp, previous: '' };
    if (previous === fp) return { status: 'known', target, fingerprint: fp, previous };
    return { status: 'changed', target, fingerprint: fp, previous };
  }

  /** 记下/覆盖指纹（首次信任或用户确认新指纹时调用）。 */
  trust(host, port, fingerprint) {
    const target = targetKey(host, port);
    if (!fingerprint) return false;
    this.map[target] = fingerprint;
    this._save();
    return true;
  }

  forget(host, port) {
    const target = targetKey(host, port);
    delete this.map[target];
    this._save();
  }

  list() {
    return Object.entries(this.map).map(([target, fingerprint]) => ({ target, fingerprint }));
  }
}

module.exports = { KnownHosts, fingerprintOf, targetKey };
