'use strict';
/*
 * 按需拿到 linux 版 frps 二进制。
 *
 * 以前把 amd64 / arm64 两份 frps（合计 36 MB）直接打进安装包，安装包大到 94 MB，
 * 而绝大多数人只会用到其中一份、甚至根本不用「一键初始化」。
 * 现在改成用到时才下载，并且按服务器架构只取需要的那份：
 *
 *   1. 先看缓存（用户数据目录/frps-cache）
 *   2. 再看程序目录下的 resources/frps/linux-<arch>/frps（开发模式、便携版，
 *      以及网络不通时用户手动放一份进来的情况）
 *   3. 都没有才从 GitHub Releases 下载 frp_<ver>_linux_<arch>.tar.gz 并解压
 *
 * 下载依赖只有 Node 自带的 https / zlib：不引入第三方包，也不需要外部 tar。
 */

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const zlib = require('node:zlib');
const { app } = require('electron');
const { ensureDir } = require('./util');

/* 与 README 里写明的 frp 版本保持一致；换版本时这里和文档一起改。 */
const FRP_VERSION = '0.61.0';
const MAX_REDIRECTS = 5;

function releaseUrl(arch) {
  const base = `https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_linux_${arch}.tar.gz`;
  // 可选镜像前缀（例如 https://ghproxy.net/），给连不上 GitHub 的人留个口子，
  // 但默认不内置任何第三方代理，避免把流量交给来路不明的服务。
  const mirror = String(process.env.FRP_DOWNLOAD_MIRROR || '').trim();
  return mirror ? `${mirror.replace(/\/+$/, '')}/${base}` : base;
}

function cacheDir(arch) {
  return path.join(app.getPath('userData'), 'frps-cache', `frp_${FRP_VERSION}_linux_${arch}`);
}

/* 允许手动放二进制的位置，从近到远。 */
function localCandidates(arch) {
  const rel = path.join('resources', 'frps', `linux-${arch}`, 'frps');
  const list = [path.join(cacheDir(arch), 'frps')];
  if (app.isPackaged) list.push(path.join(process.resourcesPath, 'frps', `linux-${arch}`, 'frps'));
  try { list.push(path.join(app.getAppPath(), rel)); } catch { /* app 尚未 ready */ }
  list.push(path.join(path.dirname(process.execPath), rel));
  return list;
}

function isUsableFile(file) {
  try {
    const st = fs.statSync(file);
    return st.isFile() && st.size > 1024 * 1024; // frps 约 18 MB，太小的多半是下载残留
  } catch {
    return false;
  }
}

function request(url, redirectsLeft, onResponse) {
  const req = https.get(url, { headers: { 'User-Agent': 'FRP-Console' } }, (res) => {
    try {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) {
          onResponse(null, new Error('重定向次数过多'));
          return;
        }
        // GitHub Releases 会先 302 到 objects.githubusercontent.com。
        request(new URL(res.headers.location, url).toString(), redirectsLeft - 1, onResponse);
        return;
      }
      onResponse(res);
    } catch (err) {
      onResponse(null, err);
    }
  });
  req.setTimeout(30000, () => req.destroy(new Error('连接 GitHub 超时')));
  req.on('error', (err) => onResponse(null, err));
  return req;
}

function download(url, destFile, onProgress) {
  return new Promise((resolve) => {
    const chunks = [];
    request(url, MAX_REDIRECTS, (res, err) => {
      if (err) return resolve({ ok: false, error: err.message || String(err) });
      if (!res || res.statusCode !== 200) {
        if (res) res.resume();
        return resolve({ ok: false, error: `下载失败（HTTP ${res ? res.statusCode : '无响应'}）` });
      }
      const total = Number(res.headers['content-length']) || 0;
      let received = 0;
      let lastAt = 0;
      res.on('data', (buf) => {
        chunks.push(buf);
        received += buf.length;
        const now = Date.now();
        if (onProgress && now - lastAt > 200) {
          lastAt = now;
          onProgress(received, total);
        }
      });
      res.on('end', () => {
        const data = Buffer.concat(chunks);
        if (total && data.length !== total) {
          return resolve({ ok: false, error: `下载不完整（${data.length}/${total} 字节）` });
        }
        try {
          fs.writeFileSync(destFile, data);
        } catch (e) {
          return resolve({ ok: false, error: `写入临时文件失败：${e.message}` });
        }
        resolve({ ok: true, size: data.length });
      });
      res.on('error', (e) => resolve({ ok: false, error: e.message || String(e) }));
    });
  });
}

