'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Tray, Menu, nativeImage, Notification } = require('electron');

app.setName('frp-console');
/* 和 package.json 的 build.appId 保持一致：Windows 靠它把通知、托盘气泡、
 * 任务栏图标归到同一个应用下。不一致时通知会被静默丢弃或挂到 electron 名下。 */
if (process.platform === 'win32') app.setAppUserModelId('cn.ysh.frp-console');

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
const { TrayPanel } = require('./tray-panel');
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
/* 自绘托盘面板（src/main/tray-panel.js）。右键时懒创建，之后复用。 */
let trayPanel = null;
/* 面板里每个 id 对应的动作，随状态刷新一起更新，避免闭包拿到旧设置。 */
let trayActions = {};
// 首次最小化到托盘只提示一次，免得每次关窗口都弹。
let trayHintShown = false;
// 当前托盘图标的色调，避免状态轮询里反复 setImage。
let trayToneCache = '';
// 系统是否真的把托盘图标显示出来了。Electron 在个别 Windows 上会出现
// 「Tray 对象创建成功，但 Shell_NotifyIcon 失败」（日志：notify_icon.cc
// Unable to create status tray icon），此时 getBounds() 全 0。
// 这种“假托盘”最危险：点 X 把窗口藏起来，用户却找不到图标，只能杀进程。
let trayUsable = true;
let trayProbeFails = 0;
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

/* --------------------------- 托盘 --------------------------- */

const TRAY_ICON = {
  online: 'tray-online.png',
  idle: 'tray-idle.png',
  error: 'tray-error.png',
};

function trayTone(runtime) {
  if (runtime.loginFailed || runtime.connectFailed) return 'error';
  if (runtime.loggedIn) return 'online';
  return 'idle';
}

function trayStatusLine(runtime) {
  if (runtime.loginFailed || runtime.connectFailed) return { label: '连不上服务器', tip: '连不上服务器' };
  if (runtime.loggedIn) return { label: '隧道在线', tip: `已连接 ${model ? `${model.serverAddr}:${model.serverPort}` : ''}`.trim() };
  if (runtime.mode === 'starting' || runtime.pending) return { label: '正在连接', tip: '正在连接服务器' };
  if (runtime.running) return { label: '隧道运行中（未登录）', tip: '隧道进程在跑，但还没登录上 frps' };
  return { label: '隧道未运行', tip: '未连接' };
}

