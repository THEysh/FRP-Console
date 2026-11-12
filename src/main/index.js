'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Tray, Menu, nativeImage, Notification } = require('electron');

app.setName('frp-console');

/*
 * 先确保 userData 目录存在，再交给 Electron：
 * 部分受限环境（例如以高完整性/受限令牌运行）下，Electron 无法在启动阶段
 * 自行创建缺失的 userData 目录，会在 app ready 前直接崩溃（0xC0000005）。
 * 在 main 中预先创建并显式指定目录可以完全规避该问题。
 */
(function ensureUserData() {
  const candidates = [];
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    candidates.push(path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'frp-console-data'));
  }
  const base = process.env.LOCALAPPDATA || process.env.APPDATA || '';
  if (base) candidates.push(path.join(base, 'frp-console'));
  candidates.push(path.join(path.dirname(process.execPath), 'frp-console-data'));
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      app.setPath('userData', dir);
      return;
    } catch { /* 尝试下一个位置 */ }
  }
})();

const settingsModule = require('./settings');
const configModule = require('./config');
const { FrpcManager } = require('./frpc');
const { LogFollower } = require('./log');
const service = require('./service');
const netport = require('./netport');
const { ServerSession } = require('./ssh');
const frpsConfig = require('./frpsconfig');
const { execFileP, tcpCheck, httpProbe, hashText, formatDuration } = require('./util');

const assetsDir = path.join(__dirname, '..', '..', 'assets');
const preloadPath = path.join(__dirname, 'preload.js');
const rendererPath = path.join(__dirname, '..', 'renderer', 'index.html');

function bundledFrpsPath(arch) {
  const folder = arch === 'arm64' ? 'linux-arm64' : arch === 'amd64' ? 'linux-amd64' : '';
  if (!folder) return '';
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'frps', folder, 'frps')]
    : [path.join(app.getAppPath(), 'resources', 'frps', folder, 'frps')];
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

let win = null;
let tray = null;
let isQuitting = false;
let settings = null;
let paths = { frpcPath: '', configPath: '', logPath: '' };
let model = null;
let configError = null;
let configHash = '';
let configStamp = { mtimeMs: 0, size: 0 };
let serviceCache = { installed: false, state: 'unknown', name: '' };
let healthCache = new Map();
let healthBusy = false;
let lastServiceCheck = 0;
let frpcVersion = '';
let elevated = false;
let bootstrapReady = null;
let pollTimer = null;
let suppressExitUntil = 0;
let tickBusy = false;
let lastServiceDetect = 0;

const follower = new LogFollower('', { maxLines: 600 });
let manager = null;
const serverSession = new ServerSession();
let serverConfig = { path: '', content: '', summary: null, error: '' };
let sessionServerId = '';
// SSH 会话代次：每次连接 / 断开 / 切档自增，异步返回时代次不符即丢弃，
// 避免旧请求的返回值把新档案的页面状态覆盖掉。
let sessionEpoch = 0;

function bumpSessionEpoch() {
  sessionEpoch += 1;
  return sessionEpoch;
}

function serverProfiles() {
  return settings && Array.isArray(settings.servers) ? settings.servers : [];
}

function findServerProfile(id) {
  const target = String(id || '');
  return serverProfiles().find((item) => item.id === target) || null;
}

function activeServerProfile() {
  return findServerProfile(settings.activeServerId) || serverProfiles()[0] || null;
}

function serverProfileView(profile) {
  return {
    id: profile.id,
    name: profile.name,
    host: profile.host,
    port: profile.port,
    username: profile.username,
    clientPort: profile.clientPort,
    hasToken: !!profile.clientToken,
    configPath: profile.configPath,
    serviceName: profile.serviceName,
    dashboardUrl: profile.dashboardUrl,
    hasPassword: settingsModule.hasServerSecret(profile.id),
    bound: profile.id === settings.clientServerId,
    active: profile.id === settings.activeServerId,
    lastConnectedAt: profile.lastConnectedAt,
  };
}

// 本机 frpc.toml 与本机“隧道绑定档案”的逐项差异。
// 页面据此区分「地址不一致 / 端口不一致 / Token 不一致」，而不是只给一句模糊的“未应用”。
function tunnelBindingView() {
  const bound = findServerProfile(settings.clientServerId);
  const addr = String((model && model.serverAddr) || '');
  const port = Number((model && model.serverPort) || 0);
  const token = (model && model.auth && model.auth.token) || '';
  return {
    addr,
    port,
    tokenSet: !!token,
    profileId: bound ? bound.id : '',
    profileName: bound ? bound.name : '',
    profileAddr: bound ? bound.host : '',
    profilePort: bound ? Number(bound.clientPort) : 0,
    hostMatch: !!(bound && addr && bound.host.toLowerCase() === addr.toLowerCase()),
    portMatch: !!(bound && port && Number(bound.clientPort) === port),
    tokenMatch: !!(bound && token && bound.clientToken === token),
    unarchived: !bound && !!addr,
  };
}

// 本机 frpc.toml 是“隧道实际连哪里”的唯一事实来源；这里把它同步成档案。
function ensureClientServerProfile({ activate = false } = {}) {
  if (!model || !model.serverAddr) return null;
  const host = String(model.serverAddr || '').trim();
  const port = Number(model.serverPort) || 7000;
  let profile = serverProfiles().find((item) => item.host.toLowerCase() === host.toLowerCase() && item.clientPort === port)
    || serverProfiles().find((item) => item.host.toLowerCase() === host.toLowerCase());
  if (!profile) {
    profile = settingsModule.normalizeServerProfile({
      name: host,
      host,
      clientPort: port,
      clientToken: (model.auth && model.auth.token) || '',
    });
    settings.servers.push(profile);
  } else {
    profile.clientPort = port;
    if (model.auth && model.auth.token) profile.clientToken = model.auth.token;
  }
  settings.clientServerId = profile.id;
  if (activate || !settings.activeServerId) settings.activeServerId = profile.id;
  settings = settingsModule.save({
    servers: settings.servers,
    activeServerId: settings.activeServerId,
    clientServerId: settings.clientServerId,
  });
  return profile;
}

function migrateLegacyServerSecret() {
  if (!settingsModule.hasLegacySecret()) return false;
  const candidates = serverProfiles();
  if (!candidates.length) return false;
  const reusable = candidates.filter((item) => !settingsModule.hasServerSecret(item.id));
  const host = settingsModule.legacyServerHost();
  let target = host ? reusable.find((item) => item.host.toLowerCase() === host.toLowerCase()) : null;
  // 只有一个档案时不必强求主机名一致（v1 可能存的是域名），也不会串到别人身上。
  if (!target && candidates.length === 1) target = reusable[0] || null;
  if (!target) return false;
  return settingsModule.migrateLegacySecret(target.id);
}

function upsertServerProfile(input, { activate = false } = {}) {
  const current = input && input.id ? findServerProfile(input.id) : null;
  const patch = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (value !== undefined) patch[key] = value;
  }
  const merged = settingsModule.normalizeServerProfile({
    ...(current || {}),
    ...patch,
    id: current ? current.id : patch.id || settingsModule.newServerId(),
  });
  let list = serverProfiles();
  if (current) list = list.map((item) => (item.id === current.id ? { ...item, ...merged } : item));
  else list = [...list, merged];
  settings = settingsModule.save({ servers: list });
  if (activate || !settings.activeServerId) {
    settings = settingsModule.save({ activeServerId: merged.id });
  }
  return findServerProfile(merged.id);
}

