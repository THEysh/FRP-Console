'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { tcpCheck } = require('./util');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* 这些环境变量会让 frpc 把到 frps 的 TCP 握手交给 HTTP 代理去做，
 * 而绝大多数代理只代理 HTTP(S)，于是报 `DialTcpByHttpProxy error, StatusCode [502]`，
 * 表现为“连不上服务器”但端口、Token 都正常。控制台默认把它们摘掉。 */
const PROXY_ENV_KEYS = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'FTP_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'ftp_proxy', 'no_proxy',
];

function childEnv(settings) {
  const inherit = !settings || settings.stripProxyEnv === false;
  if (inherit) return process.env;
  const env = { ...process.env };
  for (const key of PROXY_ENV_KEYS) delete env[key];
  return env;
}

class FrpcManager extends EventEmitter {
  constructor(ctx) {
    super();
    this.ctx = ctx;
    this.child = null;
    this.childPid = null;
    this.childStartedAt = null;
    this.lastExit = null;
    this.stdoutTail = '';
    this.stderrTail = '';
    this.apiOk = false;
    this.apiError = null;
    this.apiData = null;
    this.stopping = false;
    this.proxyStatus = new Map();
    this.serviceState = { installed: false, state: 'unknown' };
    this.connectedAt = null;
    this.lastRefreshAt = 0;
    this.refreshing = null;
  }

  get settings() {
    return this.ctx.getSettings();
  }

  get paths() {
    return this.ctx.getPaths();
  }

  get config() {
    return this.ctx.getConfig();
  }

  get admin() {
    const cfg = this.config;
    const ws = cfg && cfg.webServer;
    const settings = this.settings;
    return {
      port: (ws && Number(ws.port)) || Number(settings.adminPort) || 7400,
      user: (ws && ws.user) || settings.adminUser || 'admin',
      password: (ws && ws.password) || settings.adminPassword || 'admin',
    };
  }

  get isChildAlive() {
    return !!(this.child && this.child.exitCode === null && !this.child.killed);
  }

  origin() {
    return `http://127.0.0.1:${this.admin.port}`;
  }

  authHeader() {
    return 'Basic ' + Buffer.from(`${this.admin.user}:${this.admin.password}`).toString('base64');
  }