/* 极简 tar 读取：只找名为 frps 的那个成员，够用且没有任何依赖。 */
function extractFromTarGz(buffer) {
  let tar;
  try {
    tar = zlib.gunzipSync(buffer);
  } catch (e) {
    return { ok: false, error: `解压失败：${e.message}` };
  }
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0[\s\S]*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0[\s\S]*$/, '');
    const full = prefix ? `${prefix}/${name}` : name;
    const sizeText = header.subarray(124, 136).toString('utf8').replace(/\0[\s\S]*$/, '').trim();
    const size = parseInt(sizeText, 8) || 0;
    const type = String.fromCharCode(header[156] || 48);
    const dataStart = offset + 512;
    if ((type === '0' || type === '\0' || type === '') && path.posix.basename(full) === 'frps') {
      const data = tar.subarray(dataStart, dataStart + size);
      if (data.length !== size) return { ok: false, error: '压缩包结构异常' };
      return { ok: true, data };
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return { ok: false, error: '压缩包里没有找到 frps' };
}

function manualHint(arch) {
  return `可手动下载 frp_${FRP_VERSION}_linux_${arch}.tar.gz 解压，把 frps 放到：${cacheDir(arch)}`;
}

/**
 * 拿到可上传的 frps 二进制路径。
 * @param {'amd64'|'arm64'} arch 已归一化的服务器架构
 * @param {{ onProgress?: (p:{text:string, percent:number})=>void }} options
 */
async function ensure(arch, options = {}) {
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  if (!arch || !['amd64', 'arm64'].includes(arch)) {
    return { ok: false, error: `暂不支持服务器架构 ${arch || 'unknown'}，仅支持 amd64 / arm64` };
  }

  for (const file of localCandidates(arch)) {
    if (isUsableFile(file)) return { ok: true, path: file, source: 'local' };
  }

  const dir = cacheDir(arch);
  if (!ensureDir(dir)) return { ok: false, error: `无法创建缓存目录：${dir}` };

  const url = releaseUrl(arch);
  const tmp = path.join(dir, `frp_${FRP_VERSION}_linux_${arch}.tar.gz`);
  const report = (text, percent) => { if (onProgress) { try { onProgress({ text, percent }); } catch { /* 窗口已关 */ } } };

  report(`下载 frps（${arch}，约 18 MB）`, 1);
  const got = await download(url, tmp, (received, total) => {
    const mb = (received / 1048576).toFixed(1);
    const totalMb = total ? (total / 1048576).toFixed(1) : '?';
    // 下载占进度条最前面的一段（1 → 8），后面上传才是大头（12 → 60）。
    const percent = total ? 1 + Math.round((received / total) * 7) : 4;
    report(`下载 frps ${mb} / ${totalMb} MB`, Math.min(8, percent));
  });
  if (!got.ok) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    return { ok: false, error: `下载 frps 失败：${got.error}。${manualHint(arch)}` };
  }

  let raw;
  try {
    raw = fs.readFileSync(tmp);
  } catch (e) {
    return { ok: false, error: `读取下载文件失败：${e.message}` };
  }
  const extracted = extractFromTarGz(raw);
  try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  if (!extracted.ok) return { ok: false, error: `${extracted.error}。${manualHint(arch)}` };

  const target = path.join(dir, 'frps');
  try {
    fs.writeFileSync(target, extracted.data);
  } catch (e) {
    return { ok: false, error: `写入 ${target} 失败：${e.message}` };
  }
  return { ok: true, path: target, source: 'download' };
}

module.exports = { FRP_VERSION, ensure, cacheDir, releaseUrl };