function showMainWindow() {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function hideMainWindow() {
  if (!win || win.isDestroyed()) return;
  win.hide();
  hintTrayOnce();
}

function toggleMainWindow() {
  if (win && !win.isDestroyed() && win.isVisible() && !win.isMinimized()) hideMainWindow();
  else showMainWindow();
}

/* ------------------------- 开机自启 ------------------------- */
/*
 * 用 Electron 的 setLoginItemSettings：Windows 上就是在 HKCU\Software\Microsoft\
 * Windows\CurrentVersion\Run 里写一条记录，不碰系统服务，也不需要管理员权限。
 *
 * 三个坑：
 *  1) 开发模式下 process.execPath 是 electron.exe，必须把项目目录作为参数带上，
 *     否则登录后只会打开一个空白的 Electron 窗口。
 *  2) 便携版的 execPath 指向 %TEMP% 里解出来的副本，必须用 PORTABLE_EXECUTABLE_FILE
 *     指回用户双击的那个 exe，否则重启后路径就失效了。
 *  3) 用户在任务管理器里可以单独禁用启动项，所以「设置里开着」不等于「系统里生效」，
 *     对外一律以 getLoginItemSettings() 的结果为准。
 */
function loginItemOptions(enabled) {
  const opts = { openAtLogin: !!enabled };
  if (process.platform !== 'win32') return opts; // macOS/Linux 走各自默认实现
  if (process.env.PORTABLE_EXECUTABLE_FILE) {
    opts.path = process.env.PORTABLE_EXECUTABLE_FILE;
    opts.args = [];
  } else if (!app.isPackaged) {
    opts.path = process.execPath;
    opts.args = [app.getAppPath()];
  }
  return opts;
}

function launchAtLoginState() {
  try {
    // Windows 上查询必须带上和写入时相同的 path/args，否则永远查不到那条记录。
    const opts = loginItemOptions(true);
    const query = process.platform === 'win32'
      ? { ...(opts.path ? { path: opts.path } : {}), ...(opts.args ? { args: opts.args } : {}) }
      : {};
    return !!app.getLoginItemSettings(query).openAtLogin;
  } catch {
    return false;
  }
}

function applyLaunchAtLogin(enabled) {
  try {
    app.setLoginItemSettings(loginItemOptions(enabled));
  } catch (e) {
    return { ok: false, error: `写入开机启动项失败：${e.message || e}` };
  }
  const actual = launchAtLoginState();
  if (actual !== !!enabled) {
    // 组策略 / 安全软件拦截时设置会静默失败，别让界面显示成已开启
    return {
      ok: false,
      error: '系统拒绝了开机启动设置（可能被组策略或安全软件拦截），可以改用 shell:startup 文件夹里的快捷方式',
      actual,
    };
  }
  return { ok: true, actual };
}

/* 启动时对账：设置里开着但系统里没有（重装、移动目录、被任务管理器禁用过）就补写，
 * 设置里关着但系统里还留着就清掉。 */
function syncLaunchAtLogin() {
  if (!settings) return;
  const want = settings.launchAtLogin === true;
  if (want === launchAtLoginState()) return;
  const result = applyLaunchAtLogin(want);
  if (!result.ok) console.warn('[startup]', result.error);
}

/* 第一次“关到托盘”时告诉用户程序还在：否则大多数人会以为已经关掉了，
 * 然后在任务管理器里看到 FRP-Console 还在，误判成“关不掉”。 */
function hintTrayOnce() {
  if (trayHintShown || !tray) return;
  trayHintShown = true;
  tray.displayBalloon({
    title: 'FRP 控制台仍在后台运行',
    content: '隧道还在。右键托盘图标可以显示界面或完全退出。',
    iconType: 'info',
    noSound: true,
  });
}

/* 托盘菜单只在一处定义，两处消费：自绘面板（tray-panel.js）和原生菜单
 * （透明窗口建不出来时的兜底）。改菜单只改这里。 */
function trayMenuSpec(runtime) {
  const status = trayStatusLine(runtime);
  const iconTone = trayTone(runtime);
  const tone = iconTone === 'error' ? 'error' : runtime.mode === 'starting' || runtime.pending ? 'starting' : iconTone;
  const managed = settings.runMode !== 'service';
  const canStart = !runtime.loggedIn && !(manager && manager.isChildAlive);
  const canStop = !!(runtime.connected || (manager && manager.isChildAlive));
  const addr = model && model.serverAddr ? `${model.serverAddr}:${model.serverPort || 7000}` : '未配置服务器';
  const proxies = (model && model.proxies) || [];
  const onlineCount = proxies.filter((p) => {
    const st = manager && manager.proxyStatus.get(p.name);
    return st && st.status === 'running';
  }).length;

  const visible = !!(win && !win.isDestroyed() && win.isVisible());

  const sections = [
    [
      { id: 'win.show', label: '显示主界面', enabled: !(visible && !win.isMinimized()) },
      { id: 'win.hide', label: '隐藏到托盘', enabled: visible },
    ],
    [
      { id: 'tun.start', label: '启动隧道', enabled: canStart },
      { id: 'tun.stop', label: '停止隧道', enabled: canStop },
      { id: 'tun.restart', label: '重启隧道', enabled: !!runtime.running },
      { id: 'tun.reload', label: '热重载配置', enabled: !!runtime.connected },
    ],
    [
      { id: 'open.dashboard', label: '打开服务器面板', enabled: !!dashboardUrl() },
      { id: 'open.config', label: '打开 frpc.toml', enabled: !!paths.configPath },
      { id: 'open.logdir', label: '打开日志目录', enabled: !!paths.logPath },
    ],
    [
      { id: 'opt.closeToTray', label: '关闭窗口时最小化到托盘', checked: settings.closeToTray !== false },
      { id: 'opt.launchOnStart', label: '启动时自动连接隧道', checked: !!settings.launchTunnelOnStart },
    ],
    [
      {
        id: 'app.quit',
        label: '退出 FRP 控制台',
        kind: 'danger',
        tag: managed ? '并停掉托管隧道' : '',
      },
    ],
  ];

  const actions = {
    'win.show': () => showMainWindow(),
    'win.hide': () => hideMainWindow(),
    'tun.start': async () => {
      const result = await manager.start({ runMode: settings.runMode });
      notify(result.ok ? 'info' : 'error', result.ok ? '隧道已启动' : '启动失败', result.error || '');
      await manager.refresh().catch(() => {});
      pushState();
      refreshTray();
    },
    'tun.stop': async () => {
      suppressExitUntil = Date.now() + 12000;
      const result = await manager.stop({ runMode: settings.runMode });
      notify(result.ok ? 'info' : 'error', result.ok ? '隧道已停止' : '停止失败', result.error || '');
      await manager.refresh().catch(() => {});
      pushState();
      refreshTray();
    },
    'tun.restart': async () => {
      suppressExitUntil = Date.now() + 15000;
      const result = await manager.restart({ runMode: settings.runMode });
      notify(result.ok ? 'info' : 'error', result.ok ? '隧道已重启' : '重启失败', result.error || '');
      await manager.refresh().catch(() => {});
      pushState();
      refreshTray();
    },
    'tun.reload': async () => {
      const result = await manager.reload().catch((e) => ({ ok: false, error: e.message }));
      notify(result && result.ok ? 'info' : 'error', result && result.ok ? '配置已重载' : '重载失败', (result && result.error) || '');
      refreshTray();
    },
    'open.dashboard': () => shell.openExternal(dashboardUrl()),
    'open.config': () => revealPathSafe('config'),
    'open.logdir': () => revealPathSafe('log'),
    // 勾选状态以当前设置为准再取反：自绘面板和原生复选框都走这一条，不会因为
    // 两边的 item.checked 语义不同而出现“点一次不生效”。
    'opt.closeToTray': () => {
      settings = settingsModule.save({ closeToTray: settings.closeToTray === false });
      pushState();
      refreshTray();
    },
    'opt.launchOnStart': () => {
      settings = settingsModule.save({ launchTunnelOnStart: !settings.launchTunnelOnStart });
      pushState();
      refreshTray();
    },
    'app.quit': () => quitApp({ reason: 'tray' }),
  };

  return {
    tone,
    label: status.label,
    addr,
    proxyLine: proxies.length ? `${proxies.length} 个代理 · 在线 ${onlineCount}` : '还没有代理',
    sections,
    actions,
    mark: runtime.loggedIn ? '●' : runtime.loginFailed || runtime.connectFailed ? '✕' : runtime.mode === 'starting' || runtime.pending ? '◐' : '○',
  };
}

function panelModel(spec) {
  return {
    tone: spec.tone,
    label: spec.label,
    addr: spec.addr,
    proxyLine: spec.proxyLine,
    sections: spec.sections.map((section) => section.map(({ id, label, enabled, checked, kind, tag }) => ({
      id, label, enabled, checked, kind, tag,
    }))),
  };
}

function nativeTrayTemplate(spec) {
  const template = [
    { label: `${spec.mark} ${spec.label}`, enabled: false },
    { label: `    ${spec.addr} · ${spec.proxyLine}`, enabled: false },
  ];
  for (const section of spec.sections) {
    template.push({ type: 'separator' });
    for (const item of section) {
      const row = { label: item.label, enabled: item.enabled !== false, click: () => spec.actions[item.id] && spec.actions[item.id]() };
      if (typeof item.checked === 'boolean') {
        row.type = 'checkbox';
        row.checked = item.checked;
      }
      template.push(row);
    }
  }
  return template;
}

/* 右键托盘：优先弹自绘面板；面板建不出来（例如透明窗口被策略拦住）再退回原生菜单。 */
function openTrayPanel() {
  if (!tray) return;
  const runtime = manager
    ? runtimeView(manager.snapshot())
    : { running: false, connected: false, loggedIn: false, loginFailed: false, connectFailed: false, mode: 'stopped' };
  const spec = trayMenuSpec(runtime);
  trayActions = spec.actions;
  try {
    if (!trayPanel) {
      trayPanel = new TrayPanel({
        preloadPath: path.join(__dirname, 'tray-preload.js'),
        rendererPath: path.join(__dirname, '..', 'renderer', 'tray.html'),
        onInvoke: (id) => {
          const fn = trayActions[id];
          if (fn) fn();
        },
      });
    }
    let bounds = null;
    try { bounds = tray.getBounds(); } catch { bounds = null; }
    trayPanel.open(panelModel(spec), bounds).catch(() => {
      try { tray.popUpContextMenu(Menu.buildFromTemplate(nativeTrayTemplate(spec))); } catch { /* ignore */ }
    });
  } catch (e) {
    console.warn('[tray] 自绘面板不可用，回退原生菜单', e && e.message);
    try { tray.popUpContextMenu(Menu.buildFromTemplate(nativeTrayTemplate(spec))); } catch { /* ignore */ }
  }
}

function revealPathSafe(which) {
  const target = which === 'log' ? paths.logPath : which === 'config' ? paths.configPath : paths.frpcPath;
  if (!target) return;
  try {
    shell.showItemInFolder(target);
  } catch {
    /* ignore */
  }
}

// 只有托盘真的可见，才允许把窗口收进去。
function canHideToTray() {
  return !!tray && trayUsable;
}

/* 托盘自检：系统没给图标分配屏幕位置就说明它其实没显示出来。
 * 连续三次（约 9 秒）都拿不到位置才下结论，避免把「图标被折叠进 ^ 溢出面板」误判成故障。
 * 一旦判定不可用，就把已经藏起来的窗口叫回来——绝不能把用户锁在界面外面。 */
function probeTray() {
  if (!tray || tray.isDestroyed()) return;
  let shown = true;
  try {
    const b = tray.getBounds();
    shown = !!(b && b.width > 0 && b.height > 0);
  } catch {
    shown = true; // 平台不支持 getBounds 时不干预
  }
  if (shown) {
    trayProbeFails = 0;
    if (!trayUsable) { trayUsable = true; refreshTray(); }
    return;
  }
  trayProbeFails += 1;
  if (trayProbeFails < 3 || !trayUsable) return;
  trayUsable = false;
  console.warn('[tray] 系统未显示托盘图标（getBounds 全 0），关闭窗口将直接退出而不是收进托盘');
  if (win && !win.isDestroyed() && !win.isVisible()) showMainWindow();
  refreshTray();
}

function refreshTray() {
  probeTray();
  if (!tray || !settings) return;
  const runtime = manager
    ? runtimeView(manager.snapshot())
    : { running: false, connected: false, loggedIn: false, loginFailed: false, connectFailed: false, mode: 'stopped' };
  const status = trayStatusLine(runtime);
  tray.setToolTip(`FRP 控制台 · ${status.tip}`);

  const tone = trayTone(runtime);
  // 图标别每 3 秒重建一次；只有色调变了才换图。
  if (tone !== trayToneCache) {
    const file = iconPath(TRAY_ICON[tone]);
    if (file) {
      const img = nativeImage.createFromPath(file);
      if (!img.isEmpty()) {
        tray.setImage(img);
        trayToneCache = tone;
      }
    }
  }

  // 面板开着的时候状态还会变（隧道起来、在线数变化），直接推一份新的进去，
  // 不用关掉重开；重建 12 行 DOM 比维护签名便宜，也不会漏字段。
  const spec = trayMenuSpec(runtime);
  trayActions = spec.actions;
  if (trayPanel && trayPanel.isOpen()) {
    trayPanel.refresh(panelModel(spec)).catch(() => {});
  }
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
    // 托盘都没建出来时不能真的静默启动，否则窗口永远叫不出来。
    if (!settings.startMinimized || !canHideToTray()) win.show();
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
    if (isQuitting) return; // 走退出流程，正常销毁
    // 没有托盘就不能藏：藏了就再也找不回来，只能杀进程。
    if (settings.closeToTray === false || !canHideToTray()) return;
    event.preventDefault();
    win.hide();
    hintTrayOnce();
    refreshTray();
  });
  win.on('show', () => refreshTray());
  win.on('hide', () => refreshTray());
  win.on('minimize', () => refreshTray());
  win.on('restore', () => refreshTray());
  win.on('closed', () => {
    win = null;
  });
}

