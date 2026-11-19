'use strict';

const { execFile } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

function execFileP(file, args = [], options = {}) {
  const opts = {
    windowsHide: true,
    timeout: 20000,
    maxBuffer: 8 * 1024 * 1024,
    encoding: 'utf8',
    ...options,
  };
  return new Promise((resolve) => {
    try {
      execFile(file, args, opts, (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          signal: error && error.signal ? error.signal : null,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          message: error ? String(error.message || '').split('\n')[0] : '',
          file,
          args,
        });
      });
    } catch (e) {
      /* spawn 一个不可执行的文件（frpc.exe 被换成文本、被杀软隔离、路径其实是个目录）时，
       * Windows 会在 uv_spawn 里同步抛 `spawn UNKNOWN`，Promise 执行器里的同步异常
       * 会变成 reject —— 以前一路冒到 IPC，界面点“保存”毫无反应。这里一律收敛成结果对象。 */
      resolve({ ok: false, code: 1, signal: null, stdout: '', stderr: '', message: String((e && e.message) || e).split('\n')[0], file, args });
    }
  });
}

function powershell(script, options = {}) {
  /* 用 -EncodedCommand 传脚本，而不是 -Command。
   * execFile 在 Windows 上要把参数拼成一条命令行交给 CreateProcess，
   * 脚本里一旦出现 " { } | $ 这类字符（Get-Process ... ForEach-Object { "$($_.Id)=..." }）
   * 就会被二次解析，表现为“命令失败”且没有任何输出。
   * Base64(UTF-16LE) 之后命令行里只剩字母数字，彻底没有转义问题。
   *
   * 输出编码固定成 UTF-8：PowerShell 默认按控制台代码页（中文系统是 GBK）写 stdout，
   * 而 execFile 这边按 utf8 解码，中文错误信息会变成一堆问号/乱码——
   * 报错原文读不出来就没法判断是「没权限」还是「路径不对」。 */
  const prefix = [
    '$ProgressPreference = "SilentlyContinue"',
    'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }',
  ].join('\r\n');
  const encoded = Buffer.from(`${prefix}\r\n${String(script || '')}`, 'utf16le').toString('base64');
  return execFileP(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { timeout: 60000, ...options },
  );
}

/* 端口/主机先自己校验一遍，永不抛。
 * net.connect({ port: NaN }) 会同步抛 ERR_SOCKET_BAD_PORT，抛出点在 Promise
 * 执行器内 → 变成 reject。stcp/xtcp 这类代理没有 remotePort，
 * Number(undefined) 就是 NaN，于是整轮 Promise.all 直接 reject，
 * 健康检查从此不再更新，界面会一直停在“全部在线”。 */
function tcpCheck(host, port, timeout = 2500) {
  const target = String(host || '').trim();
  const num = Number(port);
  if (!target) return Promise.resolve({ ok: false, ms: 0, error: '主机为空' });
  if (!Number.isInteger(num) || num < 1 || num > 65535) {
    return Promise.resolve({ ok: false, ms: 0, error: `端口无效（${port === undefined || port === null ? '空' : String(port)}）` });
  }
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    let socket;
    try {
      socket = net.connect({ host: target, port: num });
    } catch (err) {
      resolve({ ok: false, ms: 0, error: err.code || err.message || 'unknown' });
      return;
    }
    const finish = (ok, error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, ms: Date.now() - started, error: ok ? null : error || 'unknown' });
    };
    socket.setTimeout(Math.max(300, timeout));
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false, 'timeout'));
    socket.once('error', (err) => finish(false, err.code || err.message));
  });
}

/* 探测一个 HTTP 地址。
 * 用 node:http(s) 而不是 fetch：fetch（undici）会无视调用方传的 Host 头，
 * 一律按 URL 里的主机名发请求 —— 而探测 frps 的 vhost 恰恰需要
 * “连 127.0.0.1:vhostPort、Host 写绑定域名”，否则永远匹配不到代理，
 * 返回的是 frps 自己的 404 页面。 */