function refreshTray() {
  if (!tray) return;
  // 托盘文字要跟界面上的一致性：光有管理 API 不等于隧道通了。
  const runtime = manager
    ? runtimeView(manager.snapshot())
    : { running: false, connected: false, loggedIn: false, loginFailed: false, connectFailed: false, mode: 'stopped' };
  const offline = runtime.loginFailed || runtime.connectFailed;
  const statusText = offline ? '连不上服务器' : runtime.loggedIn ? '已连接' : runtime.mode === 'starting' ? '连接中' : '未连接';
  tray.setToolTip(`FRP 控制台 · ${statusText}`);
  const menu = Menu.buildFromTemplate([
    { label: runtime.loggedIn ? `隧道在线 · ${statusText}` : `隧道未连接 · ${statusText}`, enabled: false },
    { type: 'separator' },
    {
      label: '显示控制台',
      click: () => {
        if (!win) return;
        win.show();
        win.focus();
      },
    },
    {
      label: '启动隧道',
      enabled: !runtime.loggedIn,
      click: async () => {
        const result = await manager.start({ runMode: settings.runMode });
        notify(result.ok ? 'info' : 'error', result.ok ? '隧道已启动' : '启动失败', result.error || '');
        await manager.refresh();
        pushState();
      },
    },
    {
      label: '停止隧道',
      enabled: !!runtime.connected || !!(manager && manager.isChildAlive),
      click: async () => {
        suppressExitUntil = Date.now() + 12000;
        const result = await manager.stop({ runMode: settings.runMode });
        notify(result.ok ? 'info' : 'error', result.ok ? '隧道已停止' : '停止失败', result.error || '');
        await manager.refresh();
        pushState();
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

function notify(kind, title, message = '') {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body: message, icon: iconPath('icon.png'), silent: kind !== 'error' });
  n.show();
}

function iconPath(name) {
  const file = path.join(assetsDir, name);
  return fs.existsSync(file) ? file : undefined;
}

function createWindow() {
  const bounds = settings.windowBounds || {};
  win = new BrowserWindow({
    width: bounds.width || 1280,
    height: bounds.height || 840,
    x: bounds.x,
    y: bounds.y,
    minWidth: 1040,
    minHeight: 680,
    frame: false,
    show: false,
    backgroundColor: '#0a0e14',
    title: 'FRP 控制台',
    icon: iconPath('icon.png'),
    roundedCorners: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.removeMenu();
  win.loadFile(rendererPath);

  if (process.env.FRP_CONSOLE_DEBUG) {
    win.webContents.on('console-message', (event, level, message, line, sourceId) => {
      // eslint-disable-next-line no-console
      console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
    });
    win.webContents.on('did-fail-load', (event, code, desc, url) => {
      // eslint-disable-next-line no-console
      console.log(`[renderer] did-fail-load ${code} ${desc} ${url}`);
    });
    win.webContents.on('render-process-gone', (event, details) => {
      // eslint-disable-next-line no-console
      console.log(`[renderer] gone: ${JSON.stringify(details)}`);
    });
  }

  win.once('ready-to-show', () => {
    if (!settings.startMinimized) win.show();
  });

  const persistBounds = () => {
    if (!win || win.isDestroyed()) return;
    if (!win.isMaximized() && !win.isMinimized()) {
      const b = win.getBounds();
      settingsModule.save({ windowBounds: { x: b.x, y: b.y, width: b.width, height: b.height } });
      settings.windowBounds = b;
    }
  };
  win.on('resize', persistBounds);
  win.on('move', persistBounds);

  win.on('maximize', () => send('window:maximized', true));
  win.on('unmaximize', () => send('window:maximized', false));

  win.on('close', (event) => {
    if (!isQuitting && settings.closeToTray) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    win = null;
  });
}

function createTray() {
  const icon = iconPath('tray.png') || iconPath('icon.png');
  if (!icon) return;
  tray = new Tray(nativeImage.createFromPath(icon).resize({ width: 16, height: 16 }));
  tray.on('click', () => {
    if (!win) return;
    if (win.isVisible()) win.focus();
    else win.show();
  });
  refreshTray();
}

function send(channel, payload) {
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send(channel, payload);
  } catch {
    /* ignore */
  }
}

function configForState() {
  if (!model) return null;
  const { _sourceText, ...rest } = model;
  return rest;
}

// frpc 连不上服务器的原因就写在日志里（连接被拒 / 超时 / Token 不对）。
// 概览页直接把它说出来，用户才不用去猜是本地服务、隧道还是公网的问题。
function connectProblemKind(text) {
  if (/actively refused|ECONNREFUSED|拒绝/i.test(text)) return 'refused';
  if (/timeout|timed out|unreachable|ECONNRESET|network is unreachable|EOF/i.test(text)) return 'unreachable';
  if (/authorization failed|token in login|doesn't match|login to server failed|authentication/i.test(text)) return 'auth';
  return 'unknown';
}

// 把 tcpCheck 的 errno 翻成一句人话，切换前探测失败时直接给用户看。
function reachHint(code) {
  const c = String(code || '');
  if (c === 'ECONNREFUSED') return '连接被拒绝，服务器上的 frps 没在运行，或端口不对';
  if (c === 'timeout' || c === 'ETIMEDOUT') return '连接超时，网络或防火墙/安全组把这个端口丢了';
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return '域名解析失败';
  if (c === 'EHOSTUNREACH' || c === 'ENETUNREACH') return '网络不可达';
  return c || '连不上';
}

function lastConnectProblem() {
  const lines = (follower && follower.lines) || [];
  const floor = Math.max(0, lines.length - 300);
  for (let i = lines.length - 1; i >= floor; i -= 1) {
    const text = String((lines[i] && lines[i].text) || '');
    if (!text) continue;
    // 先遇到“登录/代理成功”说明之前的失败已经翻篇了，别把旧错误当现状。
    if (/login to server success|start proxy success|login to the server success/i.test(text)) return null;
    if (!/connect to server error|login to server failed|authorization failed|token in login|doesn't match/i.test(text)) continue;
    // 去掉行首时间戳，避免同样的错误每次重试都变成“新文案”触发整页重绘。
    const clean = text.replace(/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+\s*/, '').trim();
    return { text: clean.slice(0, 200), kind: connectProblemKind(clean) };
  }
  return null;
}

function runtimeView(runtime) {
  const apiOk = !!runtime.connected;
  const declared = model ? (model.proxies || []).length : 0;
  const registered = manager ? manager.proxyStatus.size : 0;
  const problem = lastConnectProblem();
  /* 注意：frpc 的管理 API 在自己连不上 frps 时照样回 200，只是返回空表。
   * 所以“API 可达”不等于“已登录 frps”。只有日志里确实记着连接失败、且一个代理都没注册上，
   * 才判定为“没连上服务器”，避免刚启动那一瞬间误报。 */
  const loginFailed = apiOk && !!problem && problem.kind !== 'unknown' && declared > 0 && registered === 0;
  const detected = !!problem && problem.kind !== 'unknown';
  return {
    ...runtime,
    loggedIn: apiOk && !loginFailed,
    loginFailed,
    // 连不上服务器（不管 frpc 进程还在不在：loginFailExit=true 时它会直接退出）
    connectFailed: detected,
    connectError: detected ? problem.text : '',
    connectKind: detected ? problem.kind : '',
  };
}

function buildState() {
  if (!manager) {
    return {
      app: { version: app.getVersion(), frpcVersion, elevated },
      settings: settingsForState(),
      paths: pathsForState(),
      config: null,
      configError,
      validation: { errors: [], warnings: [] },
      runtime: { mode: 'stopped', running: false, connected: false },
      service: serviceCache,
      proxies: [],
    };
  }
  /* 注意：这里必须先算好 runtimeView 再映射代理。
   * runtime.connected 只代表“管理 API 有响应”，frpc 连不上 frps 时它照样是 true，
   * 代理表会一直显示“同步中”。用登录状态判定才会落回“未同步”。 */
  const runtime = runtimeView(manager.snapshot());
  const validation = model ? configModule.validate(model) : { errors: [], warnings: [] };
  const proxies = (model ? model.proxies : []).map((proxy) => {
    const st = manager.proxyStatus.get(proxy.name) || null;
    const health = healthCache.get(proxy.name) || null;
    return {
      ...proxy,
      publicAddress: configModule.publicAddressFor(model, proxy),
      status: st && st.status ? st.status : runtime.loggedIn ? 'pending' : 'unknown',
      statusError: st && st.err ? st.err : '',
      runtimeLocal: st ? st.local_addr : '',
      runtimeRemote: st ? st.remote_addr : '',
      health,
    };
  });
  return {
    app: {
      version: app.getVersion(),
      frpcVersion,
      elevated,
      platform: process.platform,
      arch: process.arch,
      uptime: runtime.since ? Date.now() - runtime.since : 0,
      uptimeLabel: runtime.since ? formatDuration(Date.now() - runtime.since) : '',
    },
    settings: settingsForState(),
    paths: pathsForState(),
    config: configForState(),
    configError,
    validation,
    runtime,
    service: serviceCache,
    proxies,
    counts: (() => {
      const failed = proxies.filter((p) => p.health && !p.health.ok);
      // 按失败的层级拆开计数：概览页据此说“是本地服务、隧道还是公网不通”，
      // 而不是笼统一句“未通过三层检查”，把人骗去查本地端口。
      const layerFailed = (name) => failed.filter((p) => p.health.layers && p.health.layers[name] && !p.health.layers[name].ok).length;
      return {
        total: proxies.length,
        // 只有隧道在线、且三层连通性检查全部通过，才算真正“在线”。
        online: proxies.filter((p) => p.status === 'running' && (!p.health || p.health.ok)).length,
        unhealthy: failed.length,
        unhealthyLocal: layerFailed('local'),
        unhealthyTunnel: layerFailed('tunnel'),
        unhealthyPublic: layerFailed('public'),
      };
    })(),
    dashboardUrl: dashboardUrl(),
    logs: { count: follower.lines.length, last: follower.lines.length ? follower.lines[follower.lines.length - 1].ts : 0 },
  };
}

function settingsForState() {
  const { windowBounds, servers, ...rest } = settings;
  // 档案里的 Token 只在主进程使用，渲染层只需要“有没有”。
  return {
    ...rest,
    servers: (servers || []).map(({ clientToken, ...item }) => ({ ...item, hasToken: !!clientToken })),
  };
}

function pathsForState() {
  return {
    ...paths,
    frpcExists: !!(paths.frpcPath && fs.existsSync(paths.frpcPath)),
    configExists: !!(paths.configPath && fs.existsSync(paths.configPath)),
    logExists: !!(paths.logPath && fs.existsSync(paths.logPath)),
    configDir: paths.configPath ? path.dirname(paths.configPath) : '',
  };
}

function dashboardUrl() {
  if (settings.frpsDashboardUrl) return settings.frpsDashboardUrl;
  if (model && model.serverAddr) return `http://${model.serverAddr}:7500`;
  return '';
}

function loadConfigFromDisk({ initial = false } = {}) {
  if (!paths.configPath || !fs.existsSync(paths.configPath)) {
    model = configModule.normalize({});
    configError = paths.configPath ? '配置文件不存在' : '未找到 frpc.toml，请在设置中指定';
    configHash = '';
    configStamp = { mtimeMs: 0, size: 0 };
    updateLogFile();
    return false;
  }
  try {
    const text = fs.readFileSync(paths.configPath, 'utf8');
    model = configModule.parseConfigText(text);
    configHash = hashText(text);
    const st = fs.statSync(paths.configPath);
    configStamp = { mtimeMs: st.mtimeMs, size: st.size };
    configError = null;
    updateLogFile();
    return true;
  } catch (e) {
    configError = `配置解析失败：${e.message}`;
    if (!model) model = configModule.normalize({});
    updateLogFile();
    return false;
  }
}

function updateLogFile() {
  const file = settingsModule.logPathFromConfig(model, paths.configPath);
  paths.logPath = file;
  if (file && file !== follower.file) {
    follower.setFile(file);
    if (follower.started) follower.start();
  }
  if (!follower.started) follower.start();
}

function persistModel(nextModel, { reload = true } = {}) {
  const validation = configModule.validate(nextModel);
  if (validation.errors.length) {
    return { ok: false, errors: validation.errors, validation };
  }
  if (!paths.configPath) {
    return { ok: false, error: '尚未配置 frpc.toml 路径，请先在设置中选择配置文件' };
  }
  const write = configModule.writeConfig(paths.configPath, nextModel);
  model = nextModel;
  configError = null;
  configHash = hashText(write.text);
  try {
    const st = fs.statSync(paths.configPath);
    configStamp = { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    configStamp = { mtimeMs: 0, size: 0 };
  }
  updateLogFile();
  return { ok: true, changed: write.changed, backup: write.backup, reload };
}

async function applyAndMaybeReload(nextModel, { reload = true, restartRecommended = false } = {}) {
  const saved = persistModel(nextModel);
  if (!saved.ok) return saved;
  let reloadResult = null;
  if (reload && manager && manager.apiOk) {
    reloadResult = await manager.reload();
    if (!reloadResult.ok) {
      return { ok: false, error: `配置已保存，但热重载失败：${reloadResult.error}`, saved: true };
    }
  }
  await manager.refresh().catch(() => {});
  healthCache.clear();
  scheduleHealth(900);
  return { ok: true, saved: true, reloaded: !!reloadResult, restartRecommended, state: buildState() };
}

async function refreshService({ detect = false } = {}) {
  let q = await service.queryService(settings.serviceName);
  if (!q.installed && settings.serviceAutoDetect && detect && Date.now() - lastServiceDetect > 30000) {
    lastServiceDetect = Date.now();
    const detected = await service.detectServiceName(settings.serviceName);
    if (detected && detected !== settings.serviceName) {
      settingsModule.save({ serviceName: detected });
      settings = settingsModule.load();
      q = await service.queryService(detected);
    }
  }
  serviceCache = { ...q, name: q.name || settings.serviceName };
  manager.setServiceState(serviceCache);
  return serviceCache;
}

async function tick({ force = false } = {}) {
  if (tickBusy && !force) return;
  tickBusy = true;
  try {
    await checkExternalConfig();
    if (Date.now() - lastServiceCheck > 3800 || force) {
      lastServiceCheck = Date.now();
      await refreshService({ detect: false });
    }
    await manager.refresh();
    if (!healthBusy && Date.now() - (tick.lastHealth || 0) > 14000 && model && model.proxies.length) {
      tick.lastHealth = Date.now();
      healthBusy = true;
      checkHealth()
        .catch(() => {})
        .finally(() => {
          healthBusy = false;
          pushState();
        });
    }
    pushState();
    refreshTray();
  } catch {
    /* ignore */
  } finally {
    tickBusy = false;
  }
}

function pushState() {
  send('state:update', buildState());
}

let healthTimer = null;
function scheduleHealth(delay = 1200) {
  clearTimeout(healthTimer);
  healthTimer = setTimeout(() => {
    if (!model) return;
    checkHealth()
      .then(() => pushState())
      .catch(() => {});
  }, delay);
}

async function checkHealth() {
  if (!model) return;
  const targets = model.proxies.filter((p) => p.localPort && !p.plugin).slice(0, 16);
  const serverAddr = model.serverAddr;
  const serverPort = Number(model.serverPort);
  let serverCheck = null;
  const getServerCheck = () => {
    if (!serverCheck) serverCheck = tcpCheck(serverAddr, serverPort, 2500);
    return serverCheck;
  };

  const results = await Promise.all(
    targets.map(async (p) => {
      const at = Date.now();
      const layers = {};
      // 第 1 层：本地服务已启动且端口可达。失败即短路，不再探测后面两层。
      const local = await manager.testLocal(p);
      layers.local = { ok: local.ok, ms: local.ms, error: local.error || null };
      if (!local.ok) {
        return [p.name, { ok: false, reason: '本地服务不通', ms: local.ms, error: local.error || null, layers, at }];
      }

      // 第 2 层：本地 frpc 已连上远程服务器，且该代理已在服务端注册（frpc 状态 running）。
      const status = manager.proxyStatus.get(p.name);
      const running = !!status && status.status === 'running';
      if (!running) {
        layers.tunnel = { ok: false, ms: 0, error: status && status.err ? status.err : '代理尚未在服务端注册' };
        return [p.name, { ok: false, reason: '隧道未建立', ms: local.ms, error: layers.tunnel.error, layers, at }];
      }
      const server = await getServerCheck();
      layers.tunnel = { ok: !!server.ok, ms: server.ms, error: server.error || null };
      if (!server.ok) {
        return [p.name, { ok: false, reason: '本地到服务器不可达', ms: local.ms + server.ms, error: server.error || null, layers, at }];
      }

      // 第 3 层：从本地经公网地址访问远程端口，确认服务端已对公网监听。
      let pub;
      if (p.type === 'udp' || p.type === 'sudp') {
        layers.public = { ok: true, ms: 0, skipped: true, error: null };
        pub = { ok: true, ms: 0 };
      } else if (p.type === 'http' || p.type === 'https') {
        const url = configModule.publicAddressFor(model, p);
        pub = url ? await httpProbe(url, 5000) : { ok: false, ms: 0, error: '缺少公网域名' };
        layers.public = { ok: !!pub.ok, ms: pub.ms || 0, error: pub.error || null, status: pub.status || 0 };
      } else {
        pub = await tcpCheck(serverAddr, Number(p.remotePort), 2500);
        layers.public = { ok: !!pub.ok, ms: pub.ms || 0, error: pub.error || null };
      }
      if (!pub.ok) {
        return [p.name, { ok: false, reason: '公网不可达', ms: local.ms + (layers.tunnel.ms || 0) + (layers.public.ms || 0), error: pub.error || null, layers, at }];
      }

      return [p.name, {
        ok: true,
        reason: null,
        ms: local.ms + (layers.tunnel.ms || 0) + (layers.public.ms || 0),
        error: null,
        layers,
        at,
      }];
    }),
  );
  for (const [name, value] of results) healthCache.set(name, value);
}

async function checkExternalConfig() {
  if (!paths.configPath) return;
  let st;
  try {
    st = fs.statSync(paths.configPath);
  } catch {
    return;
  }
  if (st.mtimeMs === configStamp.mtimeMs && st.size === configStamp.size) return;
  let text;
  try {
    text = fs.readFileSync(paths.configPath, 'utf8');
  } catch {
    return;
  }
  const hash = hashText(text);
  if (hash === configHash) {
    configStamp = { mtimeMs: st.mtimeMs, size: st.size };
    return;
  }
  const beforeClient = settings.clientServerId;
  try {
    model = configModule.parseConfigText(text);
    configHash = hash;
    configStamp = { mtimeMs: st.mtimeMs, size: st.size };
    configError = null;
    updateLogFile();
    send('notify', { kind: 'info', title: '配置文件已更新', message: '检测到外部修改，正在重新载入。' });
    if (settings.autoReload && manager.apiOk) {
      const r = await manager.reload();
      if (!r.ok) send('notify', { kind: 'warn', title: '热重载失败', message: r.error || '' });
    }
    ensureClientServerProfile();
    if (settings.clientServerId !== beforeClient) {
      const bound = findServerProfile(settings.clientServerId);
      send('notify', {
        kind: 'info',
        title: '本机隧道目标已变更',
        message: `frpc.toml 现在指向 ${model.serverAddr}:${model.serverPort}，已归档为「${bound ? bound.name : '未命名'}」。`,
      });
      send('server:binding-changed', {
        clientServerId: settings.clientServerId,
        activeServerId: settings.activeServerId,
      });
    }
    pushState();
  } catch (e) {
    configError = `配置解析失败：${e.message}`;
    pushState();
  }
}

function registerIpc() {
  const ok = (data) => ({ ok: true, data });
  const fail = (error, extra = {}) => ({ ok: false, error: typeof error === 'string' ? error : (error && error.message) || String(error), ...extra });

  ipcMain.handle('app:init', async () => {
    try {
      await bootstrapReady;
    } catch {
      /* ignore */
    }
    return ok({
      state: buildState(),
      logs: follower.recent(400),
      app: {
        version: app.getVersion(),
        frpcVersion,
        elevated,
        platform: process.platform,
        dataDir: settingsModule.dataDir(),
        settingsFile: settingsModule.settingsFile(),
      },
    });
  });

  ipcMain.handle('state:refresh', async () => {
    await tick({ force: true });
    return ok(buildState());
  });

  ipcMain.handle('settings:save', async (event, patch) => {
    const allowed = [
      'frpcPath', 'configPath', 'frpsDashboardUrl', 'serviceName', 'runMode',
      'adminPort', 'adminUser', 'adminPassword', 'autoReload', 'pollIntervalMs', 'closeToTray',
      'startMinimized', 'launchTunnelOnStart', 'serviceAutoDetect', 'logBuffer', 'confirmStopService',
    ];
    const clean = {};
    for (const key of allowed) if (patch && Object.prototype.hasOwnProperty.call(patch, key)) clean[key] = patch[key];
    if (clean.pollIntervalMs) clean.pollIntervalMs = Math.min(30000, Math.max(1000, Number(clean.pollIntervalMs) || 3000));
    if (clean.adminPort) clean.adminPort = Math.min(65535, Math.max(1, Number(clean.adminPort) || 7400));
    if (clean.logBuffer) clean.logBuffer = Math.min(2000, Math.max(100, Number(clean.logBuffer) || 600));
    // 日志缓冲上限要立刻作用到正在跑的 LogFollower，否则要等下次启动才生效。
    if (clean.logBuffer) {
      follower.maxLines = clean.logBuffer;
      if (follower.lines.length > follower.maxLines) follower.lines.splice(0, follower.lines.length - follower.maxLines);
    }
    if (clean.runMode && !['auto', 'service', 'managed'].includes(clean.runMode)) delete clean.runMode;
    settings = settingsModule.save(clean);
    const previousConfig = paths.configPath;
    const previousFrpc = paths.frpcPath;
    const refreshed = await settingsModule.refreshPaths();
    paths = { ...paths, ...refreshed };
    if (paths.configPath !== previousConfig) loadConfigFromDisk();
    if (paths.frpcPath !== previousFrpc) frpcVersion = await readFrpcVersion();
    follower.setFile(paths.logPath);
    if (settings.pollIntervalMs !== pollInterval) startPolling();
    await manager.refresh().catch(() => {});
    pushState();
    return ok({ state: buildState(), paths: pathsForState() });
  });

  ipcMain.handle('paths:pick', async (event, kind) => {
    const target = kind === 'config' ? 'configPath' : 'frpcPath';
    const filters =
      kind === 'config'
        ? [{ name: 'FRP 配置', extensions: ['toml', 'yaml', 'yml', 'json'] }]
        : [{ name: '可执行文件', extensions: ['exe'] }];
    const title = kind === 'config' ? '选择 frpc 配置文件' : '选择 frpc.exe';
    const result = await dialog.showOpenDialog(win, { title, properties: ['openFile'], filters });
    if (result.canceled || !result.filePaths.length) return ok({ canceled: true });
    const file = result.filePaths[0];
    settingsModule.save({ [target]: file });
    settings = settingsModule.load();
    const refreshed = await settingsModule.refreshPaths();
    paths = { ...paths, ...refreshed };
    if (kind === 'config') loadConfigFromDisk();
    else if (kind === 'frpc') frpcVersion = await readFrpcVersion();
    updateLogFile();
    pushState();
    return ok({ state: buildState(), file });
  });

  ipcMain.handle('paths:reveal', async (event, which) => {
    const target = which === 'log' ? paths.logPath : which === 'frpc' ? paths.frpcPath : paths.configPath;
    if (!target) return fail('路径尚未设置');
    if (fs.existsSync(target)) shell.showItemInFolder(target);
    return ok({ revealed: true });
  });

  ipcMain.handle('config:save', async (event, incoming) => {
    if (!model) return fail('配置尚未载入');
    const clean = configModule.normalize({
      ...model._extra,
      serverAddr: incoming.serverAddr,
      serverPort: incoming.serverPort,
      loginFailExit: incoming.loginFailExit,
      auth: incoming.auth,
      log: incoming.log,
      transport: incoming.transport,
      webServer: model.webServer,
      proxies: model.proxies,
      visitors: model.visitors,
    });
    clean._sourceText = model._sourceText;
    const validation = configModule.validate(clean);
    if (validation.errors.length) return { ok: false, error: validation.errors[0].message, errors: validation.errors, validation };
    const connChanged =
      clean.serverAddr !== model.serverAddr ||
      clean.serverPort !== model.serverPort ||
      clean.auth.token !== model.auth.token ||
      JSON.stringify(clean.transport || null) !== JSON.stringify(model.transport || null);
    const result = await applyAndMaybeReload(clean, { restartRecommended: connChanged });
    if (!result.ok) return result;
    ensureClientServerProfile({ activate: connChanged });
    pushState();
    return ok({ state: result.state, reloaded: result.reloaded, restartRecommended: connChanged });
  });

  ipcMain.handle('proxy:save', async (event, payload) => {
    if (!model) return fail('配置尚未载入');
    const { mode = 'add', originalName = '', proxy: input } = payload || {};
    if (!input) return fail('缺少代理参数');
    const proxy = configModule.makeProxy(input);
    const next = configModule.normalize({
      ...model._extra,
      serverAddr: model.serverAddr,
      serverPort: model.serverPort,
      loginFailExit: model.loginFailExit,
      auth: model.auth,
      log: model.log,
      transport: model.transport,
      webServer: model.webServer,
      proxies: mode === 'edit'
        ? model.proxies.map((p) => (p.name === originalName ? { ...proxy, ...(p.secretKey && !proxy.secretKey ? { secretKey: p.secretKey } : {}) } : p))
        : [...model.proxies, proxy],
      visitors: model.visitors,
    });
    if (mode === 'add' && model.proxies.some((p) => p.name === proxy.name)) {
      return { ok: false, error: `代理名称「${proxy.name}」已存在`, validation: configModule.validate(next) };
    }
    const validation = configModule.validate(next);
    if (validation.errors.length) {
      return { ok: false, error: validation.errors[0].message, errors: validation.errors, validation };
    }
    const result = await applyAndMaybeReload(next);
    if (!result.ok) return result;
    pushState();
    return ok({ state: result.state, reloaded: result.reloaded, proxy });
  });

  ipcMain.handle('proxy:delete', async (event, name) => {
    if (!model) return fail('配置尚未载入');
    const next = configModule.normalize({
      ...model._extra,
      serverAddr: model.serverAddr,
      serverPort: model.serverPort,
      loginFailExit: model.loginFailExit,
      auth: model.auth,
      log: model.log,
      transport: model.transport,
      webServer: model.webServer,
      proxies: model.proxies.filter((p) => p.name !== name),
      visitors: model.visitors,
    });
    healthCache.delete(name);
    const result = await applyAndMaybeReload(next);
    if (!result.ok) return result;
    pushState();
    return ok({ state: result.state, reloaded: result.reloaded });
  });

  ipcMain.handle('proxy:suggest-port', async (event, type) => {
    if (!model) return ok({ port: 10000 });
    return ok({ port: configModule.suggestRemotePort(model, type) });
  });

  ipcMain.handle('tunnel:start', async () => {
    await refreshService({ detect: true });
    const result = await manager.start({ runMode: settings.runMode });
    await manager.refresh().catch(() => {});
    healthCache.clear();
    scheduleHealth(1500);
    pushState();
    if (!result.ok) return fail(result.error, { state: buildState() });
    return ok({ state: buildState(), mode: result.mode });
  });

  ipcMain.handle('tunnel:stop', async () => {
    suppressExitUntil = Date.now() + 12000;
    await refreshService({ detect: false });
    const result = await manager.stop({ runMode: settings.runMode });
    await manager.refresh().catch(() => {});
    pushState();
    if (!result.ok) return fail(result.error, { state: buildState() });
    return ok({ state: buildState(), mode: result.mode });
  });

  ipcMain.handle('tunnel:restart', async () => {
    await refreshService({ detect: false });
    suppressExitUntil = Date.now() + 15000;
    const result = await manager.restart({ runMode: settings.runMode });
    await manager.refresh().catch(() => {});
    pushState();
    if (!result.ok) return fail(result.error, { state: buildState() });
    return ok({ state: buildState(), mode: result.mode });
  });

  ipcMain.handle('tunnel:reload', async () => {
    const result = await manager.reload();
    await manager.refresh().catch(() => {});
    healthCache.clear();
    scheduleHealth(900);
    pushState();
    if (!result.ok) return fail(result.error, { state: buildState() });
    return ok({ state: buildState(), status: result.status });
  });

  ipcMain.handle('service:control', async (event, payload) => {
    const action = payload && payload.action;
    const name = settings.serviceName;
    let result = { ok: true };
    if (action === 'start') result = await service.startService(name);
    else if (action === 'stop') result = await service.stopService(name);
    else if (action === 'restart') result = await service.restartService(name);
    else if (action === 'autostart') result = await service.setStartType(name, payload.value === 'auto' ? 'auto' : payload.value === 'disabled' ? 'disabled' : 'demand');
    else return fail('未知的服务操作');
    await refreshService({ detect: false });
    await manager.refresh().catch(() => {});
    pushState();
    if (!result.ok) return fail(result.error || '操作失败', { state: buildState(), service: serviceCache });
    return ok({ state: buildState(), service: serviceCache });
  });

  ipcMain.handle('admin:enable', async () => {
    if (!model) return fail('配置尚未载入');
    const changed = configModule.ensureAdmin(model, settings);
    if (!changed && manager.apiOk) return ok({ state: buildState(), changed: false });
    const saved = persistModel(model, { reload: false });
    if (!saved.ok) return saved;
    const wasRunning = manager.apiOk || (serviceCache.installed && serviceCache.state === 'running');
    if (wasRunning) {
      suppressExitUntil = Date.now() + 20000;
      if (manager.isChildAlive) {
        const r = await manager.restart({ runMode: 'managed' });
        if (!r.ok) return fail(r.error || '重启失败', { state: buildState() });
      } else if (serviceCache.installed) {
        const r = await service.restartService(settings.serviceName);
        if (!r.ok) return fail(r.error || '重启服务失败', { state: buildState() });
        await manager.waitForApi(20000);
      } else {
        const r = await manager.restart({ runMode: settings.runMode });
        if (!r.ok) return fail(r.error || '重启失败', { state: buildState() });
      }
    }
    await manager.refresh().catch(() => {});
    pushState();
    return ok({ state: buildState(), changed: true, restartRecommended: !wasRunning ? false : true });
  });

  ipcMain.handle('listen:scan', async () => {
    const result = await netport.listListeners();
    if (!result.ok) return fail(result.error, { listeners: [] });
    return ok({ listeners: result.listeners });
  });

  function applyPortStatus(info, summary) {
    if (!info || info.status === 'running' || !summary) return;
    const listening = String(info.listeners || '');
    const ports = [summary.bindPort, summary.webPort].filter(Boolean);
    const hit = ports.find((port) => new RegExp(`:${port}\\b`).test(listening));
    if (hit) {
      info.status = 'running';
      info.statusText = '运行中';
      info.statusSource = 'port';
      info.statusHint = `检测到端口 ${hit} 正在监听`;
    }
  }

  // 读取类操作统一带上会话代次：中途切了档案就丢弃结果，
  // 避免旧服务器的配置 / 状态被写进新档案的页面。
  function staleFail() {
    return fail('已切换服务器档案，本次结果已丢弃', { stale: true, state: serverState() });
  }

  async function loadServerSnapshot({ inspect = false, epoch = sessionEpoch } = {}) {
    if (inspect) {
      const inspected = await serverSession.inspect();
      if (epoch !== sessionEpoch) return { ok: false, stale: true };
      if (!inspected.ok && !serverSession.info) return { ok: false, error: inspected.error };
    }
    const configResult = await serverSession.readConfig();
    if (epoch !== sessionEpoch) return { ok: false, stale: true };
    if (configResult.ok) {
      const parsed = frpsConfig.parseConfig(configResult.content);
      serverConfig = {
        path: configResult.path,
        content: configResult.content,
        summary: parsed.ok ? frpsConfig.summary(parsed.data) : null,
        error: parsed.ok ? '' : `配置解析失败：${parsed.error}`,
      };
    } else {
      serverConfig = { path: serverSession.configPath || '', content: '', summary: null, error: configResult.error || '' };
    }
    if (serverConfig.summary) applyPortStatus(serverSession.info, serverConfig.summary);
    return { ok: true };
  }

  function serverState() {
    const active = activeServerProfile();
    const profiles = serverProfiles().map(serverProfileView);
    return {
      connected: serverSession.connected,
      host: serverSession.host,
      port: serverSession.port,
      username: serverSession.username,
      info: serverSession.info,
      configPath: serverSession.configPath,
      config: serverConfig.content,
      summary: serverConfig.summary,
      configError: serverConfig.error,
      saved: active ? { host: active.host, port: active.port, username: active.username } : {},
      savedCredential: active ? settingsModule.hasServerSecret(active.id) : false,
      profiles,
      activeServerId: settings.activeServerId || '',
      clientServerId: settings.clientServerId || '',
      tokenMatchesActive: !!(active && model && active.clientToken && active.clientToken === ((model.auth && model.auth.token) || '')),
      tunnel: tunnelBindingView(),
      serverId: sessionServerId,
      sessionServerId,
      epoch: sessionEpoch,
      client: model ? {
        serverAddr: model.serverAddr || '',
        serverPort: Number(model.serverPort) || 7000,
        tokenSet: !!(model.auth && model.auth.token),
        boundProfileId: settings.clientServerId || '',
        boundProfileName: (findServerProfile(settings.clientServerId) || {}).name || '',
      } : null,
    };
  }

  ipcMain.handle('server:state', async () => ok(serverState()));

  ipcMain.handle('server:select', async (event, payload = {}) => {
    const profile = findServerProfile(payload.id);
    if (!profile) return fail('服务器档案不存在', { state: serverState() });
    let disconnected = '';
    if (serverSession.connected && sessionServerId && sessionServerId !== profile.id) {
      const previous = findServerProfile(sessionServerId);
      disconnected = (previous && previous.name) || serverSession.host || '上一台服务器';
      serverSession.disconnect();
      sessionServerId = '';
      serverConfig = { path: '', content: '', summary: null, error: '' };
      bumpSessionEpoch();
    }
    settings = settingsModule.save({ activeServerId: profile.id });
    return ok({ ...serverState(), disconnected });
  });

  ipcMain.handle('server:profile-save', async (event, payload = {}) => {
    const host = String(payload.host || '').trim();
    if (!host) return fail('请输入服务器 IP 或域名', { state: serverState() });
    const sshPort = Number(payload.port) || 22;
    const username = String(payload.username || 'root').trim() || 'root';
    if (!payload.id) {
      const duplicate = serverProfiles().find((item) => item.host.toLowerCase() === host.toLowerCase() && item.port === sshPort && item.username === username);
      if (duplicate) return fail(`已存在同一台服务器的档案「${duplicate.name}」，请直接编辑它。`, { state: serverState() });
    }
    const before = payload.id ? findServerProfile(payload.id) : null;
    const patch = {
      id: payload.id,
      name: payload.name,
      host,
      port: sshPort,
      username,
      clientPort: Number(payload.clientPort) || 7000,
      configPath: payload.configPath,
      serviceName: payload.serviceName,
      dashboardUrl: payload.dashboardUrl,
    };
    // 编辑时留空表示保持原值；显式 clearToken 才允许清空。
    if (payload.clearToken) patch.clientToken = '';
    else if (payload.clientToken !== undefined) patch.clientToken = payload.clientToken;
    // 新建档案没填 Token 时沿用本机 frpc.toml 的 Token：同一个 frps 上本来就是同一个。
    if (!payload.id && !patch.clientToken && model && model.auth && model.auth.token) {
      patch.clientToken = model.auth.token;
    }
    const profile = upsertServerProfile(patch, { activate: true });
    const password = String(payload.password || '');
    if (password) {
      const saved = settingsModule.saveServerSecret(profile.id, password);
      if (!saved.ok) return fail(saved.error, { state: serverState() });
    } else if (payload.remember === false) {
      settingsModule.clearServerSecret(profile.id);
    }
    // 改了地址就不再沿用旧主机的密码，避免“换了 IP 但还拿老密码去登录”的死循环。
    const hostChanged = !!(before && before.host.toLowerCase() !== profile.host.toLowerCase());
    if (hostChanged && !password) settingsModule.clearServerSecret(profile.id);
    if (serverSession.connected && sessionServerId === profile.id && hostChanged) {
      serverSession.disconnect();
      sessionServerId = '';
      serverConfig = { path: '', content: '', summary: null, error: '' };
      bumpSessionEpoch();
    }
    return ok({ ...serverState(), hostChanged });
  });

  ipcMain.handle('server:profile-delete', async (event, payload = {}) => {
    const profile = findServerProfile(payload.id);
    if (!profile) return fail('服务器档案不存在', { state: serverState() });
    if (profile.id === settings.clientServerId && !payload.force) {
      return fail('这台服务器正绑定本机隧道，请先切换到其他档案，或勾选“同时解除绑定”后删除。', {
        state: serverState(),
        needsForce: true,
      });
    }
    let disconnected = '';
    if (serverSession.connected && sessionServerId === profile.id) {
      disconnected = profile.name;
      serverSession.disconnect();
      sessionServerId = '';
      serverConfig = { path: '', content: '', summary: null, error: '' };
      bumpSessionEpoch();
    }
    settingsModule.clearServerSecret(profile.id);
    const rest = serverProfiles().filter((item) => item.id !== profile.id);
    const nextActive = rest.find((item) => item.id === settings.clientServerId) || rest[0];
    const patch = {
      servers: rest,
      activeServerId: nextActive ? nextActive.id : '',
    };
    if (profile.id === settings.clientServerId) patch.clientServerId = '';
    settings = settingsModule.save(patch);
    return ok({ ...serverState(), disconnected });
  });

  ipcMain.handle('server:profile-clear-password', async (event, payload = {}) => {
    const profile = findServerProfile(payload.id);
    if (!profile) return fail('服务器档案不存在', { state: serverState() });
    settingsModule.clearServerSecret(profile.id);
    return ok({ ...serverState(), cleared: !settingsModule.hasServerSecret(profile.id) });
  });

  ipcMain.handle('server:apply', async (event, payload = {}) => {
    const profile = findServerProfile(payload.id || settings.activeServerId);
    if (!profile) return fail('服务器档案不存在', { state: serverState() });
    if (!profile.clientToken) return fail('该档案还没有 Token，请先在档案里填写或连接服务器后保存', { state: serverState() });
    if (!model) return fail('本机配置尚未载入', { state: serverState() });
    const clientPort = Number(profile.clientPort) || 7000;
    const sameTarget = profile.host === model.serverAddr && Number(model.serverPort) === clientPort;
    /* 目标服务器连不上时不能默默改配置：配置一改，正在工作的隧道就被指向一个死地址，
     * 用户会以为"切换成功"，实际两条都不通。先探一次端口，把决定权交回给用户。 */
    if (!payload.force && !sameTarget) {
      const reach = await tcpCheck(profile.host, clientPort, 2500);
      if (!reach.ok) {
        const hint = reachHint(reach.error);
        return fail(`连不上 ${profile.host}:${clientPort}（${hint}）`, {
          state: serverState(),
          unreachable: { id: profile.id, name: profile.name, host: profile.host, port: clientPort, error: reach.error || '', hint },
        });
      }
    }
    const next = structuredClone(model);
    next.serverAddr = profile.host;
    next.serverPort = clientPort;
    next.auth = { ...(next.auth || {}), method: 'token', token: profile.clientToken };
    send('server:switch-progress', { step: 'write', name: profile.name });
    const saved = persistModel(next, { reload: false });
    if (!saved.ok) return fail(saved.error || (saved.errors || []).map((e) => e.message).join('；') || '写入本机 frpc 配置失败', { state: serverState() });
    settings = settingsModule.save({ activeServerId: profile.id, clientServerId: profile.id });
    send('server:switch-progress', { step: 'restart', name: profile.name });
    const restarted = await manager.restart({ runMode: settings.runMode });
    send('server:switch-progress', { step: 'done', ok: restarted.ok });
    await manager.refresh().catch(() => {});
    healthCache.clear();
    scheduleHealth(1200);
    pushState();
    return ok({
      state: serverState(),
      appState: buildState(),
      restarted,
      restartRecommended: false,
      message: restarted.ok ? '' : (restarted.error || '隧道重启失败，请手动重启'),
    });
  });

  ipcMain.handle('server:bind-client', async (event, payload = {}) => {
    const host = String(payload.host || '').trim();
    if (!host) return fail('服务器地址不能为空', { state: serverState() });
    const clientPort = Number(payload.serverPort) || 7000;
    const existing = serverProfiles().find((item) => item.host.toLowerCase() === host.toLowerCase() && item.clientPort === clientPort)
      || serverProfiles().find((item) => item.host.toLowerCase() === host.toLowerCase());
    const profile = upsertServerProfile({
      ...(existing || {}),
      id: existing ? existing.id : undefined,
      host,
      name: (existing && existing.name) || host,
      clientPort,
      clientToken: String(payload.token || ''),
    }, { activate: true });
    settings = settingsModule.save({ clientServerId: profile.id, activeServerId: profile.id });
    return ok({ state: serverState(), profileId: profile.id });
  });

  ipcMain.handle('server:connect', async (event, payload = {}) => {
    const requested = findServerProfile(payload.serverId || settings.activeServerId);
    const host = String(payload.host || (requested && requested.host) || '').trim();
    const username = String(payload.username || (requested && requested.username) || '').trim();
    const port = Number(payload.port) || (requested && requested.port) || 22;
    let password = String(payload.password || '');
    if (!host) return fail('请输入服务器 IP 或域名');
    if (!username) return fail('请输入 SSH 用户名');
    if (!Number.isInteger(port) || port < 1 || port > 65535) return fail('SSH 端口无效');

    let profile = requested;
    // 表单里的地址 / 端口 / 用户名被改过时，必须明确是“更新这个档案”还是“另存为新档案”，
    // 否则会出现“拿档案 A 的密码去连 B、然后 A 的地址被偷偷改写”的状态错乱。
    const changed = !!(profile
      && (profile.host.toLowerCase() !== host.toLowerCase() || Number(profile.port) !== port || profile.username !== username));
    if (changed) {
      if (payload.adoptProfile === true) {
        settingsModule.clearServerSecret(profile.id); // 旧密码属于旧主机，不能沿用
      } else if (payload.adoptProfile === false) {
        profile = null;
      } else {
        return fail('输入的地址与所选档案不一致', {
          needsDecision: 'host-mismatch',
          profile: serverProfileView(profile),
          input: { host, port, username },
          state: serverState(),
        });
      }
    }
    if (!profile) profile = upsertServerProfile({ host, port, username, name: host }, { activate: true });
    if (!password) password = settingsModule.readServerSecret(profile.id);
    if (!password) return fail(changed ? '档案地址已变更，请重新输入 SSH 密码' : '请输入密码', { needsPassword: true, state: serverState() });

    // 会话即将变更：让所有在途的读请求结果失效，防止旧档案的数据回写到新页面。
    bumpSessionEpoch();
    const result = await serverSession.connect({ host, port, username, password });
    if (!result.ok) return fail(result.error, { state: serverState() });
    profile = upsertServerProfile({ ...profile, host, port, username }, { activate: true });
    if (payload.remember) {
      const saved = settingsModule.saveServerSecret(profile.id, password);
      if (!saved.ok) return fail(saved.error, { state: serverState() });
    } else if (payload.password) {
      settingsModule.clearServerSecret(profile.id);
    }
    const inspected = await serverSession.inspect();
    sessionServerId = profile.id;
    profile.lastConnectedAt = Date.now();
    settings = settingsModule.save({ servers: serverProfiles().map((item) => (item.id === profile.id ? profile : item)), activeServerId: profile.id });
    await loadServerSnapshot();
    return ok({
      ...serverState(),
      adoptProfile: changed && payload.adoptProfile === true,
      inspectError: inspected.ok ? '' : inspected.error,
    });
  });

  ipcMain.handle('server:disconnect', async () => {
    serverSession.disconnect();
    sessionServerId = '';
    serverConfig = { path: '', content: '', summary: null, error: '' };
    bumpSessionEpoch();
    return ok(serverState());
  });

  ipcMain.handle('server:refresh', async () => {
    if (!serverSession.connected) return fail('尚未连接服务器', { state: serverState() });
    const epoch = sessionEpoch;
    const loaded = await loadServerSnapshot({ inspect: true, epoch });
    if (loaded.stale) return staleFail();
    if (!loaded.ok) return fail(loaded.error || '读取服务器信息失败', { state: serverState() });
    return ok(serverState());
  });

  ipcMain.handle('server:read-config', async () => {
    const epoch = sessionEpoch;
    const result = await serverSession.readConfig();
    if (epoch !== sessionEpoch) return staleFail();
    if (!result.ok) return fail(result.error, { state: serverState() });
    return ok({ path: result.path, content: result.content, serverId: sessionServerId, state: serverState() });
  });

  ipcMain.handle('server:preview', async (event, payload = {}) => {
    const result = frpsConfig.preview(serverConfig.content, payload.fields || {});
    if (!result.ok) return fail(result.error || (result.errors && result.errors[0]) || '生成配置失败');
    return ok({ text: result.text, warnings: result.warnings || [] });
  });

  ipcMain.handle('server:bootstrap', async (event, payload = {}) => {
    if (!serverSession.connected) return fail('尚未连接服务器');
    const epoch = sessionEpoch;
    const generated = frpsConfig.preview(serverConfig.content || '', payload.fields || {});
    if (!generated.ok) {
      return fail(generated.error || (generated.errors || []).join('；') || '生成配置失败');
    }
    const rawArch = String((serverSession.info && serverSession.info.arch) || '').toLowerCase();
    const arch = ['x86_64', 'amd64', 'x64'].includes(rawArch) ? 'amd64' : ['aarch64', 'arm64'].includes(rawArch) ? 'arm64' : rawArch;
    const localBinary = bundledFrpsPath(arch);
    if (!localBinary && !(serverSession.info && serverSession.info.frpsInstalled)) {
      return fail(`本机缺少 ${arch || '未知架构'} 版 frps 安装包，无法自动安装`);
    }
    const configPath = serverSession.configPath || '/etc/frp/frps.toml';
    const unitName = (serverSession.info && serverSession.info.hasUnit && serverSession.info.serviceName) || 'frps';
    const result = await serverSession.bootstrap({
      content: generated.text,
      localBinary,
      configPath,
      unitName,
      onProgress: (step) => {
        try { event.sender.send('server:install-progress', step); } catch { /* window closed */ }
      },
    });
    if (!result.ok) return fail(result.error, { steps: result.steps || [] });
    // 初始化过程可能长达几十秒，期间切了档案就不再改写任何本机状态。
    if (epoch !== sessionEpoch) {
      return fail('初始化已完成，但期间切换了服务器档案，未回写本机配置', { stale: true, steps: result.steps || [] });
    }
    const summary = frpsConfig.summary(generated.data || {});
    const activeProfile = activeServerProfile();
    const profile = upsertServerProfile({
      ...(activeProfile || {}),
      id: activeProfile ? activeProfile.id : undefined,
      name: (activeProfile && activeProfile.name) || serverSession.host,
      host: serverSession.host,
      port: serverSession.port,
      username: serverSession.username,
      clientPort: Number(summary.bindPort) || 7000,
      clientToken: summary.authEnabled ? summary.token : '',
      configPath: result.configPath || configPath,
      serviceName: unitName,
    }, { activate: true });
    let localSync = null;
    if (payload.syncLocal && model) {
      const next = structuredClone(model);
      next.serverAddr = serverSession.host;
      next.serverPort = Number(summary.bindPort) || 7000;
      next.auth = { ...(next.auth || {}), method: 'token', token: summary.authEnabled ? summary.token : '' };
      const saved = persistModel(next, { reload: false });
      if (!saved.ok) {
        localSync = { ok: false, error: saved.error || (saved.errors || []).join('；') || '写入本机 frpc 配置失败' };
      } else {
        settings = settingsModule.save({ clientServerId: profile.id, activeServerId: profile.id });
        const restarted = await manager.restart({ runMode: settings.runMode });
        localSync = {
          ok: !!restarted.ok,
          error: restarted.ok ? '' : (restarted.error || '重启本机隧道失败'),
          mode: restarted.mode,
        };
      }
    }
    await loadServerSnapshot({ inspect: true });
    return ok({ ...result, localSync, state: serverState(), appState: buildState() });
  });

  ipcMain.handle('server:selftest', async (event, payload = {}) => {
    const layer = String(payload.layer || '');
    const startedAt = Date.now();
    if (layer === 'local') {
      const snapshot = manager ? manager.snapshot() : null;
      const proxies = model ? model.proxies || [] : [];
      const ports = [...new Set(proxies.map((proxy) => Number(proxy.localPort)).filter((port) => port > 0))];
      if (snapshot && snapshot.connected && ports.length) {
        let reachable = 0;
        const failedPorts = [];
        for (const port of ports.slice(0, 8)) {
          const probe = await tcpCheck('127.0.0.1', port, 1800);
          if (probe.ok) reachable += 1;
          else failedPorts.push(port);
        }
        if (reachable === ports.length) {
          return ok({ layer, ok: true, ms: Date.now() - startedAt, detail: `frpc 已连接，本地端口 ${reachable}/${ports.length} 可达` });
        }
        return ok({
          layer,
          ok: false,
          ms: Date.now() - startedAt,
          reason: '本地服务不通',
          detail: `frpc 已连接，本地端口 ${reachable}/${ports.length} 可达${failedPorts.length ? `，不通：${failedPorts.join(', ')}` : ''}`,
        });
      }
      if (serverSession.connected) {
        return ok({ layer, ok: true, ms: Date.now() - startedAt, detail: 'SSH 通道可达（未检测到本地 frpc 代理）' });
      }
      return ok({ layer, ok: false, ms: Date.now() - startedAt, reason: '本地服务不通', detail: 'SSH 通道断开' });
    }
    if (layer === 'tunnel') {
      const host = (model && model.serverAddr) || '';
      const port = Number((model && model.serverPort) || 0);
      if (!host || !port) return ok({ layer, ok: false, ms: Date.now() - startedAt, reason: '本地到服务器不可达', detail: '未配置 frps 地址或端口' });
      const probe = await tcpCheck(host, port, 3000);
      if (!probe.ok) return ok({ layer, ok: false, ms: probe.ms, reason: '本地到服务器不可达', detail: `${host}:${port} TCP 握手失败` });
      return ok({ layer, ok: true, ms: probe.ms, detail: `${host}:${port} TCP 握手成功` });
    }
    if (layer === 'public') {
      if (!serverSession.connected) return ok({ layer, ok: false, ms: Date.now() - startedAt, reason: '公网不可达', detail: 'SSH 未连接' });
      const epoch = sessionEpoch;
      const result = await serverSession.exec(
        "curl -sS --max-time 10 https://ifconfig.me 2>/dev/null || wget -qO- --timeout=10 https://ifconfig.me 2>/dev/null || true",
        14000,
      );
      if (epoch !== sessionEpoch) return staleFail();
      const egress = (result.stdout || '').trim().split(/\s+/)[0];
      if (egress) return ok({ layer, ok: true, ms: Date.now() - startedAt, detail: `服务器出口 IP ${egress}` });
      return ok({ layer, ok: false, ms: Date.now() - startedAt, reason: '公网不可达', detail: '服务器无法访问外网或缺少 curl/wget' });
    }
    return fail('未知的检测层');
  });

  ipcMain.handle('server:control', async (event, payload = {}) => {
    const action = String(payload.action || '');
    if (!['start', 'stop', 'restart'].includes(action)) return fail('未知操作');
    const epoch = sessionEpoch;
    const result = await serverSession.control(action);
    if (epoch !== sessionEpoch) return staleFail();
    if (!result.ok) return fail(result.error, { state: serverState() });
    await loadServerSnapshot({ epoch });
    return ok({ ...result, serverId: sessionServerId, state: serverState() });
  });

  ipcMain.handle('server:save-config', async (event, payload = {}) => {
    const content = String(payload.content || '');
    if (!content.trim()) return fail('配置内容为空');
    if (!serverSession.connected) return fail('尚未连接服务器', { state: serverState() });
    const check = frpsConfig.validateText(content);
    if (!check.ok) return fail(`配置语法错误：${check.error}`);
    const epoch = sessionEpoch;
    const result = await serverSession.writeConfig(content, { restart: !!payload.restart });
    if (epoch !== sessionEpoch) return staleFail();
    if (!result.ok) return fail(result.error, { state: serverState() });
    await loadServerSnapshot({ inspect: true, epoch });
    return ok({ backup: result.backup, restarted: result.restarted, serverId: sessionServerId, state: serverState() });
  });

  ipcMain.handle('server:logs', async (event, payload = {}) => {
    const epoch = sessionEpoch;
    const result = await serverSession.logs(payload.lines || 200);
    if (epoch !== sessionEpoch) return staleFail();
    if (!result.ok) return fail(result.error);
    return ok({ source: result.source, content: result.content, serverId: sessionServerId });
  });

  ipcMain.handle('probe:tcp', async (event, payload) => {
    const host = String((payload && payload.host) || '').trim();
    const port = Number(payload && payload.port);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return fail('主机或端口无效');
    return ok(await tcpCheck(host, port, payload.timeout || 3000));
  });

  ipcMain.handle('logs:get', async (event, payload = {}) => {
    const limit = Math.min(2000, Math.max(1, Number(payload.limit) || 500));
    const since = Number(payload.since) || 0;
    // since 用于增量拉取，但也要受 limit 约束，避免一次把上千行推给渲染层。
    const lines = since ? follower.lines.filter((l) => l.id > since).slice(-limit) : follower.recent(limit);
    return ok({ lines, file: paths.logPath, exists: fs.existsSync(paths.logPath || '') });
  });

  ipcMain.handle('logs:clear', async () => {
    follower.clear();
    send('logs:reset', { lines: [] });
    return ok({ cleared: true });
  });

  ipcMain.handle('logs:export', async () => {
    const lines = follower.recent(2000);
    if (!lines.length) return fail('暂无日志可导出');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const result = await dialog.showSaveDialog(win, {
      title: '导出日志',
      defaultPath: path.join(path.dirname(paths.logPath || settingsModule.dataDir()), `frpc-logs-${stamp}.log`),
      filters: [{ name: '日志文件', extensions: ['log', 'txt'] }],
    });
    if (result.canceled || !result.filePath) return ok({ canceled: true });
    fs.writeFileSync(result.filePath, lines.map((l) => l.text).join('\n'), 'utf8');
    return ok({ file: result.filePath });
  });

  ipcMain.handle('clipboard:write', async (event, text) => {
    clipboard.writeText(String(text || ''));
    return ok({ written: true });
  });

  ipcMain.handle('shell:open', async (event, url) => {
    const target = String(url || '');
    if (!/^https?:\/\//i.test(target)) return fail('只允许打开 http/https 链接');
    await shell.openExternal(target);
    return ok({ opened: target });
  });

  ipcMain.handle('window:control', async (event, action) => {
    if (!win) return fail('窗口不可用');
    if (action === 'minimize') win.minimize();
    else if (action === 'maximize') {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    } else if (action === 'close') win.close();
    return ok({ maximized: win.isMaximized() });
  });

  ipcMain.handle('app:quit', async () => {
    isQuitting = true;
    if (manager && manager.isChildAlive) {
      try { await manager.stopManaged(); } catch { /* ignore */ }
    }
    serverSession.disconnect();
    app.quit();
    return ok({ quitting: true });
  });

  ipcMain.handle('app:notification', async (event, payload) => {
    notify((payload && payload.kind) || 'info', (payload && payload.title) || 'FRP 控制台', (payload && payload.message) || '');
    return ok({ shown: true });
  });

  // 生成带 --no-sandbox 的桌面 / 开始菜单快捷方式。
  // 本机 Chromium 沙箱初始化会失败（退出码 3），快捷方式必须带上该参数，
  // 否则双击等于没有反应；安装器环境受限时也可以从这里兜底。
  ipcMain.handle('app:create-shortcut', async () => {
    const exe = process.execPath;
    const name = 'FRP 控制台';
    const targets = [
      path.join(app.getPath('desktop'), `${name}.lnk`),
      path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${name}.lnk`),
    ];
    const created = [];
    const failed = [];
    for (const lnk of targets) {
      try {
        fs.mkdirSync(path.dirname(lnk), { recursive: true });
        const written = shell.writeShortcutLink(lnk, 'create', {
          target: exe,
          args: '--no-sandbox',
          cwd: path.dirname(exe),
          icon: exe,
          iconIndex: 0,
          description: 'FRP 内网穿透控制台：代理管理、端口扫描、frps 远程管理',
        });
        if (written) created.push(lnk);
        else failed.push(lnk);
      } catch (e) {
        failed.push(`${lnk}（${e.message}）`);
      }
    }
    if (!created.length) {
      return fail('创建快捷方式失败：当前会话不允许写入桌面，可手动在 exe 上右键「发送到 → 桌面快捷方式」，并在属性里补 --no-sandbox');
    }
    return ok({ created, failed });
  });
}

async function readFrpcVersion() {
  if (!paths.frpcPath || !fs.existsSync(paths.frpcPath)) return '';
  const r = await execFileP(paths.frpcPath, ['-v'], { timeout: 10000 });
  return r.ok ? (r.stdout || r.stderr).trim().split(/\r?\n/)[0] : '';
}

let pollInterval = 3000;

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollInterval = Math.max(1000, Number(settings.pollIntervalMs) || 3000);
  pollTimer = setInterval(() => tick(), pollInterval);
  if (pollTimer.unref) pollTimer.unref();
}

follower.on('lines', (lines) => send('logs:append', lines));
follower.on('reset', () => send('logs:reset', { lines: follower.recent(300) }));

async function bootstrap() {
  settings = settingsModule.load();
  // 先载入本机配置并按 frpc.toml 归档，再迁移 v1 单密码：
  // 这样“由 frpc.toml 派生出来的档案”也能拿到旧密码。
  paths = { ...paths, ...(await settingsModule.refreshPaths()) };
  loadConfigFromDisk();
  ensureClientServerProfile();
  migrateLegacyServerSecret();
  // 兜底：有档案但没有 activeServerId 时固定下来，避免每次启动都靠“取第一个”的隐式行为。
  if (!settings.activeServerId && settings.servers.length) {
    const fallback = findServerProfile(settings.clientServerId) || settings.servers[0];
    settings = settingsModule.save({ activeServerId: fallback.id });
  }
  follower.maxLines = Math.min(2000, Math.max(100, Number(settings.logBuffer) || 600));
  updateLogFile();
  manager = new FrpcManager({
    getSettings: () => settings,
    getPaths: () => paths,
    getConfig: () => model,
    ensureAdminConfig: async () => {
      const changed = configModule.ensureAdmin(model, settings);
      if (changed) {
        const saved = persistModel(model, { reload: false });
        if (!saved.ok) return { ok: false, error: saved.error || '无法写入管理 API 配置' };
      }
      return { ok: true, changed };
    },
    startService: async () => {
      const r = await service.startService(settings.serviceName);
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    },
    stopService: async () => {
      const r = await service.stopService(settings.serviceName);
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    },
  });
  manager.on('exit', (info) => {
    manager.refresh().catch(() => {});
    pushState();
    refreshTray();
    if (Date.now() > suppressExitUntil) {
      const unexpected = info && info.code !== 0;
      send('notify', {
        kind: unexpected ? 'error' : 'info',
        title: unexpected ? '隧道意外停止' : '隧道已停止',
        message: (info && info.error) || (info && info.code !== null ? `frpc 退出（代码 ${info.code}）` : ''),
      });
    }
  });
  follower.start();
  await refreshService({ detect: true });
  frpcVersion = await readFrpcVersion();
  elevated = await service.isElevated();
  await manager.refresh().catch(() => {});
  checkHealth().catch(() => {});
  startPolling();
  refreshTray();
  pushState();
}

const gotLock = app.requestSingleInstanceLock();

function focusMainWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/*
 * 第二道“唯一实例”防线。
 * requestSingleInstanceLock 的锁文件建在 userData 下，而 userData 会随启动方式变化
 * （安装版 → %LOCALAPPDATA%\frp-console；免安装/便携版 → exe 同级的 frp-console-data），
 * 两份副本各拿一把锁，就能同时开出两个控制台。
 * 这里再用一个固定端口的本地监听做跨数据目录的判定：先占到的那个才是唯一实例，
 * 后来的负责把已有窗口叫到前台然后自己退出。
 */
const INSTANCE_PORT = Number(process.env.FRP_INSTANCE_PORT) || 47823;
let instanceChannel = null;

function claimInstanceChannel() {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.on('data', () => focusMainWindow());
      socket.end('ok');
    });
    server.once('error', () => resolve(false));
    server.listen(INSTANCE_PORT, '127.0.0.1', () => {
      instanceChannel = server;
      if (server.unref) server.unref();
      resolve(true);
    });
  });
}

function notifyExistingInstance() {
  // 顺便握个手：对面回 "ok" 才说明占着端口的是自己人，否则可能只是别的程序。
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const socket = net.connect(INSTANCE_PORT, '127.0.0.1', () => socket.write('focus'));
      socket.setTimeout(700);
      socket.on('data', (chunk) => {
        done(String(chunk || '').includes('ok'));
        socket.end();
      });
      socket.on('timeout', () => {
        done(false);
        socket.destroy();
      });
      socket.on('error', () => done(false));
      socket.on('close', () => done(false));
    } catch {
      done(false);
    }
  });
}

function startApp() {
  app.whenReady().then(async () => {
    bootstrapReady = bootstrap().catch((e) => {
      send('notify', { kind: 'error', title: '初始化失败', message: e.message });
    });
    registerIpc();
    createWindow();
    createTray();
    // bootstrap() 第一句就同步载入 settings，这里可以安全读取启动偏好。
    if (settings.launchTunnelOnStart) {
      bootstrapReady
        .then(() => manager.start({ runMode: settings.runMode }))
        .then(() => manager.refresh())
        .then(() => pushState())
        .catch(() => {});
    }
    if (process.env.FRP_CONSOLE_SMOKE === '1') {
      setTimeout(() => {
        if (win && !win.isDestroyed()) win.webContents.executeJavaScript('JSON.stringify({views: document.querySelectorAll(".view").length, nodes: document.querySelectorAll(".view *").length, title: (document.querySelector(".hero-titles h2")||{}).textContent || "", status: (document.querySelector(".status-pill .label")||{}).textContent || "", nav: document.querySelectorAll(".nav-item").length, toast: document.querySelectorAll(".toast").length})').then((v) => console.log(`[smoke] ${v}`)).catch((e) => console.log(`[smoke] error ${e.message}`)).finally(() => { isQuitting = true; app.quit(); });
      }, 7000);
    }
    app.on('activate', () => {
      if (win) win.show();
    });
  });
}

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => focusMainWindow());

  claimInstanceChannel().then(async (claimed) => {
    if (claimed) {
      startApp();
      return;
    }
    // 端口被占：先确认对面是已经跑着的控制台（握手回 "ok"），是就聚焦它并退出；
    // 若只是别的程序临时占了这个端口，不能因此拒绝启动。
    const existing = await notifyExistingInstance();
    if (!existing) {
      startApp();
      return;
    }
    setTimeout(() => app.quit(), 250);
  });

  app.on('before-quit', () => {
    isQuitting = true;
    if (pollTimer) clearInterval(pollTimer);
    follower.stop();
    serverSession.disconnect();
    if (instanceChannel) {
      try {
        instanceChannel.close();
      } catch {
        /* ignore */
      }
    }
    if (manager && manager.isChildAlive) {
      try {
        manager.child.kill();
      } catch {
        /* ignore */
      }
    }
  });

  app.on('window-all-closed', () => {
    if (!tray) app.quit();
  });
}