function createTray() {
  /* 没图标就当没有托盘。这一条很关键：closeToTray 打开、但托盘又创建不出来时，
   * 点 X 会把窗口藏起来且再也叫不回来，用户只能去任务管理器杀进程——
   * 这正是“程序关不掉”的来源。下面 close 事件会按 tray 是否存在决定要不要拦截。 */
  const icon = iconPath(TRAY_ICON.idle) || iconPath('tray.png') || iconPath('icon.png');
  if (!icon) {
    tray = null;
    return false;
  }
  try {
    tray = new Tray(icon);
  } catch {
    tray = null;
    return false;
  }
  tray.setToolTip('FRP 控制台');
  // 单击切换显示/隐藏（Windows 习惯），双击直接叫到前台
  tray.on('click', () => toggleMainWindow());
  tray.on('double-click', () => showMainWindow());
  tray.on('balloon-click', () => showMainWindow());
  // 右键不交给系统菜单，弹自绘面板（样式和主界面一致）
  tray.on('right-click', () => openTrayPanel());
  refreshTray();
  return true;
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
  // 顺序有讲究：Token 相关的报错里也常带 “failed”，先判鉴权再判网络。
  if (/authorization failed|token in login|doesn't match|authentication failed|invalid token/i.test(text)) return 'auth';
  if (/actively refused|ECONNREFUSED|拒绝/i.test(text)) return 'refused';
  if (/proxy|StatusCode|50[234]/i.test(text)) return 'proxy';
  if (/timeout|timed out|unreachable|ECONNRESET|network is unreachable|EOF|no such host|NXDOMAIN/i.test(text)) return 'unreachable';
  return 'unknown';
}

const CONNECT_FAIL_RE = /connect to server error|login to (?:the )?server failed|authorization failed|token in login|doesn't match|DialTcp|proxy connect/i;

// 去掉行首时间戳和 [I] [client/xxx.go:298] 前缀，同一错误重试时字符串不变，避免整页重绘。
function cleanProblemText(raw) {
  return String(raw || '')
    .replace(/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+\s*/, '')
    .replace(/^\[[A-Z]\]\s*\[[^\]]*\]\s*/, '')
    .trim();
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
  let fileProblem = null;
  for (let i = lines.length - 1; i >= floor; i -= 1) {
    const text = String((lines[i] && lines[i].text) || '');
    if (!text) continue;
    // 先遇到“登录/代理成功”说明之前的失败已经翻篇了，别把旧错误当现状。
    if (/login to (?:the )?server success|start proxy success/i.test(text)) return null;
    if (!CONNECT_FAIL_RE.test(text)) continue;
    const clean = cleanProblemText(text);
    fileProblem = { text: clean.slice(0, 200), kind: connectProblemKind(clean) };
    break;
  }
  if (fileProblem && fileProblem.kind !== 'unknown') return fileProblem;

  /* 再补一刀：看 frpc 进程自己的输出。
   * loginFailExit = true 时 frpc 连不上就直接退出，而且**连日志文件都不会创建**，
   * 唯一的原因只出现在子进程的 stdout/stderr 里（lastExit 存了最后几行）。
   * 只看日志文件的话，这种最常见的失败永远判不出来。
   * stdoutTail 每次 spawn 都会清空，所以不会把上一次启动的残留当现状。 */
  if (manager) {
    const tail = [
      manager.lastExit && manager.lastExit.error,
      manager.stderrTail,
      manager.stdoutTail,
    ].filter(Boolean).join('\n');
    const hit = tail.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).reverse()
      .find((line) => CONNECT_FAIL_RE.test(line));
    if (hit) {
      const clean = cleanProblemText(hit);
      return { text: clean.slice(0, 200), kind: connectProblemKind(clean) };
    }
  }
  return fileProblem;
}

