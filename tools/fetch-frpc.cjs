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
/* 固定校验和：锁定我们发布的 frpc.exe 到底来自哪份官方压缩包。
 * 有了它，走第三方镜像也是安全的（内容不对就换下一个源，绝不落盘），
 * 同时也能挡住「下载被截断但 HTTP 200」这类更隐蔽的坏包。 */
const ZIP_SHA256 = 'ab7ae0633df538b35d0490212eabfd6d3a0051e9e446ae0053c9f63921a8c46e';
const ZIP_SIZE = 12893922;
/* GitHub 的 release 资产走 objects.githubusercontent.com，偶发 502/超时；
 * v1.2.92、v1.2.94 两次发版都栽在「准备内置 frpc.exe」这一步。
 * 因此除了官方地址，再带几个公共镜像 —— 全部按上面的 sha256 校验。 */
const MIRROR_PREFIXES = ['https://ghfast.top/', 'https://ghproxy.net/', 'https://gh-proxy.com/'];

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'vendor', 'frpc');
const outFile = path.join(outDir, 'frpc.exe');
/* 仓库里自带一份官方压缩包（12.3 MB），打包时优先用它。
 *
 * 为什么不只靠下载：1.2.92 / 1.2.94 / 1.2.95 / 1.2.96 四次发版都卡在
 * 「准备内置 frpc.exe」这一步 —— GitHub 的 release 资产下载在 CI 上反复 502/超时，
 * 重试、镜像、curl 兜底都没能稳定解决。发版不该依赖对端的可用性，
 * 而 12 MB 的一次性体积换「永不失败」是划算的（安装包本身 88 MB）。
 * 没有这份 zip 时才走网络下载（下面那段保留着，仍带 sha256 校验）。 */
const BUNDLED_ZIP = path.join(root, 'vendor', 'frp-src', ZIP_NAME);
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

/* 解压 + 安装到 vendor/frpc/frpc.exe。两条来源（仓库自带 zip / 网络下载）都走这里，
 * 保证「压缩包对、解出来的文件被截断」这类问题只在一处处理。 */
function unpackAndInstall(work, zipPath) {
  log('解压…');
  const unpacked = path.join(work, 'unpacked');
  extract(zipPath, unpacked);
  const found = findFrpc(unpacked);
  if (!found) throw new Error(`压缩包里没找到 frpc.exe：${unpacked}`);

  fs.mkdirSync(outDir, { recursive: true });
  fs.copyFileSync(found, outFile);
  const exeSize = fs.statSync(outFile).size;
  if (exeSize < 10 * 1024 * 1024) throw new Error(`解压出的 frpc.exe 大小异常：${exeSize} 字节`);
  log(`完成：${path.relative(root, outFile)}（${(exeSize / 1024 / 1024).toFixed(1)} MB）`);

  try {
    fs.rmSync(work, { recursive: true, force: true });
  } catch {
    /* 临时目录清不掉不影响结果 */
  }
}

