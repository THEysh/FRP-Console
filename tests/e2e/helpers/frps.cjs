'use strict';
/* 测试用的 frps / 本地服务。
 *
 * frps 二进制不入库（18 MB，由 tools/fetch-frpc.cjs 现取现用），所以这里按
 * 环境变量 → vendor → .e2e 实验区的顺序找；找不到就返回 null，让需要隧道的
 * 场景标记为「跳过」而不是失败——CI 上不下载二进制也能跑其余场景。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function findFrps() {
  const candidates = [process.env.FRP_E2E_FRPS, path.join(ROOT, 'vendor', 'frps', 'frps.exe'), path.join(ROOT, 'resources', 'frps', 'frps.exe')];
  const labDir = path.join(ROOT, '.e2e', 'lab', 'frp');
  try {
    for (const name of fs.readdirSync(labDir)) {
      if (!name.includes('windows')) continue;
      candidates.push(path.join(labDir, name, 'frps.exe'));
    }
  } catch {
    /* 没有实验区 */
  }
  return candidates.filter(Boolean).find((p) => {
    try {
      return fs.statSync(p).size > 1000000;
    } catch {
      return false;
    }
  }) || '';
}

function waitPort(port, host = '127.0.0.1', timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const socket = net.connect({ host, port: Number(port) });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) resolve(false);
        else setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

async function startFrps({ dir, bindPort = 17000, dashPort = 17500, token = 'e2e-token-1234567890', vhostHttpPort, vhostHttpsPort }) {
  const bin = findFrps();
  if (!bin) return null;
  fs.mkdirSync(dir, { recursive: true });
  const configPath = path.join(dir, 'frps.toml');
  fs.writeFileSync(
    configPath,
    [
      /* TOML 的顺序很要紧：一旦出现 [xxx] 表，后面所有的裸键都归到那张表里。
       * 第一次写成「[webServer] 之后再写 vhostHTTPPort」，frps 直接拒绝启动——
       * 表现出来的却是「端口没监听」，很难第一时间想到是配置顺序。 */
      'bindAddr = "127.0.0.1"',
      `bindPort = ${bindPort}`,
      `vhostHTTPPort = ${vhostHttpPort || bindPort + 1000}`,
      /* 没有 vhostHTTPSPort 时 frps 会拒绝 https 代理（type [https] not supported…），
       * 「同一域名 http+https」这类用例就没法测，所以这里一并开上。 */
      /* 两台 frps 的端口只差 1 时，+1000/+1001 会互相撞（vhostHTTP 撞上另一台的 vhostHTTPS），
       * 所以 https 用 +2000，并且允许调用方显式指定。 */
      `vhostHTTPSPort = ${vhostHttpsPort || bindPort + 2000}`,
      '',
      '[auth]',
      'method = "token"',
      `token = "${token}"`,
      '',
      '[webServer]',
      'addr = "127.0.0.1"',
      `port = ${dashPort}`,
      'user = "admin"',
      'password = "e2e-pass"',
      '',
    ].join('\n'),
    'utf8',
  );
  const child = spawn(bin, ['-c', configPath], { cwd: dir, detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  const ready = await waitPort(bindPort);
  if (!ready) {
    try {
      process.kill(child.pid);
    } catch {
      /* ignore */
    }
    return null;
  }
  return {
    bin,
    configPath,
    bindPort,
    dashPort,
    token,
    stop() {
      if (!child.pid) return;
      try {
        process.kill(child.pid, 'SIGKILL');
      } catch {
        /* ignore */
      }
    },
  };
}

/* 两个本地服务：正常页（第一层该通）与「根路径 404、/panel/ 才 200」的服务
 * （用来验证「访问路径」和「路径 404」这两条判定）。 */
function startLocalServers() {
  const http = require('node:http');
  const server = http.createServer((req, res) => {
    if (req.url === '/panel/' || req.url === '/panel') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>panel-ok</title><p>panel-ok</p>');
      return;
    }
    if (req.url === '/' || req.url === '') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>hello-e2e</title><p>hello-e2e</p>');
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 page not found');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        stop() {
          try {
            server.close();
          } catch {
            /* ignore */
          }
        },
      });
    });
  });
}

module.exports = { findFrps, startFrps, startLocalServers, waitPort };