function runtimeView(runtime) {
  const apiOk = !!runtime.connected;
  const declared = model ? (model.proxies || []).length : 0;
  const registered = manager ? manager.proxyStatus.size : 0;
  /* 只在“本该连着”的时候去翻失败记录：
   * 隧道是活的（进程/服务/API 任一在），或者刚异常退出（lastExit.error 非空）。
   * 否则用户明明是手动停掉的，hero 却因为日志缓冲里那几行旧报错继续显示“连不上服务器”。 */
  const logsRelevant = !!runtime.running || !!(runtime.lastExit && runtime.lastExit.error);
  const problem = logsRelevant ? lastConnectProblem() : null;
  /* 注意：frpc 的管理 API 在自己连不上 frps 时照样回 200，只是返回空表。
   * 所以“API 可达”不等于“已登录 frps”。判定分两路：
   *   1) 日志/子进程输出里抓到了明确的连接失败（problem）；
   *   2) 配置里明明有代理，但 /api/status 里一个都没注册上——这条比日志更可靠，
   *      因为登录失败时 frpc 可能根本不建日志文件（loginFailExit=true 直接退出），
   *      或者用户把 log.to 指到了别处，此时只剩这一条线索。 */
  const notRegistered = declared > 0 && registered === 0;
  // 刚拉起的一两秒内代理还没注册，别急着报错，否则启动瞬间会闪一下红色。
  const settled = !runtime.childStartedAt || Date.now() - runtime.childStartedAt > 6000;
  const loginFailed = apiOk && notRegistered && (!!problem || settled);
  const detected = !!problem && problem.kind !== 'unknown';
  // 有“没注册上”的结论、却抓不到具体报错文本：照样要报出来，只是原因说不细。
  const unconfirmed = loginFailed && !detected;
  return {
    ...runtime,
    loggedIn: apiOk && !loginFailed,
    loginFailed,
    // 管理 API 通了、但代理还没注册上，且还没到判定超时的时候：这叫“正在登录”，别急着报错。
    pending: apiOk && notRegistered && !loginFailed,
    // 连不上服务器（不管 frpc 进程还在不在：loginFailExit=true 时它会直接退出）
    connectFailed: detected || unconfirmed,
    connectError: detected ? problem.text : unconfirmed ? '管理 API 可达，但服务器上没有任何代理注册成功' : '',
    connectKind: detected ? problem.kind : unconfirmed ? 'unconfirmed' : '',
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
      // 设置页据此提示“关闭窗口会不会真退出”
      tray: canHideToTray(),
      trayCreated: !!tray,
      // 系统里的真实开机启动状态（用户可能在任务管理器里手动关掉过）
      launchAtLogin: launchAtLoginState(),
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
  } catch (e) {
    // 轮询出错不打断下一次，但调试时要看得见，否则菜单/状态出问题会完全无声。
    if (process.env.FRP_CONSOLE_DEBUG) console.warn('[tick]', e && e.stack ? e.stack.split('\n')[0] : e);
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
  // 还没填服务器地址时，隧道和公网两层必然不通，检查出来全是红色异常，
  // 反而让第一次打开的人以为自己配错了。等用户在设置里填好再开始算。
  if (!model.serverAddr) {
    healthCache.clear();
    return;
  }
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

/* 启动隧道前必须先满足的前提。返回空串表示可以启动。
 * 首次安装时 frpc.exe 与服务器地址都可能还没有，这时给一句人话，
 * 而不是把 spawn EPERM 抛到界面上。 */
function tunnelPrerequisiteError() {
  if (!paths.frpcPath || !fs.existsSync(paths.frpcPath)) {
    return '还没找到 frpc.exe：把它放到本程序同目录，或在「设置 → 可执行文件与路径」里指定位置';
  }
  if (!model || !model.serverAddr) {
    return '还没填服务器地址：到「设置 → 服务器连接」填上你自己的 frps 地址，保存后再启动';
  }
  return '';
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
        // 让渲染层一开始就能画出正确的“最大化 / 还原”字形
        maximized: !!(win && !win.isDestroyed() && win.isMaximized()),
        // 托盘是否真的建出来了。建不出来时界面要提示：这时“关闭窗口”会直接退出，
        // 而不是像往常那样收进托盘（否则窗口会消失且叫不回来）。
        tray: canHideToTray(),
        trayCreated: !!tray,
        launchAtLogin: launchAtLoginState(),
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
      'stripProxyEnv', 'launchAtLogin',
    ];
    const clean = {};
    for (const key of allowed) if (patch && Object.prototype.hasOwnProperty.call(patch, key)) clean[key] = patch[key];
    // 开机自启要真的写进系统，写不进去就别保存，免得界面显示“已开启”但重启无效。
    if (clean.launchAtLogin !== undefined) {
      const result = applyLaunchAtLogin(!!clean.launchAtLogin);
      if (!result.ok) return fail(result.error);
      clean.launchAtLogin = !!result.actual;
    }
    if (clean.pollIntervalMs) clean.pollIntervalMs = Math.min(30000, Math.max(1000, Number(clean.pollIntervalMs) || 3000));
    if (clean.adminPort) clean.adminPort = Math.min(65535, Math.max(1, Number(clean.adminPort) || 7400));
    if (clean.logBuffer) clean.logBuffer = Math.min(2000, Math.max(100, Number(clean.logBuffer) || 600));
    // 日志缓冲上限要立刻作用到正在跑的 LogFollower，否则要等下次启动才生效。
    if (clean.logBuffer) {
      follower.maxLines = clean.logBuffer;
      if (follower.lines.length > follower.maxLines) follower.lines.splice(0, follower.lines.length - follower.maxLines);
    }
    if (clean.runMode && !['auto', 'service', 'managed'].includes(clean.runMode)) delete clean.runMode;
    if (clean.configPath !== undefined) {
      const wanted = String(clean.configPath || '').trim();
      // 填了但文件不存在就直接报错。否则 refreshPaths 会悄悄换回旧路径，
      // 用户以为“保存成功了”，实际用的还是另一个配置文件。
      if (wanted && !fs.existsSync(wanted)) return fail(`配置文件不存在：${wanted}`);
    }
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
    /* 还没配好就直接 spawn，只会弹出 "spawn EPERM" 这种没人看得懂的错误，
     * 所以先在主进程里把缺的前提说清楚。 */
    const missing = tunnelPrerequisiteError();
    if (missing) return fail(missing, { state: buildState() });
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
    return ok({ listeners: result.listeners, processError: result.processError || '' });
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
    } else if (action === 'hide') {
      // 没有托盘就别藏，否则窗口再也叫不回来。
      if (!canHideToTray()) return fail('托盘不可用，无法隐藏窗口');
      win.hide();
      hintTrayOnce();
    } else if (action === 'show') {
      showMainWindow();
    } else if (action === 'close') win.close();
    refreshTray();
    return ok({ maximized: win.isMaximized(), visible: win.isVisible() });
  });

  ipcMain.handle('app:quit', async () => {
    // 不在这里直接 app.quit()：统一交给 quitApp，保证托管隧道先停干净。
    quitApp({ source: 'renderer' });
    return ok({ quitting: true });
  });

  // 排障用：托盘到底建出来没有、窗口是显示还是收起来了、退出流程走到哪一步。
  // 设置页会把它显示出来，也方便自动化测试断言。
  ipcMain.handle('app:tray-state', async () => ok({
    tray: !!tray,
    usable: canHideToTray(),
    bounds: (() => { try { return tray && !tray.isDestroyed() ? tray.getBounds() : null; } catch { return null; } })(),
    tone: trayToneCache || '',
    windowVisible: !!(win && !win.isDestroyed() && win.isVisible()),
    windowDestroyed: !win || win.isDestroyed(),
    closeToTray: settings ? settings.closeToTray !== false : null,
    quitting: quitFlowStarted,
    pid: process.pid,
  }));

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

