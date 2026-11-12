'use strict';

const { execFile } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

function execFileP(file, args = [], options = {}) {
  return new Promise((resolve) => {
    const opts = {
      windowsHide: true,
      timeout: 20000,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
      ...options,
    };
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
  });
}

function powershell(script, options = {}) {
  return execFileP(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeout: 60000, ...options },
  );
}

function tcpCheck(host, port, timeout = 2500) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const socket = net.connect({ host, port: Number(port) });
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

async function httpProbe(url, timeout = 6000) {
  const started = Date.now();
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, status: 0, ms: 0, error: 'URL 无效' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, status: 0, ms: 0, error: '仅支持 HTTP/HTTPS' };
  }
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeout),
      headers: { 'User-Agent': 'frp-console/1.0' },
    });
    const buffer = await res.arrayBuffer();
    const text = Buffer.from(buffer).toString('utf8');
    const titleMatch = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return {
      ok: res.status < 500,
      status: res.status,
      ms: Date.now() - started,
      title: titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim().slice(0, 120) : '',
      finalUrl: res.url,
      contentType: res.headers.get('content-type') || '',
    };
  } catch (err) {
    const code = err && err.cause && (err.cause.code || err.cause.message);
    return {
      ok: false,
      status: 0,
      ms: Date.now() - started,
      error: err.name === 'TimeoutError' || err.name === 'AbortError' ? '请求超时' : code || err.message,
    };
  }
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

module.exports = {
  execFileP,
  powershell,
  tcpCheck,
  httpProbe,
  readJson,
  writeJsonAtomic,
  hashText,
  formatDuration,
  parseTimestamp,
  logLevelOf,
  ensureDir,
};