function httpProbe(url, timeout = 6000, extraHeaders = null, tlsOptions = null) {
  const started = Date.now();
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return Promise.resolve({ ok: false, status: 0, ms: 0, error: 'URL 无效' });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return Promise.resolve({ ok: false, status: 0, ms: 0, error: '仅支持 HTTP/HTTPS' });
  }
  const transport = parsed.protocol === 'https:' ? require('node:https') : require('node:http');
  const headers = { 'User-Agent': 'frp-console/1.0', ...(extraHeaders || {}) };
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let req;
    try {
      const requestOptions = {
        protocol: parsed.protocol,
        host: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: `${parsed.pathname || '/'}${parsed.search || ''}`,
        method: 'GET',
        headers,
        timeout,
      };
      // 探测 https 时允许“连 IP、SNI 填域名、不校验证书”——健康检查只关心
      // 流量有没有被 frps 按域名路由过去，证书是否可信不影响“隧道通不通”。
      if (parsed.protocol === 'https:' && tlsOptions) {
        if (tlsOptions.servername) requestOptions.servername = tlsOptions.servername;
        if (typeof tlsOptions.rejectUnauthorized === 'boolean') requestOptions.rejectUnauthorized = tlsOptions.rejectUnauthorized;
      }
      req = transport.request(
        requestOptions,
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            if (body.length < 64 * 1024) body += chunk;
          });
          res.on('end', () => {
            const status = res.statusCode || 0;
            const titleMatch = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
            /* frps 在没有匹配到任何代理时会返回自己的 404 页面。
             * 那种页面看着“HTTP 通了”，其实隧道根本没转发，必须算失败。 */
            const frpsMiss = status === 404 && /<?!?DOCTYPE html/i.test(body) && /<title>Not Found<\/title>/i.test(body);
            /* 云厂商的备案拦截页：阿里云在 80/8080 上对「未在其备案的域名」直接返回
             * 403 + 备案提示页（Server: Beaver，标题 Non-compliance ICP Filing）。
             * 这种响应看着是 HTTP 200/403 的“正常网页”，其实请求根本没到 frps，
             * 以前会被当成「公网可达」——假绿。 */
            const serverHeader = String(res.headers['server'] || '');
            const icpBlocked = status === 403 && (/Non-compliance ICP Filing/i.test(body) || /beaver/i.test(serverHeader));
            done({
              ok: status > 0 && status < 500 && !frpsMiss && !icpBlocked,
              status,
              ms: Date.now() - started,
              title: titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim().slice(0, 120) : '',
              finalUrl: url,
              contentType: String(res.headers['content-type'] || ''),
              blocked: icpBlocked ? 'icp' : null,
              error: frpsMiss
                ? 'frps 上没有匹配到该域名（代理未注册或域名不一致）'
                : (icpBlocked ? '域名未备案，被云厂商在 HTTP 端口上拦截（返回的是备案提示页）' : null),
            });
          });
        },
      );
    } catch (err) {
      done({ ok: false, status: 0, ms: Date.now() - started, error: err.code || err.message });
      return;
    }
    req.on('timeout', () => {
      req.destroy();
      done({ ok: false, status: 0, ms: Date.now() - started, error: '请求超时' });
    });
    req.on('error', (err) => {
      done({ ok: false, status: 0, ms: Date.now() - started, error: err.code || err.message });
    });
    req.end();
  });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function hashText(text) {
  return crypto.createHash('sha1').update(text).digest('hex');
}

/* 生成 auth.token / 面板密码这类“机器自己配对用”的密钥。
 * 只用小写字母数字：避免 0/O、1/l/I 在需要人工抄写时看错。 */
function randomToken(length = 24) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const size = Math.min(64, Math.max(8, Number(length) || 24));
  const bytes = crypto.randomBytes(size);
  let out = '';
  for (let i = 0; i < size; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function formatDuration(ms) {
  if (!ms || ms < 0) return '0 秒';
  const sec = Math.floor(ms / 1000);
  const day = Math.floor(sec / 86400);
  const hour = Math.floor((sec % 86400) / 3600);
  const min = Math.floor((sec % 3600) / 60);
  if (day > 0) return `${day} 天 ${hour} 小时`;
  if (hour > 0) return `${hour} 小时 ${min} 分`;
  if (min > 0) return `${min} 分 ${sec % 60} 秒`;
  return `${sec} 秒`;
}

function parseTimestamp(text) {
  const m = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{3})?)/.exec(text || '');
  if (!m) return null;
  const t = new Date(m[1].replace(' ', 'T'));
  return Number.isNaN(t.getTime()) ? null : t.getTime();
}

function logLevelOf(text) {
  const m = /\[(D|I|W|E)\]/i.exec(text || '');
  if (!m) {
    if (/^frpc:|panic|fatal|invalid|syntax/i.test(text || '')) return 'error';
    return 'info';
  }
  return { D: 'debug', I: 'info', W: 'warn', E: 'error' }[m[1].toUpperCase()] || 'info';
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/* 进程环境里实际存在的代理变量（大小写都算），用于在设置页说明「不继承系统代理」这个开关
 * 现在到底有没有意义——Windows 的「系统代理」只写注册表，不会设置这些变量，
 * 所以大多数机器上它本来就不起作用，界面上应该讲明白，而不是让用户对着一个哑开关猜。
 * 注意：这些变量只影响「应用托管进程」模式下拉起的 frpc。 */
const PROXY_ENV_NAMES = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'FTP_PROXY', 'NO_PROXY'];
function proxyEnvKeys(env = process.env) {
  const found = [];
  for (const base of PROXY_ENV_NAMES) {
    for (const key of [base, base.toLowerCase()]) {
      const v = env && env[key];
      if (typeof v === 'string' && v.trim()) found.push(key);
    }
  }
  return found;
}

module.exports = {
  execFileP,
  powershell,
  tcpCheck,
  httpProbe,
  readJson,
  writeJsonAtomic,
  hashText,
  randomToken,
  formatDuration,
  parseTimestamp,
  logLevelOf,
  ensureDir,
  proxyEnvKeys,
};