/* 首次运行（哪儿都找不到 frpc.toml）时给一份能直接改的模板：服务器地址留空，
 * 只带一条 Windows-RDP 代理。新手不用从零写 TOML，包里也不会夹带任何人的服务器。
 * 只生成一次：用户之后自己删掉，也不会再冒出来。 */
const STARTER_CONFIG = [
  '# FRP 控制台生成的默认配置。',
  '# 把 serverAddr / auth.token 换成你自己服务器的，再到「设置 → 服务器连接」点「保存并重启」。',
  'serverAddr = ""',
  'serverPort = 7000',
  'loginFailExit = false',
  '',
  'auth.method = "token"',
  'auth.token = ""',
  '',
  'log.to = "./frpc.log"',
  'log.level = "info"',
  '',
  '[[proxies]]',
  'name = "Windows-RDP"',
  'type = "tcp"',
  'localIP = "127.0.0.1"',
  'localPort = 3389',
  'remotePort = 13389',
  '',
].join('\n');

function ensureStarterConfig() {
  if (paths.configPath && fs.existsSync(paths.configPath)) return false;
  if (settings.starterConfigCreated) return false;
  // 优先放在 frpc.exe 同目录（和 frp 官方压缩包的习惯一致）；不可写时退回数据目录。
  const candidates = [];
  if (paths.frpcPath) candidates.push(path.join(path.dirname(paths.frpcPath), 'frpc.toml'));
  candidates.push(path.join(settingsModule.dataDir(), 'frpc.toml'));
  for (const file of candidates) {
    try {
      settingsModule.ensureDir(path.dirname(file));
      // wx：已存在就不覆盖。撞上了就换下一个位置。
      fs.writeFileSync(file, STARTER_CONFIG, { encoding: 'utf8', flag: 'wx' });
    } catch {
      continue;
    }
    settings = settingsModule.save({ configPath: file, starterConfigCreated: true });
    paths = { ...paths, configPath: file };
    return true;
  }
  return false;
}

