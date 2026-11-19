'use strict';

/*
 * 打包前把 frpc.exe 取到 vendor/frpc/，由 electron-builder 的 extraResources
 * 打进安装包（安装后位于 <安装目录>\resources\frpc\frpc.exe）。
 *
 * 为什么不直接把 exe 提交进仓库：单个文件 18 MB，进 git 就永久留在历史里。
 * 这里按需下载并缓存，CI 和本地打包都走同一条路径。
 *
 * 版本必须和 README 里写的 frp 版本、以及 resources/frps 的版本保持一致。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const { execFileSync } = require('node:child_process');

const FRP_VERSION = '0.61.0';
const ZIP_NAME = `frp_${FRP_VERSION}_windows_amd64.zip`;
const MIRROR = (process.env.FRP_DOWNLOAD_MIRROR || '').trim();
const URL_PRIMARY = `https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/${ZIP_NAME}`;

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'vendor', 'frpc');
const outFile = path.join(outDir, 'frpc.exe');
const force = process.argv.includes('--force');

function exists(file) {
  try {
    return fs.statSync(file).isFile() && fs.statSync(file).size > 1024 * 1024;
  } catch {
    return false;
  }
}

function log(message) {
  console.log(`[frpc] ${message}`);
}

function download(url, target, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('重定向次数过多'));
    const request = https.get(url, { timeout: 60000 }, (response) => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        const next = new URL(response.headers.location, url).toString();
        return download(next, target, redirects + 1).then(resolve, reject);
      }
      if (status !== 200) {
        response.resume();
        return reject(new Error(`HTTP ${status}：${url}`));
      }
      const total = Number(response.headers['content-length'] || 0);
      let received = 0;
      let lastPrint = 0;
      const file = fs.createWriteStream(target);
      response.on('data', (chunk) => {
        received += chunk.length;
        if (total && Date.now() - lastPrint > 800) {
          lastPrint = Date.now();
          log(`下载 ${(received / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB`);
        }
      });
      response.pipe(file);
      file.on('finish', () => file.close(() => resolve(target)));
      file.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('下载超时')));
    request.on('error', reject);
  });
}

/* 解压 zip。优先用 PowerShell 的 Expand-Archive：Windows 10 起必定存在，
 * 而且不会踩到「Git Bash 里的 GNU tar 把 C:\… 当成远程主机名」这个坑。
 * tar（bsdtar）留作兜底，供 PowerShell 被策略禁用的环境使用。 */
function extract(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  try {
    execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`,
    ], { stdio: 'inherit' });
    return;
  } catch (e) {
    log(`PowerShell 解压失败（${e.message}），改用 tar`);
  }
  execFileSync('tar', ['--force-local', '-xf', zipPath, '-C', destDir], { stdio: 'inherit' });
}

function findFrpc(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findFrpc(full);
      if (hit) return hit;
    } else if (entry.name.toLowerCase() === 'frpc.exe') {
      return full;
    }
  }
  return '';
}

(async () => {
  if (exists(outFile) && !force) {
    log(`已存在，跳过：${path.relative(root, outFile)}（${(fs.statSync(outFile).size / 1024 / 1024).toFixed(1)} MB）`);
    return;
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'frpc-fetch-'));
  const zipPath = path.join(work, ZIP_NAME);
  const urls = [URL_PRIMARY, MIRROR ? `${MIRROR.replace(/\/$/, '')}/${URL_PRIMARY}` : ''].filter(Boolean);

  let lastError = null;
  /* 每个地址重试 3 次（1s/3s 退避）：CI 上偶发的 502/超时会让整次发版失败，
   * v1.2.92 就因此栽在「准备内置 frpc.exe」这一步，重跑一次就好了。 */
  for (const url of urls) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        log(`下载 ${url}${attempt > 1 ? `（第 ${attempt} 次重试）` : ''}`);
        await download(url, zipPath);
        lastError = null;
        break;
      } catch (e) {
        lastError = e;
        log(`失败：${e.message}`);
        if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 2000));
      }
    }
    if (!lastError) break;
  }
  if (lastError) {
    // 失败时给出可操作的手工放置办法，和 README 的说明一致
    throw new Error(
      `下载 ${ZIP_NAME} 失败：${lastError.message}\n` +
      `可以手动下载后把 frpc.exe 放到 ${path.relative(root, outFile)}\n` +
      `或设置 FRP_DOWNLOAD_MIRROR=https://ghproxy.net/ 走代理`,
    );
  }

  log('解压…');
  const unpacked = path.join(work, 'unpacked');
  extract(zipPath, unpacked);
  const found = findFrpc(unpacked);
  if (!found) throw new Error(`压缩包里没找到 frpc.exe：${unpacked}`);

  fs.mkdirSync(outDir, { recursive: true });
  fs.copyFileSync(found, outFile);
  log(`完成：${path.relative(root, outFile)}（${(fs.statSync(outFile).size / 1024 / 1024).toFixed(1)} MB）`);

  try {
    fs.rmSync(work, { recursive: true, force: true });
  } catch {
    /* 临时目录清不掉不影响结果 */
  }
})().catch((error) => {
  console.error(`[frpc] ${error.message}`);
  process.exit(1);
});
