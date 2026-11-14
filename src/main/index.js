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
const frpsBinary = require('./frpsBinary');
const updateModule = require('./update');
const { AcmeManager, coversDomain, readCertCoverage } = require('./acme');
const { CloudflareDns } = require('./dns');
const { execFileP, tcpCheck, httpProbe, hashText, randomToken, formatDuration } = require('./util');

const assetsDir = path.join(__dirname, '..', '..', 'assets');
const preloadPath = path.join(__dirname, 'preload.js');
const rendererPath = path.join(__dirname, '..', 'renderer', 'index.html');

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
const acmeManager = new AcmeManager({ userDataDir: settingsModule.dataDir() });

/* 当前 DNS 验证渠道（现阶段只有 Cloudflare）。证书签发 / 自动续期共用。 */
function currentDnsProvider() {
  const provider = String(settings.dnsProvider || '').trim().toLowerCase();
  if (provider === 'cloudflare') {
    const token = settingsModule.readCloudflareToken();
    if (!token) return { ok: false, error: '尚未配置 Cloudflare API token' };
    return { ok: true, dns: new CloudflareDns({ token }) };
  }
  return { ok: false, error: '尚未配置 DNS 验证渠道（当前仅支持 Cloudflare）' };
}
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
    /* Token 只是这台机器和它自己的 frps 之间的共享密钥，和 frpc.toml 里的明文
     * 是同一个值（「高级编辑」里本来就看得见）。给渲染层是为了让「服务端配置
     * 向导」默认就用这个值，服务端和客户端天然一致，用户不用手抄。 */
    token: profile.clientToken || '',
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
  /* 本机配置指向的这台服务器，本机到底还有没有档案记录？和「绑定」是两件事：
   * 档案在、只是没绑到隧道上（matchProfileName 非空）和档案根本没了好
   * （都被删了）要说不同的话，否则用户会以为自己的档案被误删。 */
  const match = addr
    ? (serverProfiles().find((item) => item.host.toLowerCase() === addr.toLowerCase() && Number(item.clientPort) === port)
      || serverProfiles().find((item) => item.host.toLowerCase() === addr.toLowerCase()))
    : null;
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
    matchProfileId: match ? match.id : '',
    matchProfileName: match ? match.name : '',
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
 *  3) 用户在任务管理器里禁用启动项时，Windows 不删 Run 键，而是在
 *     Explorer\StartupApproved\Run 里把状态改成「已禁用」。所以只看 openAtLogin
 *     会得到「已开启」的假象——必须再看 executableWillLaunchAtLogin / launchItems。
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

function sameExe(a, b) {
  if (!a || !b) return false;
  try {
    return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  } catch {
    return String(a).toLowerCase() === String(b).toLowerCase();
  }
}

/* 返回 { registered, enabled, blocked, error }：
 *   registered  启动项存在（Run 键里有）
 *   enabled     重启后真的会启动（没被任务管理器禁用）
 *   blocked     已注册但被禁用——这正是「设置里显示开着、重启却不启动」的原因 */
function launchAtLoginSnapshot() {
  const opts = loginItemOptions(true);
  const query = process.platform === 'win32'
    ? { ...(opts.path ? { path: opts.path } : {}), ...(opts.args ? { args: opts.args } : {}) }
    : { path: undefined, args: undefined };
  let result;
  try {
    // Windows 上查询必须带上和写入时相同的 path/args，否则永远查不到那条记录。
    result = app.getLoginItemSettings(process.platform === 'win32' ? query : {});
  } catch (e) {
    return { registered: false, enabled: false, blocked: false, error: String((e && e.message) || e) };
  }
  if (process.platform !== 'win32') {
    const on = !!result.openAtLogin;
    return { registered: on, enabled: on, blocked: false, error: '' };
  }
  const registered = !!result.openAtLogin;
  if (!registered) return { registered: false, enabled: false, blocked: false, error: '' };
  // launchItems 里带 enabled，是唯一能反映「任务管理器里被禁用」的字段。
  const items = Array.isArray(result.launchItems) ? result.launchItems : [];
  const mine = items.find((item) => sameExe(item && item.path, opts.path)) || (items.length === 1 ? items[0] : null);
  let enabled;
  if (mine && typeof mine.enabled === 'boolean') enabled = mine.enabled;
  else if (typeof result.executableWillLaunchAtLogin === 'boolean') enabled = result.executableWillLaunchAtLogin;
  else enabled = registered;
  return { registered: true, enabled, blocked: !enabled, error: '' };
}

function launchAtLoginState() {
  return launchAtLoginSnapshot().enabled;
}

function applyLaunchAtLogin(enabled) {
  try {
    app.setLoginItemSettings(loginItemOptions(enabled));
  } catch (e) {
    return { ok: false, error: `写入开机启动项失败：${e.message || e}` };
  }
  const state = launchAtLoginSnapshot();
  if (!!enabled && state.blocked) {
    return {
      ok: false,
      blocked: true,
      actual: false,
      error: '启动项已写入系统，但它在「任务管理器 → 启动」里处于“已禁用”，重启后不会运行。请到那里把它设为“已启用”。',
    };
  }
  if (state.enabled !== !!enabled) {
    // 组策略 / 安全软件拦截时设置会静默失败，别让界面显示成已开启
    return {
      ok: false,
      actual: state.enabled,
      error: '系统拒绝了开机启动设置（可能被组策略或安全软件拦截），可以改用 shell:startup 文件夹里的快捷方式',
    };
  }
  return { ok: true, actual: state.enabled };
}

/* 启动时对账：设置里开着但系统里没有（重装、移动目录）就补写，
 * 设置里关着但系统里还留着就清掉。
 * 任务管理器里被禁用的，尊重用户的选择：把设置也关掉，不再偷偷加回去。 */
function syncLaunchAtLogin() {
  if (!settings) return;
  const want = settings.launchAtLogin === true;
  const state = launchAtLoginSnapshot();
  if (want && state.blocked) {
    settings = settingsModule.save({ launchAtLogin: false });
    console.warn('[startup] 启动项被用户在任务管理器里禁用，已把设置同步为关闭');
    return;
  }
  if (want === state.enabled) return;
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
    // 管理端口被别的 frpc 占着：状态、代理列表、停止操作都不能当真
    foreign: !!runtime.foreign,
    adminConflict: runtime.foreign ? `管理端口 ${runtime.adminPort || 7400} 上的 frpc 不是本配置启动的` : '',
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
    // 管理端口上是别人的 frpc 时，它报的代理状态与本配置无关，一律当作没同步
    const st = runtime.foreign ? null : manager.proxyStatus.get(proxy.name) || null;
    const health = healthCache.get(proxy.name) || null;
    return {
      ...proxy,
      publicAddress: configModule.publicAddressFor(model, proxy, settings),
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
      // 启动项写进去了但被任务管理器禁用：界面要能把这句话说出来，
      // 否则用户看到“已开启”却在重启后发现没启动。
      launchAtLoginBlocked: launchAtLoginSnapshot().blocked,
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
      /* 只有“隧道状态 running 且三层检查真的通过”才算在线。
       * 以前 `!p.health || p.health.ok` 把“还没检查”也当成在线，
       * 结果是刚启动、或健康检查被卡住时，坏代理照样报绿。 */
      const fresh = (p) => !!p.health && Date.now() - (p.health.at || 0) < 90000;
      const verified = proxies.filter(fresh);
      const failed = verified.filter((p) => !p.health.ok);
      // 按失败的层级拆开计数：概览页据此说“是本地服务、隧道还是公网不通”，
      // 而不是笼统一句“未通过三层检查”，把人骗去查本地端口。
      const layerFailed = (name) => failed.filter((p) => p.health.layers && p.health.layers[name] && !p.health.layers[name].ok).length;
      return {
        total: proxies.length,
        online: verified.filter((p) => p.health.ok && p.status === 'running').length,
        unhealthy: failed.length,
        // 这一轮还没测完（或代理刚加进来）的条数：界面上既不能说在线也不能说异常
        unchecked: proxies.length - verified.length,
        unhealthyLocal: layerFailed('local'),
        unhealthyTunnel: layerFailed('tunnel'),
        unhealthyPublic: layerFailed('public'),
      };
    })(),
    dashboardUrl: dashboardUrl(),
    /* 本机 frpc.toml 与「隧道目标档案」的绑定情况。渲染层据此识别一种很容易骗人的状态：
     * 隧道确实在跑、三层也确实通（frpc 还在连那台服务器），但这台服务器在本机已经
     * 没有档案了 —— 概览不能继续报"一切正常"。 */
    binding: tunnelBindingView(),
    logs: { count: follower.lines.length, last: follower.lines.length ? follower.lines[follower.lines.length - 1].ts : 0 },
  };
}