async function bootstrap() {
  settings = settingsModule.load();
  // 先载入本机配置并按 frpc.toml 归档，再迁移 v1 单密码：
  // 这样“由 frpc.toml 派生出来的档案”也能拿到旧密码。
  paths = { ...paths, ...(await settingsModule.refreshPaths()) };
  ensureStarterConfig();
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
      // 判“意外”看的是有没有错误文本，而不是退出码：
      // 用户主动停止时 frpc 可能返回 1（停止时代理还没登录上），那不是故障。
      const unexpected = !!(info && info.error);
      send('notify', {
        kind: unexpected ? 'error' : 'info',
        title: unexpected ? '隧道意外停止' : '隧道已停止',
        message: (info && info.error) || 'frpc 已退出',
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

/* ------------------------- 退出流程（唯一入口） -------------------------
 * 以前退出就是一句 app.quit()：before-quit 里 child.kill() 是异步的，主进程往往
 * 先没了，frpc 变成孤儿继续跑；托盘点“退出”看起来关了，任务管理器里还剩一堆。
 * 现在统一走这里：先优雅停掉“控制台自己拉起的”frpc，再放行 app.quit()，
 * 最后还有 8 秒硬超时兜底（app.exit 不触发任何事件，一定能退）。
 */
let quitFlowStarted = false;
let quitAllowed = false;

async function quitApp({ source = 'user' } = {}) {
  if (quitAllowed) return;
  if (quitFlowStarted) return; // 正在退，别重复
  quitFlowStarted = true;
  isQuitting = true;

  const hardExit = setTimeout(() => {
    // eslint-disable-next-line no-console
    console.log(`[quit] ${source} 清理超时，强制退出`);
    app.exit(0);
  }, 8000);
  if (hardExit.unref) hardExit.unref();

  try {
    if (pollTimer) clearInterval(pollTimer);
    follower.stop();
  } catch { /* ignore */ }

  try {
    /* 只停“控制台自己拉起来的” frpc。系统服务模式下去停服务是越权行为：
     * 那是用户单独安装的常驻隧道，关掉控制台不该把它带下来。 */
    if (manager && manager.isChildAlive) {
      await Promise.race([
        manager.stop({ runMode: settings.runMode }).catch(() => ({ ok: false })),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    }
  } catch { /* ignore */ }

  if (manager && manager.isChildAlive) {
    try { manager.child.kill(); } catch { /* ignore */ }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  try { serverSession.disconnect(); } catch { /* ignore */ }
  if (instanceChannel) {
    try { instanceChannel.close(); } catch { /* ignore */ }
    instanceChannel = null;
  }
  if (tray) {
    try { tray.destroy(); } catch { /* ignore */ }
    tray = null;
  }

  clearTimeout(hardExit);
  quitAllowed = true;
  app.quit();
  // 双保险：quit 之后若还活着（有窗口阻止关闭），2 秒后直接 exit
  setTimeout(() => app.exit(0), 2000).unref?.();
}

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
    // 先建托盘再建窗口：ready-to-show 里要判断“托盘是否可用”来决定能不能静默启动。
    createTray();
    createWindow();
    // 系统里的启动项和设置对不上时补一次（重装、移动目录、被任务管理器禁用过）
    syncLaunchAtLogin();
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
        if (win && !win.isDestroyed()) win.webContents.executeJavaScript('JSON.stringify({views: document.querySelectorAll(".view").length, nodes: document.querySelectorAll(".view *").length, title: (document.querySelector(".hero-titles h2")||{}).textContent || "", status: (document.querySelector(".status-pill .label")||{}).textContent || "", nav: document.querySelectorAll(".nav-item").length, toast: document.querySelectorAll(".toast").length})').then((v) => console.log(`[smoke] ${v}`)).catch((e) => console.log(`[smoke] error ${e.message}`)).finally(() => { quitAllowed = true; app.quit(); });
      }, 7000);
    }
    /* 托盘右键没法用脚本点，只能真机试；打开这个开关会在启动后直接弹一次面板，
     * 配合 --remote-debugging-port 截图核对样式与点击回传。 */
    if (process.env.FRP_TRAY_PANEL_SMOKE === '1') {
      setTimeout(() => openTrayPanel(), 3500);
    }
    app.on('activate', () => {
      if (win) win.show();
    });
  });
}

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 已经有一个在跑：把它的窗口叫出来，本进程立刻退出（不会留下第二个托盘图标）。
    focusMainWindow();
    refreshTray();
  });

  claimInstanceChannel().then(async (claimed) => {
    if (claimed) {
      startApp();
      return;
    }
    // 端口被占：先确认对面是已经跑着的控制台（握手回 "ok"），是就聚焦它并退出；
    // 若只是别的程序临时占了这个端口，不能因此拒绝启动。
    // 重试 3 次：对面可能正在启动/正在退出的半路上，单次 700ms 的超时容易误判成“没人”，
    // 于是第二个实例也起来了——这正是“莫名其妙开了两个”的来源。
    let existing = false;
    for (let i = 0; i < 3 && !existing; i += 1) {
      existing = await notifyExistingInstance();
      if (!existing) await new Promise((resolve) => setTimeout(resolve, 350));
    }
    if (!existing) {
      startApp();
      return;
    }
    // 第二个实例必须干净退场：不建窗口、不建托盘、不碰隧道。
    quitAllowed = true;
    setTimeout(() => app.exit(0), 250);
  });

  app.on('before-quit', (event) => {
    /* 无论从哪来（托盘、界面按钮、系统关机），都收敛到同一条退出流程：
     * 先停托管隧道，再真正退出。quitAllowed 由 quitApp 在清理完成后置位；
     * 没置位就拦下来去做清理，否则主进程先走、frpc 变孤儿——看起来就是“关不干净”。 */
    if (!quitAllowed) {
      event.preventDefault();
      quitApp({ source: 'before-quit' });
      return;
    }
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
  });

  /* 窗口全没了就该退干净。
   * 有托盘时窗口只会被 hide（close 事件被拦），这个回调根本不会触发；
   * 能走到这里的只有两种情况：① 托盘不可用；② 用户关掉了“关闭窗口时最小化到托盘”。
   * 两种都意味着“用户以为关了”，所以必须真的退出，不能留个托盘图标在后台。 */
  app.on('window-all-closed', () => {
    quitAllowed = false; // 让 before-quit 走一遍完整清理
    app.quit();
  });
}