  async api(pathname, { method = 'GET', timeout = 2200 } = {}) {
    const res = await fetch(this.origin() + pathname, {
      method,
      headers: { Authorization: this.authHeader() },
      signal: AbortSignal.timeout(timeout),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}${text ? ' ' + text.slice(0, 120) : ''}`);
    return { status: res.status, text };
  }

  setServiceState(state) {
    this.serviceState = state || { installed: false, state: 'unknown' };
  }

  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const previousOk = this.apiOk;
      let apiData = null;
      try {
        const r = await this.api('/api/status', { timeout: 1800 });
        apiData = JSON.parse(r.text || '{}');
        this.apiOk = true;
        this.apiError = null;
        if (!previousOk) this.connectedAt = Date.now();
      } catch (e) {
        this.apiOk = false;
        this.apiError = this.describeApiError(e);
        if (previousOk) this.connectedAt = null;
      }
      this.apiData = apiData;
      this.proxyStatus = new Map();
      if (apiData && typeof apiData === 'object') {
        for (const [type, list] of Object.entries(apiData)) {
          if (!Array.isArray(list)) continue;
          for (const item of list) {
            if (item && item.name) this.proxyStatus.set(item.name, { ...item, type: item.type || type });
          }
        }
      }
      this.lastRefreshAt = Date.now();
      return this.snapshot();
    })();
    try {
      return await this.refreshing;
    } finally {
      this.refreshing = null;
    }
  }

  describeApiError(error) {
    const message = String((error && error.message) || error || '');
    // Node 的 fetch 只会抛一句 “fetch failed”，真正的原因（ECONNREFUSED 等）藏在 cause 里。
    const cause = error && error.cause ? String(error.cause.code || error.cause.message || '') : '';
    const text = `${message} ${cause}`.trim();
    if (/401|403/.test(text)) return '管理 API 认证失败，请检查 webServer.user / password';
    if (/ECONNREFUSED|fetch failed|ENOTFOUND|EAI_AGAIN|connect/i.test(text)) return '管理 API 未启动';
    if (/timeout|aborted/i.test(text)) return '管理 API 响应超时';
    return message || '无法连接管理 API';
  }

  runtimeMode() {
    if (this.isChildAlive) {
      return this.apiOk ? 'managed' : 'starting';
    }
    if (this.serviceState && this.serviceState.installed && this.serviceState.state === 'running') {
      return this.apiOk ? 'service' : 'starting';
    }
    if (this.apiOk) return 'external';
    return 'stopped';
  }

  snapshot() {
    const serviceRunning = !!(this.serviceState && this.serviceState.installed && this.serviceState.state === 'running');
    return {
      mode: this.runtimeMode(),
      // running 指“frpc 进程或服务在跑”，connected 指“本机管理 API 有响应”。
      // 两者不再混为一谈：frpc 连不上 frps 时 api 仍然能有响应，但隧道其实没通。
      running: this.isChildAlive || serviceRunning || this.apiOk,
      connected: this.apiOk,
      adminPort: this.admin.port,
      apiError: this.apiError,
      pid: this.isChildAlive ? this.child.pid : serviceRunning ? this.serviceState.pid : null,
      since: this.connectedAt,
      childStartedAt: this.childStartedAt,
      service: this.serviceState,
      proxies: [...this.proxyStatus.values()],
      lastRefreshAt: this.lastRefreshAt,
      lastExit: this.lastExit,
    };
  }

  async ensureAdminConfig() {
    return this.ctx.ensureAdminConfig();
  }

  async start({ runMode = 'auto' } = {}) {
    if (this.apiOk) return { ok: true, already: true };
    const service = this.serviceState || {};
    const useService = runMode === 'service' || (runMode === 'auto' && service.installed);
    if (useService) {
      if (!service.installed) return { ok: false, error: '未检测到 FRP 系统服务，请改用应用托管模式' };
      const result = await this.ctx.startService();
      if (!result.ok) return result;
      const up = await this.waitForApi(20000);
      return up.ok ? { ok: true, mode: 'service' } : { ok: false, error: up.error || '服务已启动，但管理 API 尚未就绪' };
    }
    if (service.installed && service.state === 'running') {
      return { ok: false, error: '系统服务正在运行，请先停止它，或切换到系统服务模式' };
    }
    return this.spawnManaged();
  }

  async stop({ runMode = 'auto' } = {}) {
    const service = this.serviceState || {};
    if (this.isChildAlive) {
      return this.stopManaged();
    }
    if (service.installed && service.state === 'running') {
      const result = await this.ctx.stopService();
      if (!result.ok) return result;
      const down = await this.waitForApi(12000, false);
      return down.ok ? { ok: true, mode: 'service' } : { ok: false, error: down.error || '服务已停止，但管理 API 仍有响应' };
    }
    if (this.apiOk) {
      try {
        await this.api('/api/stop', { method: 'POST', timeout: 4000 });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: this.describeApiError(e) };
      }
    }
    return { ok: true, already: true };
  }

  async restart(options = {}) {
    const wasRunning = this.apiOk || this.isChildAlive;
    const stop = wasRunning ? await this.stop(options) : { ok: true };
    if (!stop.ok) return stop;
    if (!wasRunning) return { ok: true };
    await sleep(400);
    return this.start(options);
  }

  async spawnManaged() {
    const { frpcPath, configPath } = this.paths;
    if (!frpcPath) return { ok: false, error: '未找到 frpc.exe，请在设置中指定路径' };
    if (!configPath) return { ok: false, error: '未找到 frpc.toml，请在设置中指定路径' };

    const ensured = await this.ensureAdminConfig();
    if (!ensured.ok) return ensured;

    this.lastExit = null;
    this.stopping = false;
    this.stdoutTail = '';
    this.stderrTail = '';
    this.childStartedAt = Date.now();
    const cwd = path.dirname(configPath);
    let child;
    try {
      child = spawn(frpcPath, ['-c', configPath], {
        cwd,
        env: childEnv(this.settings),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      this.childStartedAt = null;
      return { ok: false, error: `启动 frpc 失败：${e.message}` };
    }
    this.child = child;
    this.childPid = child.pid;

    const collect = (stream, key) => {
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        this[key] = (this[key] + chunk).slice(-4000);
      });
    };
    if (child.stdout) collect(child.stdout, 'stdoutTail');
    if (child.stderr) collect(child.stderr, 'stderrTail');

    child.once('error', (error) => {
      this.emit('error', error);
      this.lastExit = { code: null, error: error.message, at: Date.now() };
      this.refresh().catch(() => {});
    });
    child.once('exit', (code, signal) => {
      /* frpc 被 /api/stop 停下时，如果当时还没登录上 frps，会以 code 1 退出并打印
       * “login to the server failed…”。这是用户主动停的，不是故障——不记成 error，
       * 否则概览会一直停在“连不上服务器”，看不出隧道其实已经停了。 */
      const intentional = this.stopping;
      this.stopping = false;
      this.child = null;
      this.childPid = null;
      this.childStartedAt = null;
      const stderr = (this.stderrTail || '').trim();
      const stdout = (this.stdoutTail || '').trim();
      this.lastExit = {
        code,
        signal,
        at: Date.now(),
        error: intentional || code === 0 || signal ? null : (stderr || stdout || `frpc 退出（代码 ${code}）`).split(/\r?\n/).slice(-3).join(' '),
      };
      this.emit('exit', this.lastExit);
      this.refresh().catch(() => {});
    });

    const up = await this.waitForApi(12000);
    if (!up.ok) {
      const detail = up.error;
      if (this.isChildAlive) {
        // 进程仍在运行但 API 没起来，通常表示配置里没有启用 webServer
        return { ok: false, error: `frpc 已启动但管理 API 不可用：${detail}` };
      }
      return { ok: false, error: this.lastExit && this.lastExit.error ? this.lastExit.error : detail };
    }
    return { ok: true, mode: 'managed' };
  }

  async stopManaged() {
    if (!this.isChildAlive) return { ok: true, already: true };
    // 标记“这次退出是我们要的”，交给 exit 处理器判断要不要记成故障。
    this.stopping = true;
    try {
      await this.api('/api/stop', { method: 'POST', timeout: 4000 });
    } catch {
      /* ignore, fall back to kill */
    }
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      if (!this.isChildAlive) {
        this.apiOk = false;
        return { ok: true };
      }
      await sleep(200);
    }
    try {
      this.child.kill();
    } catch {
      /* ignore */
    }
    await sleep(300);
    // 进程居然还活着，说明这次没停成，别把“主动停止”的标记留给下一次真正的崩溃。
    if (this.isChildAlive) this.stopping = false;
    this.apiOk = false;
    return { ok: true, forced: true };
  }

  async waitForApi(timeout = 15000, expect = true) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      try {
        await this.api('/api/status', { timeout: 1200 });
        if (expect) {
          await this.refresh();
          return { ok: true };
        }
      } catch (e) {
        if (!expect && Date.now() - started > 1500) {
          this.apiOk = false;
          return { ok: true };
        }
      }
      await sleep(350);
    }
    return { ok: false, error: expect ? this.apiError || '管理 API 未就绪' : '管理 API 仍有响应' };
  }

  async reload() {
    try {
      const r = await this.api('/api/reload', { method: 'GET', timeout: 5000 });
      await sleep(500);
      await this.refresh();
      return { ok: true, status: r.status };
    } catch (e) {
      return { ok: false, error: this.describeApiError(e) };
    }
  }

  async testLocal(proxy, timeout = 2200) {
    const host = proxy.plugin ? null : proxy.localIP || '127.0.0.1';
    const port = proxy.localPort;
    if (!host || !port) return { ok: false, error: '缺少本地端口' };
    return tcpCheck(host, port, timeout);
  }
}

module.exports = { FrpcManager };