function settingsForState() {
  const { windowBounds, servers, ...rest } = settings;
  // 档案里的 Token 只在主进程使用，渲染层只需要“有没有”。
  return {
    ...rest,
    servers: (servers || []).map(({ clientToken, ...item }) => ({ ...item, hasToken: !!clientToken })),
    // DNS 验证凭据同理：token 只留在主进程，界面只要“配没配”。
    dnsHasToken: settingsModule.hasCloudflareToken(),
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
  if (!model || !model.serverAddr) return '';
  // 服务器页读到的 frps Dashboard 端口优先（真机常改端口，7500 只是兜底默认）。
  const webPort = (serverConfig.summary && serverConfig.summary.webPort) || 0;
  return `http://${model.serverAddr}:${webPort || 7500}`;
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

/* 轮询里的每一步都单独兜住，谁出错都不许拖累别人。
 *
 * 以前是顺序 await，只要 service 查询抛一次（sc.exe 被安全软件拦、权限不足、
 * 服务名被改），后面的 manager.refresh() 就永远轮不到执行 —— 隧道状态定格在
 * 上一次的"全绿"，用户看到的就是"我都删了服务器，它还显示联通"。 */
async function tickStep(name, fn) {
  try {
    return await fn();
  } catch (e) {
    if (process.env.FRP_CONSOLE_DEBUG) console.warn(`[tick] ${name}`, e && e.stack ? e.stack.split('\n')[0] : e);
    return undefined;
  }
}

async function tick({ force = false } = {}) {
  if (tickBusy && !force) return;
  tickBusy = true;
  try {
    await tickStep('checkExternalConfig', checkExternalConfig);
    // 先刷隧道真实状态：它决定了界面"通不通"，优先级高于服务托管信息
    await tickStep('manager.refresh', () => manager.refresh());
    if (Date.now() - lastServiceCheck > 3800 || force) {
      lastServiceCheck = Date.now();
      await tickStep('refreshService', () => refreshService({ detect: false }));
    }
    /* 管理端口上跑的是别人的 frpc 时，本配置的隧道根本没在工作：
     * 继续做三层检查只会把每条代理都刷成“隧道未建立”，把真正的原因
     * （端口冲突）淹掉。这时保留上一次结果并停止探测，等端口冲突解决了再查。 */
    const foreignNow = !!manager.snapshot().foreign;
    if (!healthBusy && !foreignNow && Date.now() - (tick.lastHealth || 0) > 14000 && model && model.proxies.length) {
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

/* 一轮健康检查最多同时探测几条、总共花多久。
 * 以前写死“只查前 16 条”，第 17 条之后的代理永远拿不到结果，
 * 坏掉的代理会一直显示在线（概览还会说“全部三层全通”）；
 * 但也不能把几百条代理一次性全丢进去，同一瞬间开上百个 socket。 */
const HEALTH_CONCURRENCY = 6;
const HEALTH_BUDGET_MS = 7000;

/* 判断一个字符串是不是 IPv4 字面量。 */
function isIpLike(text) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(String(text || '').trim());
}

/* 解析域名的 A/AAAA 记录，并判断是否指向当前 frps 服务器（只对 IPv4 serverAddr 可靠）。
 * 用于 http/https 代理的「域名解析」软检查：不参与三层判定，只是给用户一个提示。 */
async function resolveDomainInfo(domain) {
  const clean = String(domain || '').trim().toLowerCase().replace(/^\*\./, '');
  if (!clean) return { resolved: [], pointsToServer: false, error: '缺少域名' };
  try {
    const dns = require('node:dns').promises;
    const [a4, a6] = await Promise.allSettled([dns.resolve4(clean), dns.resolve6(clean)]);
    const resolved = [];
    if (a4.status === 'fulfilled') resolved.push(...a4.value);
    if (a6.status === 'fulfilled') resolved.push(...a6.value);
    let error = '';
    if (!resolved.length) {
      const reason = a4.status === 'rejected' ? a4.reason : (a6.status === 'rejected' ? a6.reason : null);
      error = String((reason && (reason.code || reason.message)) || '无解析记录');
    }
    const server = String((model && model.serverAddr) || '').trim().toLowerCase();
    let pointsToServer = false;
    if (resolved.length && server && isIpLike(server)) {
      pointsToServer = resolved.some((ip) => String(ip).toLowerCase() === server);
    }
    return { resolved, pointsToServer, error };
  } catch (e) {
    return { resolved: [], pointsToServer: false, error: String((e && (e.code || e.message)) || e) };
  }
}

/* http/https + https2http/https2https 代理：证书实际覆盖的域名与代理绑定的域名是否一致。
 * 只是软提示，不拦截保存（证书可能之后才补，或用户有意用不匹配的自签证书做测试）。 */
function certCoverageWarnings(proxy) {
  if (!proxy || !proxy.plugin || !proxy.plugin.crtPath) return [];
  const domains = [];
  if (Array.isArray(proxy.customDomains)) domains.push(...proxy.customDomains);
  if (proxy.subdomain) domains.push(String(proxy.subdomain));
  const unique = Array.from(new Set(domains.map((d) => String(d).trim().toLowerCase()).filter(Boolean)));
  if (!unique.length) return [];
  const coverage = readCertCoverage(proxy.plugin.crtPath);
  if (!coverage.ok) return [`无法读取证书 ${proxy.plugin.crtPath}：${coverage.error}`];
  const certDomains = coverage.domains || [];
  const uncovered = unique.filter((d) => !certDomains.some((pattern) => coversDomain(pattern, d)));
  if (uncovered.length) {
    return [`证书不覆盖域名「${uncovered.join('、')}」（证书覆盖：${certDomains.join('、') || '(空)'}），浏览器会提示证书与域名不匹配`];
  }
  return [];
}

/* 限制并发的 map：结果按输入顺序返回，超出时间预算的条目留 null 给下一轮 */
async function mapLimit(items, limit, worker) {
  const out = new Array(items.length).fill(null);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      out[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return out;
}

/* 单条代理的三层检查。任何异常都收敛成一条失败结果：
 * 一条代理出问题不能让整轮检查作废（以前 Promise.all 一 reject，整轮全丢）。 */
async function checkProxyHealth(p, ctx) {
  const at = Date.now();
  const layers = {};
  const type = p.type || 'tcp';
  let local;
  if (type === 'udp' || type === 'sudp') {
    // UDP 是无连接的，没有 TCP 三次握手可用来判断「本地服务是否在听」；
    // Windows 上往关闭端口发包连 ICMP port-unreachable 都不会回到 socket，
    // 硬拿 tcpCheck 去连只会把好好的 UDP 服务误报成「本地服务不通」。本地层跳过。
    local = { ok: true, ms: 0, error: null, skipped: true };
  } else {
    local = await manager.testLocal(p);
  }
  layers.local = { ok: !!local.ok, ms: local.ms || 0, error: local.error || null, skipped: !!local.skipped };
  if (!local.ok) {
    return [p.name, { ok: false, reason: '本地服务不通', ms: local.ms || 0, error: local.error || null, layers, at }];
  }

  // 第 2 层：本地 frpc 已连上远程服务器，且该代理已在服务端注册（frpc 状态 running）。
  const status = manager.proxyStatus.get(p.name);
  const running = !!status && status.status === 'running';
  if (!running) {
    layers.tunnel = { ok: false, ms: 0, error: status && status.err ? status.err : '代理尚未在服务端注册' };
    return [p.name, { ok: false, reason: '隧道未建立', ms: local.ms || 0, error: layers.tunnel.error, layers, at }];
  }
  const server = await ctx.serverCheck();
  layers.tunnel = { ok: !!server.ok, ms: server.ms || 0, error: server.error || null };
  if (!server.ok) {
    return [p.name, { ok: false, reason: '本地到服务器不可达', ms: (local.ms || 0) + (server.ms || 0), error: server.error || null, layers, at }];
  }

  // 第 3 层：从本地经公网地址访问远程端口，确认服务端已对公网监听。
  // udp/sudp/xtcp/stcp 没有可探测的公网 TCP 端口或不走公网，
  // tcpmux 要先在 frps 的 tcpmux 端口上发 HTTP CONNECT 才能认领域名，
  // 这几种都只能确认到“隧道已注册”，第 3 层标记为 skipped。
  if (type === 'udp' || type === 'sudp' || type === 'xtcp' || type === 'stcp' || type === 'tcpmux') {
    layers.public = { ok: true, ms: 0, skipped: true, error: null };
    return [p.name, { ok: true, reason: null, ms: (local.ms || 0) + (server.ms || 0), error: null, layers, at }];
  }
  let pub;
  // vhost 端口是 frps 侧的配置。用户连过服务器、读到过 frps.toml 后，就该按服务器
  // 实际的 vhost 端口探测；没连过（summary 为 null）或服务器没配（0）才退回客户端设定。
  const srvSummary = serverConfig.summary || null;
  const vhostOpts = {
    ...settings,
    vhostHttpPort: (srvSummary && srvSummary.vhostHTTPPort) || settings.vhostHttpPort,
    vhostHttpsPort: (srvSummary && srvSummary.vhostHTTPSPort) || settings.vhostHttpsPort,
  };
  const target = configModule.probeTargetFor(model, p, vhostOpts);
  if (!target) {
    pub = { ok: false, ms: 0, error: type === 'http' || type === 'https' ? '缺少公网域名' : '缺少公网端口' };
    layers.public = { ok: false, ms: 0, error: pub.error, skipped: true };
  } else if (target.kind === 'http') {
    const tlsOptions = target.servername || typeof target.rejectUnauthorized === 'boolean'
      ? { servername: target.servername, rejectUnauthorized: target.rejectUnauthorized }
      : null;
    pub = await httpProbe(target.url, 5000, target.host ? { Host: target.host } : null, tlsOptions);
    layers.public = { ok: !!pub.ok, ms: pub.ms || 0, error: pub.error || null, status: pub.status || 0, url: target.display || target.url };
  } else {
    pub = await tcpCheck(target.host, target.port, 2500);
    layers.public = { ok: !!pub.ok, ms: pub.ms || 0, error: pub.error || null };
  }
  if (type === 'http' || type === 'https') {
    const domain = configModule.firstDomainOf(p);
    if (domain) {
      const dnsInfo = await resolveDomainInfo(domain);
      layers.dns = { ok: dnsInfo.resolved.length > 0, skipped: false, resolved: dnsInfo.resolved, pointsToServer: dnsInfo.pointsToServer, error: dnsInfo.error };
    }
  }
  if (!pub.ok) {
    return [p.name, { ok: false, reason: '公网不可达', ms: (local.ms || 0) + (server.ms || 0) + (layers.public.ms || 0), error: pub.error || null, layers, at }];
  }
  return [p.name, {
    ok: true,
    reason: null,
    ms: (local.ms || 0) + (server.ms || 0) + (layers.public.ms || 0),
    error: null,
    layers,
    at,
  }];
}

async function checkHealth() {
  if (!model) return;
  // 还没填服务器地址时，隧道和公网两层必然不通，检查出来全是红色异常，
  // 反而让第一次打开的人以为自己配错了。等用户在设置里填好再开始算。
  if (!model.serverAddr) {
    healthCache.clear();
    return;
  }
  // plugin 代理里，socks5/http_proxy/static_file 等没有可探测的本地后端，跳过；
  // 但 https2http/https2https 有 plugin.localAddr 后端 + https vhost 公网入口，正常测。
  const targets = model.proxies.filter((p) => {
    if (!p.plugin) return true;
    const pt = p.plugin && p.plugin.type;
    return pt === 'https2http' || pt === 'https2https';
  });
  const ctx = { serverAddr: model.serverAddr };
  let serverCheck = null;
  ctx.serverCheck = () => {
    if (!serverCheck) serverCheck = tcpCheck(ctx.serverAddr, Number(model.serverPort), 2500);
    return serverCheck;
  };

  const started = Date.now();
  const results = await mapLimit(targets, HEALTH_CONCURRENCY, async (p) => {
    // 时间预算用完就把剩下的留到下一轮，避免几十条代理把一轮拖成半分钟
    if (Date.now() - started > HEALTH_BUDGET_MS) return null;
    try {
      return await checkProxyHealth(p, ctx);
    } catch (err) {
      return [p.name, {
        ok: false,
        reason: '检查出错',
        ms: 0,
        error: (err && (err.code || err.message)) || 'unknown',
        layers: {},
        at: Date.now(),
      }];
    }
  });
  for (const item of results) if (item) healthCache.set(item[0], item[1]);
  // 配置里已经删掉的代理要顺手清掉，否则以后加回同名代理会读到上一次的旧结果
  const alive = new Set(model.proxies.map((p) => p.name));
  for (const name of Array.from(healthCache.keys())) if (!alive.has(name)) healthCache.delete(name);
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
        launchAtLoginBlocked: launchAtLoginSnapshot().blocked,
      },
    });
  });

  ipcMain.handle('state:refresh', async () => {
    await tick({ force: true });
    return ok(buildState());
  });

  /* ---------------- 自动更新 ----------------
   * 状态由主进程持有（见 src/main/update.js），渲染层只负责展示与触发，
   * 这样窗口重载、切页之后状态不会丢。 */
  ipcMain.handle('update:state', async () => ok(updateModule.snapshot()));
  ipcMain.handle('update:check', async () => ok(await updateModule.check()));
  ipcMain.handle('update:download', async () => ok(await updateModule.download()));
  ipcMain.handle('update:install', async () => {
    const result = await updateModule.install();
    if (!result.ok) return fail(result.error);
    return ok(updateModule.snapshot());
  });

  ipcMain.handle('settings:save', async (event, patch) => {
    try {
      return await saveSettingsPatch(patch);
    } catch (e) {
      // 渲染层对 IPC 抛错是“静默”的（只 await 不 catch），所以这里必须自己兜住
      return fail(`保存设置失败：${(e && e.message) || e}`);
    }
  });

  async function saveSettingsPatch(patch) {
    const allowed = [
      'frpcPath', 'configPath', 'frpsDashboardUrl', 'serviceName', 'runMode',
      'adminPort', 'adminUser', 'adminPassword', 'autoReload', 'pollIntervalMs', 'closeToTray',
      'startMinimized', 'launchTunnelOnStart', 'serviceAutoDetect', 'logBuffer', 'confirmStopService',
      'stripProxyEnv', 'launchAtLogin', 'vhostHttpPort', 'vhostHttpsPort',
      'acmeEmail', 'acmeStaging', 'dnsProvider',
    ];
    const clean = {};
    for (const key of allowed) if (patch && Object.prototype.hasOwnProperty.call(patch, key)) clean[key] = patch[key];
    // 开机自启要真的写进系统，写不进去就别保存，免得界面显示“已开启”但重启无效。
    if (clean.launchAtLogin !== undefined) {
      const result = applyLaunchAtLogin(!!clean.launchAtLogin);
      if (!result.ok) return fail(result.error);
      clean.launchAtLogin = !!result.actual;
    }
    if (clean.pollIntervalMs !== undefined) clean.pollIntervalMs = Math.min(30000, Math.max(1000, Number(clean.pollIntervalMs) || 3000));
    if (clean.adminPort !== undefined) clean.adminPort = Math.min(65535, Math.max(1, Number(clean.adminPort) || 7400));
    if (clean.vhostHttpPort !== undefined) clean.vhostHttpPort = Math.min(65535, Math.max(1, Number(clean.vhostHttpPort) || 80));
    if (clean.vhostHttpsPort !== undefined) clean.vhostHttpsPort = Math.min(65535, Math.max(1, Number(clean.vhostHttpsPort) || 443));
    if (clean.adminPort !== undefined && Number(clean.adminPort) === Number(model && model.serverPort)) {
      return fail(`管理 API 端口不能和服务器端口 ${model.serverPort} 相同`);
    }
    if (clean.logBuffer !== undefined) clean.logBuffer = Math.min(2000, Math.max(100, Number(clean.logBuffer) || 600));
    // 日志缓冲上限要立刻作用到正在跑的 LogFollower，否则要等下次启动才生效。
    if (clean.logBuffer) {
      follower.maxLines = clean.logBuffer;
      if (follower.lines.length > follower.maxLines) follower.lines.splice(0, follower.lines.length - follower.maxLines);
    }
    if (clean.runMode && !['auto', 'service', 'managed'].includes(clean.runMode)) delete clean.runMode;
    if (clean.configPath !== undefined) {
      const wanted = String(clean.configPath || '').trim();
      /* 填了但文件不存在就直接报错。否则 refreshPaths 会悄悄换回旧路径，
       * 用户以为“保存成功了”，实际用的还是另一个配置文件。
       * 还要挡住“选成文件夹”：以前只判断存在性，选错目录会存进去，
       * 之后每次读配置都报 EISDIR，界面上所有代理凭空消失。 */
      if (wanted) {
        let st = null;
        try { st = fs.statSync(wanted); } catch { st = null; }
        if (!st) return fail(`配置文件不存在：${wanted}`);
        if (st.isDirectory()) return fail(`这是一个文件夹，不是配置文件：${wanted}`);
      }
    }
    const adminBefore = { port: settings.adminPort, user: settings.adminUser, password: settings.adminPassword };
    settings = settingsModule.save(clean);
    const previousConfig = paths.configPath;
    const previousFrpc = paths.frpcPath;
    const refreshed = await settingsModule.refreshPaths();
    paths = { ...paths, ...refreshed };
    if (paths.configPath !== previousConfig) loadConfigFromDisk();
    if (paths.frpcPath !== previousFrpc) {
      // 版本号读不出来不该让“保存设置”整个失败（以前直接 reject，界面毫无反应）
      frpcVersion = (await tickStep('readFrpcVersion', readFrpcVersion)) || frpcVersion;
    }
    follower.setFile(paths.logPath);
    if (settings.pollIntervalMs !== pollInterval) startPolling();
    /* 管理 API 的端口/口令改了，frpc.toml 里的 webServer 必须跟着改，
     * 否则控制台问 7401、frpc 还在 7400 上听着，界面会永远停在“等待管理 API 就绪”。 */
    const adminChanged = adminBefore.port !== settings.adminPort
      || adminBefore.user !== settings.adminUser
      || adminBefore.password !== settings.adminPassword;
    if (adminChanged && model) {
      const changed = configModule.ensureAdmin(model, settings);
      if (changed) {
        const saved = persistModel(model, { reload: false });
        if (!saved.ok) return fail(`管理 API 配置写入失败：${saved.error || '未知原因'}`);
      }
      const snap = manager.snapshot();
      if (snap.running) {
        // 正在跑的 frpc 还按旧端口/旧口令监听，重启一次才对得上
        await manager.restart().catch(() => {});
        suppressExitUntil = Date.now() + 8000;
      }
    }
    await manager.refresh().catch(() => {});
    pushState();
    return ok({ state: buildState(), paths: pathsForState() });
  }

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

  ipcMain.handle('config:backups', async () => {
    if (!paths.configPath) return fail('配置路径尚未设置');
    const result = configModule.listBackups(paths.configPath);
    if (!result.ok) return fail(result.error);
    return ok({ backups: result.backups, dir: result.dir });
  });

  ipcMain.handle('config:restore-backup', async (event, incoming) => {
    if (!paths.configPath) return fail('配置路径尚未设置');
    const file = String((incoming && incoming.file) || '').trim();
    if (!file) return fail('请指定要还原的备份');
    const restored = configModule.restoreBackup(paths.configPath, file);
    if (!restored.ok) return fail(restored.error);
    // 还原后重新从磁盘载入，并视情况热重载隧道。
    loadConfigFromDisk();
    pushState();
    if (manager.apiOk && model) {
      applyAndMaybeReload(model, { restartRecommended: true }).catch(() => {});
    }
    return ok({ restoredFrom: restored.restoredFrom });
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
    /* 全新安装时本机 frpc.toml 里还是空的：用户在服务器页刚把 frps 配好，转头来加第一条
     * 隧道，不该被「服务器地址不能为空」顶回去 —— 那是我们自己没把目标填上，不是他漏填。
     * 只在地址为空时补，一律取「当前 SSH 会话那台」，没有会话才退到当前档案；
     * 已经配好的地址绝不覆盖。 */
    const seed = !model.serverAddr ? (findServerProfile(sessionServerId) || activeServerProfile()) : null;
    const base = seed && seed.host
      ? {
        ...model,
        serverAddr: seed.host,
        serverPort: Number(seed.clientPort) || 7000,
        auth: { ...(model.auth || {}), method: 'token', token: seed.clientToken || '' },
      }
      : model;
    const proxy = configModule.makeProxy(input);
    const next = configModule.normalize({
      ...base._extra,
      serverAddr: base.serverAddr,
      serverPort: base.serverPort,
      loginFailExit: base.loginFailExit,
      auth: base.auth,
      log: base.log,
      transport: base.transport,
      webServer: base.webServer,
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
    const proxyWarnings = certCoverageWarnings(proxy);
    const result = await applyAndMaybeReload(next);
    if (!result.ok) return result;
    // 地址是这次现填的：顺手把「本机隧道目标」记到这个档案上，概览和服务器页才不会
    // 出现「本机隧道还没有归属到任何档案」。
    if (seed) settings = settingsModule.save({ clientServerId: seed.id });
    pushState();
    return ok({ state: result.state, reloaded: result.reloaded, proxy, seededFrom: seed ? seed.name : '', warnings: proxyWarnings });
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
    /* 隧道没在跑时“热重载”本来就没对象：以前统一报“管理 API 未启动”，
     * 用户会以为是管理 API 坏了。直接把真正的状态说清楚。 */
    if (!manager.snapshot().running) {
      return fail('隧道没有在运行，不需要热重载（配置已保存，下次启动即生效）', { state: buildState() });
    }
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

  /*
   * 服务端已经有 auth.token 时，它就是这台服务器的事实来源。
   *
   * 新建档案会给一个随机 Token 作为占位（那时还没连上服务器、无从知道真实值）。
   * 一读到线上的 frps.toml，就把档案的 Token / bindPort 对齐过去 —— 否则用户会
   * 在「服务器就绪检查」第 4 步看到"Token 不一致"，还得自己回去把服务端那串
   * 抄进档案。反过来（服务端没有 token）不动档案：那份随机值本来就是要写进
   * 服务端配置向导的。
   *
   * 光对齐档案还不够：真正拿 Token 去登录的是本机 frpc.toml。本机配置如果已经
   * 指向同一台服务器（地址 + 端口都一样），那它里面那串旧 Token 注定登录失败，
   * 这里一并改掉 —— 只是把「本来就连这台」的凭据修正成服务端认可的值，
   * 不会改变隧道指向。改完返回 tokenSynced，由调用方决定要不要重启隧道。
   */
  function adoptServerAuthFromConfig() {
    if (!sessionServerId) return { tokenSynced: false };
    const summary = serverConfig.summary;
    const owner = findServerProfile(sessionServerId);
    if (!summary || !owner) return { tokenSynced: false };
    const nextToken = summary.authEnabled ? String(summary.token || '') : '';
    const nextPort = Number(summary.bindPort) || owner.clientPort;
    const nextPath = serverConfig.path || owner.configPath;
    if (owner.clientToken !== nextToken || Number(owner.clientPort) !== nextPort || owner.configPath !== nextPath) {
      upsertServerProfile({ id: owner.id, clientToken: nextToken, clientPort: nextPort, configPath: nextPath });
    }

    if (!model || !model.serverAddr) return { tokenSynced: false };
    const sameTarget = String(model.serverAddr).toLowerCase() === String(owner.host).toLowerCase()
      && Number(model.serverPort) === nextPort;
    if (!sameTarget) return { tokenSynced: false };
    const localToken = String((model.auth && model.auth.token) || '');
    if (localToken === nextToken) return { tokenSynced: false };
    const next = structuredClone(model);
    next.auth = { ...(next.auth || {}), method: 'token', token: nextToken };
    const saved = persistModel(next, { reload: false });
    if (!saved.ok) return { tokenSynced: false, error: saved.error || '写入本机 frpc 配置失败' };
    /* 地址 + 端口 + Token 都对上了，本机这份配置就是这台服务器的：顺手把「隧道目标」
     * 记到它头上，服务器页才不会一边用着它、一边说「本机隧道还没归属到任何档案」。 */
    if (settings.clientServerId !== owner.id) settings = settingsModule.save({ clientServerId: owner.id });
    return { tokenSynced: true };
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
    /* 服务器页已经拿到真实 Dashboard 端口，就把「打开服务器面板」的地址记住，
     * 概览/tray 才不至于重启后还跳回默认的 7500。只在用户没手动设过时自动填。 */
    if (serverConfig.summary && serverConfig.summary.webPort && serverSession.host && !settings.frpsDashboardUrl) {
      settings = settingsModule.save({ frpsDashboardUrl: `http://${serverSession.host}:${serverConfig.summary.webPort}` });
    }
    if (serverConfig.summary) {
      applyPortStatus(serverSession.info, serverConfig.summary);
      const sync = adoptServerAuthFromConfig();
      if (epoch !== sessionEpoch) return { ok: false, stale: true };
      if (sync.tokenSynced && manager) {
        /* 本机 frpc.toml 刚被改成服务端认可的那串 Token。隧道还开着的话，它手里
         * 仍是旧值，放着不管用户就会在概览看到「Token 校验失败」——正是刚才那种
         * 「四步全绿但隧道连不上」。旧 Token 本来就登录不上，重启不会打断正常业务。 */
        const rt = manager.snapshot();
        if (rt.running || rt.connected) {
          await manager.restart({ runMode: settings.runMode }).catch(() => ({}));
          await manager.refresh().catch(() => {});
          healthCache.clear();
          scheduleHealth(1200);
          send('notify', {
            kind: 'info',
            title: '已对齐本机 Token',
            message: '服务端的 auth.token 与本机 frpc.toml 不一致，已按服务端改正并重启隧道。',
          });
          pushState();
        }
      }
    }
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
    /* 新建档案没填 Token：
     *  - 同一台 frps 上已经有档案 → 沿用那台的 Token（它们本来就该一致）；
     *  - 全新的服务器 → 现场生成一个随机 Token。这个值会作为「服务端配置向导」
     *    的默认 token，保存时同时写进 frps.toml 和本机 frpc.toml，
     *    所以用户从头到尾不需要自己编 Token，也不需要人工核对两边是否一致。 */
    if (!payload.id && !patch.clientToken) {
      const sibling = serverProfiles().find((item) => item.host.toLowerCase() === host.toLowerCase()
        && Number(item.clientPort) === (Number(patch.clientPort) || 7000)
        && item.clientToken);
      patch.clientToken = (sibling && sibling.clientToken) || randomToken(24);
      patch.tokenGenerated = !sibling;
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
    /* 新建档案 = 切换了「当前要配置的服务器」。SSH 会话还停在上一台上时，
     * 页面会继续显示上一台的 frps 状态，看起来像“新建完没反应”，
     * 还会顺手提示“本机隧道指向其他服务器”。这里直接断开，
     * 让页面立刻变成这台新服务器的连接表单。 */
    let disconnected = '';
    const sessionElsewhere = serverSession.connected && sessionServerId && sessionServerId !== profile.id;
    if (sessionElsewhere || (serverSession.connected && sessionServerId === profile.id && hostChanged)) {
      if (sessionElsewhere) {
        const previous = findServerProfile(sessionServerId);
        disconnected = (previous && previous.name) || serverSession.host || '上一台服务器';
      }
      serverSession.disconnect();
      sessionServerId = '';
      serverConfig = { path: '', content: '', summary: null, error: '' };
      bumpSessionEpoch();
    }
    return ok({
      ...serverState(),
      hostChanged,
      disconnected,
      created: !payload.id,
      tokenGenerated: !!patch.tokenGenerated,
    });
  });

  ipcMain.handle('server:profile-delete', async (event, payload = {}) => {
    const profile = findServerProfile(payload.id);
    if (!profile) return fail('服务器档案不存在', { state: serverState() });
    const wasTunnelTarget = profile.id === settings.clientServerId;
    if (wasTunnelTarget && !payload.force) {
      return fail('这台服务器正绑定本机隧道，请先切换到其他档案，或勾选“同时解除绑定”后删除。', {
        state: serverState(),
        needsForce: true,
      });
    }
    let disconnected = '';
    // 不管当前 SSH 连没连上，删除档案都让「连接中」的请求作废：否则一个正在进行的
    // server:connect 会在 SSH 握手完成后偷偷把这个档案重建出来，出现「档案删了却还在读服务器信息」。
    bumpSessionEpoch();
    if (serverSession.connected && sessionServerId === profile.id) {
      disconnected = profile.name;
      serverSession.disconnect();
      sessionServerId = '';
      serverConfig = { path: '', content: '', summary: null, error: '' };
    }
    settingsModule.clearServerSecret(profile.id);
    const rest = serverProfiles().filter((item) => item.id !== profile.id);
    const nextActive = rest.find((item) => item.id === settings.clientServerId) || rest[0];
    const patch = {
      servers: rest,
      activeServerId: nextActive ? nextActive.id : '',
    };
    if (wasTunnelTarget) patch.clientServerId = '';
    settings = settingsModule.save(patch);

    /* 删掉的正是「本机隧道目标」时，隧道要跟着下线。
     *
     * 档案就是这台服务器在本机的全部记录：记录没了还留一条连过去的隧道，frpc 会
     * 继续正常登录、代理继续在线，概览一路全绿 —— 用户删完服务器看到"还是通的"，
     * 只会以为删除没生效或者程序在骗他。
     *
     * 分寸：
     *  · 本应用拉起的 frpc —— 直接收掉，天经地义。
     *  · 系统服务托管且本进程已提权 —— 一并停服务。
     *  · 系统服务托管但没提权 / 是别人的 frpc —— 不动，只把事实说回去。停它要
     *    弹管理员授权，用户点的是"删档案"，突然冒出 UAC 会被当成出事，还可能
     *    卡满 90 秒超时。渲染层据此提示"隧道还在跑，请去设置页停"。
     *
     * frpc.toml 一律保持原样：里面是用户自己的配置，重新建档案还能接着用。 */
    let stoppedTunnel = false;
    let stopError = '';
    let stopSkipped = '';
    if (wasTunnelTarget && manager) {
      const rt = manager.snapshot();
      const alive = rt.running || rt.connected;
      const hasService = !!(rt.service && rt.service.installed && rt.service.state === 'running');
      // mode 为 starting 且没有服务在跑，说明是自家子进程刚起、管理 API 还没就绪
      const childOwned = rt.mode === 'managed' || (rt.mode === 'starting' && !hasService);
      if (alive && (childOwned || (hasService && elevated))) {
        const stopped = await manager.stop({ runMode: settings.runMode }).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
        stoppedTunnel = !!stopped.ok;
        if (!stoppedTunnel) stopError = stopped.error || '停止隧道失败';
        await manager.refresh().catch(() => {});
      } else if (alive) {
        stopSkipped = hasService ? 'service' : 'external';
      }
      healthCache.clear();
      scheduleHealth(1200);
    }
    return ok({ ...serverState(), disconnected, stoppedTunnel, stopError, stopSkipped, appState: buildState() });
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
    const myEpoch = sessionEpoch;
    const result = await serverSession.connect({ host, port, username, password });
    // SSH 连接期间用户可能删掉了这个档案 / 切到了别的档案：此时必须放弃这次连接，
    // 不能继续 upsert（会偷偷重建一个档案），更不能去读配置回写页面。
    if (sessionEpoch !== myEpoch) {
      serverSession.disconnect();
      sessionServerId = '';
      serverConfig = { path: '', content: '', summary: null, error: '' };
      return fail('连接期间服务器档案已变更，本次连接已取消', { stale: true, state: serverState() });
    }
    if (!result.ok) return fail(result.error, { state: serverState() });
    profile = upsertServerProfile({ ...profile, host, port, username }, { activate: true });
    if (payload.remember) {
      const saved = settingsModule.saveServerSecret(profile.id, password);
      if (!saved.ok) return fail(saved.error, { state: serverState() });
    } else if (payload.password) {
      settingsModule.clearServerSecret(profile.id);
    }
    const inspected = await serverSession.inspect();
    if (sessionEpoch !== myEpoch) {
      serverSession.disconnect();
      sessionServerId = '';
      serverConfig = { path: '', content: '', summary: null, error: '' };
      return fail('连接期间服务器档案已变更，本次连接已取消', { stale: true, state: serverState() });
    }
    sessionServerId = profile.id;
    profile.lastConnectedAt = Date.now();
    settings = settingsModule.save({ servers: serverProfiles().map((item) => (item.id === profile.id ? profile : item)), activeServerId: profile.id });
    const snap = await loadServerSnapshot({ epoch: myEpoch });
    if (snap && snap.stale) {
      serverSession.disconnect();
      sessionServerId = '';
      serverConfig = { path: '', content: '', summary: null, error: '' };
      return fail('连接期间服务器档案已变更，本次连接已取消', { stale: true, state: serverState() });
    }
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
    const sendProgress = (step) => {
      try { event.sender.send('server:install-progress', step); } catch { /* window closed */ }
    };
    /* 服务器上已经有 frps 时不需要上传，也就不用下载；没有才去按架构取一份。
     * 二进制不再打进安装包，首次「从零初始化」时现下（约 18 MB），之后走缓存。 */
    let localBinary = '';
    if (!(serverSession.info && serverSession.info.frpsInstalled)) {
      const binary = await frpsBinary.ensure(arch, {
        onProgress: ({ text, percent }) => sendProgress({ stage: 'download', text, percent }),
      });
      if (!binary.ok) return fail(binary.error);
      localBinary = binary.path;
    }
    const configPath = serverSession.configPath || '/etc/frp/frps.toml';
    const unitName = (serverSession.info && serverSession.info.hasUnit && serverSession.info.serviceName) || 'frps';
    const result = await serverSession.bootstrap({
      content: generated.text,
      localBinary,
      configPath,
      unitName,
      onProgress: sendProgress,
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

  /*
   * 服务器页的检查是「服务器侧就绪」判定，不是全链路检测。
   *
   * 分工：
   *   这里（服务器页）  → SSH 通、frps 在跑、bindPort 在服务器本机监听、Token 与本机一致。
   *                       全绿只代表「这台服务器已经准备好接收客户端」。
   *   概览 / 代理映射   → local → tunnel → public 三层，代表「用户实际能不能访问」。
   *
   * 以前这里做的是三层，和概览页重复，而且「本地服务」这一层在还没建代理时
   * 必然是红的，用户会误以为服务器配置失败。
   */
  ipcMain.handle('server:selftest', async (event, payload = {}) => {
    const layer = String(payload.layer || '');
    const startedAt = Date.now();
    if (!serverSession.connected) {
      return ok({ layer, ok: false, ms: 0, reason: 'SSH 未连接', detail: '先连接服务器再做检查' });
    }
    const epoch = sessionEpoch;
    const active = activeServerProfile();
    const summary = serverConfig.summary || null;
    const bindPort = Number((summary && summary.bindPort) || (active && active.clientPort) || 0);

    if (layer === 'ssh') {
      const result = await serverSession.exec('echo ok', 6000);
      if (epoch !== sessionEpoch) return staleFail();
      if (result.ok && /ok/.test(result.stdout || '')) {
        return ok({ layer, ok: true, ms: Date.now() - startedAt, detail: `SSH 已登录 ${serverSession.username}@${serverSession.host}，命令往返 ${Date.now() - startedAt} ms` });
      }
      return ok({ layer, ok: false, ms: Date.now() - startedAt, reason: 'SSH 通道异常', detail: (result.stderr || '命令执行失败').trim().slice(0, 160) });
    }

    if (layer === 'service') {
      /* 一条脚本读三种托管方式，免得为了“在不在跑”来回 SSH 三趟。 */
      const rawUnit = (active && active.serviceName) || (serverSession.info && serverSession.info.serviceName) || 'frps';
      // 单元名会拼进 shell 命令，只放行 systemd 允许的字符，避免带引号的名字造成注入。
      const unit = /^[A-Za-z0-9_.@-]+$/.test(rawUnit) ? rawUnit : 'frps';
      const script = [
        `echo @@ACTIVE; systemctl is-active -- ${unit} 2>/dev/null || true`,
        `echo @@ENABLED; systemctl is-enabled -- ${unit} 2>/dev/null || true`,
        "echo @@PROC; for d in /proc/[0-9]*; do [ \"$(cat $d/comm 2>/dev/null)\" = frps ] && echo \"$d\"; done | head -n 1",
        "echo @@DOCKER; docker ps --format '{{.Names}}\\t{{.Status}}' 2>/dev/null | grep -i frp | head -n 1",
      ].join('; ');
      const result = await serverSession.exec(script, 12000);
      if (epoch !== sessionEpoch) return staleFail();
      const sections = {};
      let current = '';
      for (const line of String(result.stdout || '').split(/\r?\n/)) {
        const mark = /^@@(\w+)$/.exec(line.trim());
        if (mark) { current = mark[1]; sections[current] = []; continue; }
        if (current) sections[current].push(line.trim());
      }
      const pick = (key) => (sections[key] || []).filter(Boolean)[0] || '';
      const unitActive = pick('ACTIVE');
      const unitEnabled = pick('ENABLED');
      const pid = pick('PROC').replace(/^\/proc\//, '');
      const dockerLine = pick('DOCKER');
      const dockerParts = dockerLine ? dockerLine.split('\t') : [];
      const dockerUp = !!dockerLine && /up|healthy|running/i.test(dockerParts[1] || '') && !/unhealthy|restarting|dead/i.test(dockerParts[1] || '');
      if (unitActive === 'active' || pid || dockerUp) {
        const where = unitActive === 'active' ? `${unit}.service 正在运行` : dockerUp ? `容器 ${dockerParts[0]} 正在运行` : `frps 进程运行中（PID ${pid || '—'}）`;
        const boot = unitEnabled === 'enabled' ? '，已设为开机自启' : '';
        return ok({ layer, ok: true, ms: Date.now() - startedAt, detail: `${where}${boot}` });
      }
      return ok({
        layer,
        ok: false,
        ms: Date.now() - startedAt,
        reason: 'frps 没有运行',
        detail: unitActive === 'failed' ? `${unit}.service 处于 failed，展开实时日志看原因` : `没有找到运行的 frps（${unit}.service 未激活，也没有 frps 进程或容器）`,
      });
    }

    if (layer === 'bindPort') {
      if (!bindPort) return ok({ layer, ok: false, ms: Date.now() - startedAt, reason: 'bindPort 未知', detail: '服务器上没有可读的 frps 配置，先在向导里生成一份' });
      const result = await serverSession.exec(
        `echo @@SS; (ss -lntH 2>/dev/null || ss -lnt 2>/dev/null || netstat -lnt 2>/dev/null) | grep -E '[:.]${bindPort}([[:space:]]|$)' | head -n 3`,
        12000,
      );
      if (epoch !== sessionEpoch) return staleFail();
      const body = String(result.stdout || '');
      const ssPart = (/@@SS([\s\S]*?)(?:@@|$)/.exec(body) || [])[1] || '';
      const listenLine = ssPart.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] || '';
      if (listenLine) {
        return ok({ layer, ok: true, ms: Date.now() - startedAt, detail: `服务器本机已在 ${bindPort} 上监听（${listenLine.replace(/\s+/g, ' ').slice(0, 90)}）` });
      }
      return ok({
        layer,
        ok: false,
        ms: Date.now() - startedAt,
        reason: 'bindPort 未监听',
        detail: `ss/netstat 里没有 ${bindPort}。常见原因：frps 用了别的 bindPort，或配置改完没有重启 frps`,
      });
    }

    if (layer === 'token') {
      /* 比对对象必须是「这次会话连的那台」的档案。activeServerId 在极端情况下
       * 可能已经指向别的档案（切换中），拿错了会报出莫名其妙的 Token 不一致。 */
      const owner = findServerProfile(sessionServerId) || active;
      const serverToken = String((summary && summary.token) || '');
      const profileToken = String((owner && owner.clientToken) || '');
      const ownerName = owner ? owner.name : '当前档案';
      /* 真正拿 Token 去登录的是本机 frpc.toml。本机已经指向这台服务器时，比对的
       * 必须是它里面那串 —— 只比档案会得出「检查说一致，隧道却报 Token 校验失败」
       * 的自相矛盾结论（档案是"打算用的值"，frpc.toml 才是"实际在用的值"）。 */
      const liveTarget = !!(model && owner && model.serverAddr && owner.host)
        && String(model.serverAddr).toLowerCase() === String(owner.host).toLowerCase()
        && Number(model.serverPort) === (Number(summary && summary.bindPort) || Number(owner.clientPort) || 7000);
      const clientToken = liveTarget ? String((model.auth && model.auth.token) || '') : profileToken;
      const tokenSource = liveTarget ? '本机 frpc.toml' : `档案「${ownerName}」`;
      if (!serverToken && !clientToken) {
        return ok({ layer, ok: true, ms: Date.now() - startedAt, detail: '服务端与本机都没有启用 Token（auth 关闭）' });
      }
      if (!serverToken) {
        return ok({ layer, ok: false, ms: Date.now() - startedAt, reason: '服务端未启用鉴权', detail: `${tokenSource} 里配了 Token，但 frps.toml 里没有 auth.token，frpc 登录会被拒` });
      }
      if (!clientToken) {
        return ok({ layer, ok: false, ms: Date.now() - startedAt, reason: '本机没有 Token', detail: `服务端已启用 Token，但 ${tokenSource} 里没有，隧道登录会失败` });
      }
      if (serverToken !== clientToken) {
        const gap = liveTarget
          ? '点「切换隧道并重启」把档案里的值写到本机配置，或点右上「刷新」让应用自动对齐'
          : '点右上「刷新」重新读一次；仍然不同就说明服务端配置刚被别处改过，把档案 Token 改成服务端那串即可';
        return ok({
          layer,
          ok: false,
          ms: Date.now() - startedAt,
          reason: 'Token 不一致',
          detail: `服务端 ${serverToken.slice(0, 4)}… 与 ${tokenSource} 的 ${clientToken.slice(0, 4)}… 不同。${gap}`,
        });
      }
      return ok({ layer, ok: true, ms: Date.now() - startedAt, detail: `服务端与 ${tokenSource} 的 Token 一致（${serverToken.slice(0, 4)}…，${serverToken.length} 位）` });
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
    // 重新读快照：adoptServerAuthFromConfig 会把刚写下的 bindPort / Token 对齐到档案，
    // 所以这里不需要再单独回写一次。
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

  /* ---- HTTPS 证书（Let's Encrypt / DNS-01）---- */

  ipcMain.handle('cert:list', async () => ok({ certs: acmeManager.list() }));

  ipcMain.handle('cert:issue', async (event, payload = {}) => {
    try {
      const domains = payload.domains;
      const email = String(payload.email || settings.acmeEmail || '').trim();
      const staging = payload.staging !== undefined ? !!payload.staging : !!settings.acmeStaging;
      const provider = currentDnsProvider();
      if (!provider.ok) return fail(provider.error);
      const result = await acmeManager.issue({ domains, email, staging, dns: provider.dns });
      if (!result.ok) return fail(result.error);
      pushState();
      return ok(result);
    } catch (e) {
      return fail(String((e && e.message) || e));
    }
  });

  ipcMain.handle('cert:renew', async (event, payload = {}) => {
    try {
      const domain = String((payload && payload.domain) || '').trim();
      if (!domain) return fail('缺少域名');
      const staging = payload.staging !== undefined ? !!payload.staging : !!settings.acmeStaging;
      const existing = acmeManager.get(domain, { staging });
      const provider = currentDnsProvider();
      if (!provider.ok) return fail(provider.error);
      const email = existing && existing.email ? existing.email : String(settings.acmeEmail || '');
      const result = await acmeManager.renew(domain, { email, staging, dns: provider.dns });
      if (!result.ok) return fail(result.error);
      pushState();
      return ok(result);
    } catch (e) {
      return fail(String((e && e.message) || e));
    }
  });

  ipcMain.handle('cert:remove', async (event, payload = {}) => {
    const domain = String((payload && payload.domain) || '').trim();
    if (!domain) return fail('缺少域名');
    const staging = payload.staging !== undefined ? !!payload.staging : undefined;
    const result = acmeManager.removeLocal(domain, staging === undefined ? {} : { staging });
    if (!result.ok) return fail(result.error);
    pushState();
    return ok({ removed: true });
  });

  ipcMain.handle('dns:state', async () => ok({
    dnsProvider: settings.dnsProvider || '',
    hasToken: settingsModule.hasCloudflareToken(),
    acmeEmail: settings.acmeEmail || '',
    acmeStaging: !!settings.acmeStaging,
  }));

  /* 代理表单 / 健康检查共用的域名解析：只做软提示，不阻塞任何保存或判定。 */
  ipcMain.handle('dns:resolve', async (event, domain) => {
    return ok(await resolveDomainInfo(String(domain || '').trim()));
  });

  /* 域名向导「一键建解析」：给域名建/改 A 记录，指向 frps 服务器 IP。 */
  ipcMain.handle('dns:set-a', async (event, payload = {}) => {
    try {
      const provider = currentDnsProvider();
      if (!provider || !provider.setARecord) return fail('尚未配置 DNS 验证渠道（需要 Cloudflare token）');
      const domain = String((payload && payload.domain) || '').trim();
      if (!domain) return fail('请先输入域名');
      // 目标 IP：显式传入优先；否则用活跃服务器档案的 host（SSH 公网 IP），再退回本机配置 serverAddr。
      const explicit = String((payload && payload.ip) || '').trim();
      const profile = activeServerProfile();
      const ip = explicit || (profile && /^\d+\.\d+\.\d+\.\d+$/.test(profile.host || '') ? profile.host : '') || (model && /^\d+\.\d+\.\d+\.\d+$/.test(model.serverAddr || '') ? model.serverAddr : '');
      if (!ip) return fail('无法确定 frps 服务器 IP：请先连接服务器，或手动填一个 IP');
      const record = await provider.setARecord(domain, ip);
      return ok(record);
    } catch (e) {
      return fail((e && e.message) || String(e));
    }
  });

  ipcMain.handle('dns:save', async (event, payload = {}) => {
    try {
      const provider = String((payload && payload.provider) || '').trim().toLowerCase();
      if (!['', 'cloudflare'].includes(provider)) return fail('不支持的 DNS 服务商');
      const patch = { dnsProvider: provider };
      if (payload.acmeEmail !== undefined) patch.acmeEmail = String(payload.acmeEmail || '').trim();
      if (payload.acmeStaging !== undefined) patch.acmeStaging = !!payload.acmeStaging;

      if (provider === 'cloudflare') {
        const token = String((payload && payload.token) || '').trim();
        if (token) {
          const saved = settingsModule.saveCloudflareToken(token);
          if (!saved.ok) return fail(saved.error);
        }
      } else {
        settingsModule.clearCloudflareToken();
      }
      if (payload.clearToken === true) settingsModule.clearCloudflareToken();

      settings = settingsModule.save(patch);
      pushState();
      return ok({ state: buildState() });
    } catch (e) {
      return fail(String((e && e.message) || e));
    }
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

/* ---- HTTPS 证书自动续期 ----
 * 证书到期前（默认剩 30 天内）自动用同一套 DNS-01 重签，避免用户忘记手动续期。
 * 每 12 小时检查一次；后台失败只记日志、不打断主流程、不弹窗吓人。 */
const AUTO_RENEW_BEFORE_DAYS = 30;
const AUTO_RENEW_INTERVAL_MS = 12 * 3600 * 1000;
let autoRenewTimer = null;
let autoRenewRunning = false;

async function autoRenewExpiringCerts() {
  if (autoRenewRunning) return;
  autoRenewRunning = true;
  try {
    const provider = currentDnsProvider();
    if (!provider.ok) return; // 没配 DNS 渠道就跳过，静默。
    const result = await acmeManager.renewIfExpiring({ days: AUTO_RENEW_BEFORE_DAYS, dns: provider.dns });
    if (result.renewed.length) {
      const names = result.renewed.map((c) => `${c.domain}（${c.daysLeft} 天）`).join('、');
      notify('info', '证书已自动续期', names);
      pushState(); // 刷新证书列表，让到期天数即时更新
    }
    if (result.errors.length) {
      const first = result.errors[0];
      notify('error', '证书自动续期失败', `${first.domain}：${first.error}`);
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log(`[auto-renew] ${(e && e.message) || e}`);
  } finally {
    autoRenewRunning = false;
  }
}

function scheduleAutoRenew() {
  if (autoRenewTimer) clearInterval(autoRenewTimer);
  autoRenewTimer = setInterval(() => autoRenewExpiringCerts().catch(() => {}), AUTO_RENEW_INTERVAL_MS);
  if (autoRenewTimer.unref) autoRenewTimer.unref();
}

follower.on('lines', (lines) => send('logs:append', lines));
follower.on('reset', () => send('logs:reset', { lines: follower.recent(300) }));

/* 首次运行（哪儿都找不到 frpc.toml）时给一份骨架：服务器地址与 Token 留空，
 * **不带任何代理**。以前这里预置了一条 Windows-RDP，结果新用户装完就在概览看到
 * 一条红色的「本地服务不通」——那台机器的 3389 根本没开，看起来像程序坏了。
 * 现在隧道里没有代理，等用户自己加，加一条绿一条。 */
const STARTER_CONFIG = [
  '# FRP 控制台生成的默认配置。',
  '# 服务器地址和 Token 会在「服务器」页连上服务器后自动写入，通常不需要手改这里。',
  '# 要加穿透规则，去「代理映射」新增，或到「服务发现」扫本机端口直接发布。',
  'serverAddr = ""',
  'serverPort = 7000',
  'loginFailExit = false',
  '',
  'auth.method = "token"',
  'auth.token = ""',
  '',
  'log.to = "./frpc.log"',
  // info 级别里最吵的是控制台自己每 3 秒一次的 /api/status 查询（约占 86%），
  // 那些行由 LogFollower 过滤掉，这里保持 info，用户还能看到登录成功/代理注册这些关键行。
  'log.level = "info"',
  '',
].join('\n');

/* 安装目录里的东西（含 resources/frpc 下内置的 frpc.exe）在一次升级中会被
 * 「先卸载旧版再装新版」整体删掉，配置文件绝不能放在那里。
 * 开发/便携解压运行时 app.getAppPath() 也在临时/解压目录里，同样不能放配置。 */
function isInsideInstallDir(dir) {
  if (!dir) return false;
  const target = path.resolve(dir).toLowerCase();
  const roots = [];
  try { roots.push(path.resolve(path.dirname(process.execPath)).toLowerCase()); } catch { /* ignore */ }
  try { roots.push(path.resolve(process.resourcesPath).toLowerCase()); } catch { /* ignore */ }
  try { roots.push(path.resolve(app.getAppPath()).toLowerCase()); } catch { /* ignore */ }
  return roots.some((root) => target === root || target.startsWith(`${root}${path.sep}`));
}

function ensureStarterConfig() {
  if (paths.configPath && fs.existsSync(paths.configPath)) return false;
  if (settings.starterConfigCreated) return false;
  /* 优先放在 frpc.exe 同目录（和 frp 官方压缩包的习惯一致），但那必须是一个
   * 升级不会清掉的位置 —— 内置 frpc.exe 在安装目录里，同目录写配置等于每次
   * 升级都丢一次。安装目录里的 frpc 一律把配置放到用户数据目录。 */
  const candidates = [];
  const frpcDir = paths.frpcPath ? path.dirname(paths.frpcPath) : '';
  if (frpcDir && !isInsideInstallDir(frpcDir)) candidates.push(path.join(frpcDir, 'frpc.toml'));
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
  /* 管理 API 的口令。
   * 老版本写死 admin/admin，本机任何进程只要知道这个口令（写在文档里）就能
   * GET /api/config 读到自己 frpc 配置的明文 —— 里面带着 frps 的 auth.token。
   * 这里只给“从来没设置过口令”的安装（全新用户）随机生成一个：
   * 老用户的值在 settings.json 里已经是 admin，不会被悄悄改掉，
   * 也就不会出现“隧道在跑、控制台却认证失败”的升级事故。
   * 想换口令的用户可以在「设置 → 客户端管理 API」里改。 */
  if (!settings.adminPassword) {
    settings = settingsModule.save({ adminPassword: randomToken(20) });
  }
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
  /* 这几步拿的都是"锦上添花"的信息，读不到不该让整个启动失败。
   * sc.exe 被安全软件拉黑 / 权限不足的机器上，原来会在 refreshService 直接抛出，
   * 连轮询都起不来，界面从此定格在初始状态。 */
  await tickStep('refreshService', () => refreshService({ detect: true }));
  frpcVersion = (await tickStep('readFrpcVersion', readFrpcVersion)) || '';
  elevated = !!(await tickStep('isElevated', () => service.isElevated()));
  await manager.refresh().catch(() => {});
  checkHealth().catch(() => {});
  startPolling();
  scheduleAutoRenew();
  // 启动后先等 30 秒再跑一次自动续期检查，避开启动期的资源占用与状态竞态。
  const initialRenew = setTimeout(() => autoRenewExpiringCerts().catch(() => {}), 30000);
  if (initialRenew.unref) initialRenew.unref();
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

/* ------------------------- 更新前后的隧道交接 -------------------------
 * 安装器（build/installer.nsh 的 customCheckAppRunning）是 taskkill /F /T，
 * 托管模式下 frpc 是控制台的子进程，会被一起带走。所以在装之前先把隧道
 * 优雅停掉，并留一张便条；新版本起来后凭它把隧道接回来，用户不用手动点。
 * 服务模式不写便条：frpc 由 nssm 托管，安装器杀不到，本来就不会断。
 */
const UPDATE_RESTART_FLAG = 'update-restart.json';

function updateFlagPath() {
  try {
    return path.join(settingsModule.dataDir(), UPDATE_RESTART_FLAG);
  } catch {
    return '';
  }
}

async function prepareUpdateInstall() {
  if (!manager || !manager.isChildAlive) return;
  try {
    await manager.stop({ runMode: settings.runMode });
  } catch {
    /* 停不掉也继续：安装器自己会 taskkill 兜底 */
  }
  try {
    const file = updateFlagPath();
    if (file) fs.writeFileSync(file, JSON.stringify({ at: Date.now() }), 'utf8');
  } catch {
    /* 便条写不下去只影响“更新后自动拉起隧道”，不影响更新本身 */
  }
}

function takeUpdateRestartFlag() {
  const file = updateFlagPath();
  if (!file) return false;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.unlinkSync(file);
    // 超过 10 分钟就作废：可能是上次更新失败留下的，不该莫名把隧道拉起来
    return !!(data && data.at && Date.now() - data.at < 10 * 60 * 1000);
  } catch {
    return false;
  }
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
    // 更新模块只做“状态持有 + 响应按钮”，不主动联网：检查更新由用户点按钮触发。
    updateModule.init({
      onStatus: (payload) => send('update:status', payload),
      beforeInstall: prepareUpdateInstall,
    });
    // 刚被更新过：上次更新前隧道在跑，这次启动把它接回来（服务模式下不会有这张便条）
    const restoreTunnel = takeUpdateRestartFlag();
    // bootstrap() 第一句就同步载入 settings，这里可以安全读取启动偏好。
    if (settings.launchTunnelOnStart || restoreTunnel) {
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