(async () => {
  if (exists(outFile) && !force) {
    log(`已存在，跳过：${path.relative(root, outFile)}（${(fs.statSync(outFile).size / 1024 / 1024).toFixed(1)} MB）`);
    return;
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'frpc-fetch-'));
  const zipPath = path.join(work, ZIP_NAME);

  /* 仓库自带压缩包优先：校验 sha256 后直接用，不碰网络。 */
  if (fs.existsSync(BUNDLED_ZIP)) {
    const digest = require('node:crypto').createHash('sha256').update(fs.readFileSync(BUNDLED_ZIP)).digest('hex');
    if (digest !== ZIP_SHA256) {
      throw new Error(`仓库自带的 ${path.relative(root, BUNDLED_ZIP)} 校验失败（${digest}），请重新放置官方压缩包`);
    }
    log(`使用仓库自带压缩包：${path.relative(root, BUNDLED_ZIP)}（sha256 校验通过）`);
    fs.copyFileSync(BUNDLED_ZIP, zipPath);
    unpackAndInstall(work, zipPath);
    return;
  }

  const urls = [
    URL_PRIMARY,
    MIRROR ? `${MIRROR.replace(/\/$/, '')}/${URL_PRIMARY}` : '',
    ...MIRROR_PREFIXES.map((prefix) => `${prefix}${URL_PRIMARY}`),
  ].filter(Boolean);

  let lastError = null;
  const sha256 = (file) => require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  /* 校验下载结果：大小 + sha256。任何一项不符都当作「这个源不能用」，
   * 换下一个（也正因为有它，走第三方镜像才是安全的）。 */
  const verifyZip = () => {
    const size = fs.statSync(zipPath).size;
    if (size !== ZIP_SIZE) return { ok: false, error: `大小不对：${size}（应为 ${ZIP_SIZE}）` };
    const digest = sha256(zipPath);
    if (digest !== ZIP_SHA256) return { ok: false, error: `sha256 不匹配：${digest}` };
    return { ok: true };
  };
  /* 每个地址最多试 5 次（3/6/9/12 秒退避）。CI 上偶发的 502/超时会让整次发版失败，
   * v1.2.92 / v1.2.94 / v1.2.95 都栽在「准备内置 frpc.exe」这一步。 */
  outer: for (const url of urls) {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        log(`下载 ${url}${attempt > 1 ? `（第 ${attempt} 次尝试）` : ''}`);
        await download(url, zipPath);
        const verdict = verifyZip();
        if (!verdict.ok) throw new Error(verdict.error);
        lastError = null;
        break outer;
      } catch (e) {
        lastError = e;
        log(`失败：${e.message}`);
        try {
          fs.rmSync(zipPath, { force: true });
        } catch {
          /* 删不掉也不影响下一个源覆盖写 */
        }
        if (attempt < 5) await new Promise((r) => setTimeout(r, Math.min(24, attempt * 3) * 1000));
      }
    }
  }

  /* 兜底：node 的 https 在 CI 上失败过很多次，但 runner 上的 curl 走的是另一套
   * 连接栈和重试逻辑，成功率明显更高。curl 拿到的文件同样要过 sha256。 */
  if (lastError) {
    log('node 下载全部失败，改用系统 curl 再试一轮');
    for (const url of urls) {
      for (const bin of ['curl.exe', 'curl']) {
        try {
          log(`curl 下载 ${url}`);
          execFileSync(bin, ['-fsSL', '--retry', '3', '--retry-delay', '3', '--max-time', '300', '-o', zipPath, url], {
            stdio: ['ignore', 'ignore', 'pipe'],
            timeout: 360000,
          });
          const verdict = verifyZip();
          if (!verdict.ok) throw new Error(verdict.error);
          lastError = null;
          break;
        } catch (e) {
          lastError = e;
          log(`curl 失败（${bin}）：${String((e && e.message) || e).slice(0, 200)}`);
          try {
            fs.rmSync(zipPath, { force: true });
          } catch {
            /* ignore */
          }
        }
      }
      if (!lastError) break;
    }
  }
  if (lastError) {
    // 失败时给出可操作的手工放置办法，和 README 的说明一致
    throw new Error(
      `下载 ${ZIP_NAME} 失败：${lastError.message}\n` +
      `可以手动下载后把 frpc.exe 放到 ${path.relative(root, outFile)}\n` +
      `或设置 FRP_DOWNLOAD_MIRROR=https://ghproxy.net/ 走代理`,
    );
  }

  log(`校验通过（sha256 ${ZIP_SHA256.slice(0, 12)}…，${(ZIP_SIZE / 1024 / 1024).toFixed(1)} MB）`);
  unpackAndInstall(work, zipPath);
})().catch((error) => {
  console.error(`[frpc] ${error.message}`);
  process.exit(1);
});
