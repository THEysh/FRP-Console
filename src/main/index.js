'use strict';

/* ELECTRON_RUN_AS_NODE=1 会让 electron 以纯 Node 模式执行本文件（不少 CI/受限
 * 会话会注入这个变量），此时 require('electron') 拿不到 app，第 8 行 app.setName
 * 直接 TypeError、退出码 1，看起来就是“electron . 启动不了、窗口不出现”。
 * 这里检测到就清除它，并重新以 GUI 模式拉起同一个 electron，本进程干净退出。
 * 子进程继承的是已删掉该变量后的环境，不会再次触发这段逻辑。 */
if (process.env.ELECTRON_RUN_AS_NODE === '1') {
  const nodePath = require('node:path');
  const { spawn } = require('node:child_process');
  delete process.env.ELECTRON_RUN_AS_NODE;
  const appDir = nodePath.resolve(__dirname, '..', '..'); // <根>/src/main -> 项目根
  /* 受限会话（如 DSH 沙箱）里，Electron 无法在工作区外（%LOCALAPPDATA%）创建
   * SingletonLock，会报 "Lock file can not be created! Error code: 5" 后静默退出。
   * 把 userData 指到项目内，绕过这个限制；正常终端不会有这个变量，不受影响。 */
  if (!process.env.PORTABLE_EXECUTABLE_DIR) {
    process.env.PORTABLE_EXECUTABLE_DIR = nodePath.join(appDir, '.frp-console-data');
  }
  const child = spawn(process.execPath, [appDir, ...process.argv.slice(2)], {
    detached: true,
    stdio: 'inherit', // 继承终端，GUI 启动失败的报错能透传出来，而不是静默消失
    env: process.env,
  });
  child.unref();
  process.exit(0);
}

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { execFileSync } = require('node:child_process');
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Tray, Menu, nativeImage, Notification, powerMonitor } = require('electron');

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
  /* 源码开发模式：数据放项目内 .frp-console-data，避免与安装版抢
   * %LOCALAPPDATA%\frp-console 的单实例锁 —— 两边同时在跑时，源码版会
   * 拿不到 requestSingleInstanceLock 而静默退出，看起来就是“启动不了”。 */
  try {
    if (!app.isPackaged) candidates.push(path.join(app.getAppPath(), '.frp-console-data'));
  } catch { /* getAppPath 不可用时走后面的候选 */ }
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
const { FrpcManager, reloadFailureText } = require('./frpc');
const connectionsModule = require('./connections');
const { ReconnectSupervisor } = require('./supervisor');
const { LogFollower } = require('./log');
const service = require('./service');
const netport = require('./netport');
const { ServerSession } = require('./ssh');
const { KnownHosts } = require('./knownhosts');
const frpsConfig = require('./frpsconfig');
const { TrayPanel } = require('./tray-panel');
const frpsBinary = require('./frpsBinary');
const updateModule = require('./update');
const { AcmeManager, coversDomain, readCertCoverage, shouldRedeploy } = require('./acme');
const { CloudflareDns } = require('./dns');
const dnsCheck = require('./dnscheck');
const browserProbe = require('./netprobe');
const { execFileP, powershell, tcpCheck, httpProbe, hashText, randomToken, formatDuration, proxyEnvKeys, parseSocketHolder } = require('./util');
const { probePort, probeUdp, sshConnectHint, outboundHint } = require('./portprobe');
const { parseRuleSpec, judgePortRow, buildPortMatrix, summarizeMatrix, buildRuleTexts } = require('./portmatrix');

/* 出站失败（证书签发 / DNS API / 下载 frps / 检查更新）补一句本机网络排查方向。
 * 这类请求都是从本机往 443 连，跟服务器防火墙无关，混在一起说会把用户引到错的方向。 */
function withOutboundHint(message, what) {
  const text = String(message || '');
  if (!text) return text;
  if (/timeout|timed out|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|network|fetch failed|UNABLE_TO_VERIFY|self.signed|SELF_SIGNED/i.test(text)) {
    return `${text}\n\n${outboundHint(what)}`;
  }
  return text;
}

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
/* 磁盘上的配置能解析、但 frpc 自己不认（未知字段、参数写错）：与上面的解析失败分开记，
 * 界面上要说清「这是 frpc 的判断」。 */
let configVerifyError = null;
let configHash = '';
let configStamp = { mtimeMs: 0, size: 0 };
/* 配置文件被外部删掉/移走时只提醒一次，别每 3 秒刷一遍通知 */
let configMissingNotified = false;
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
/* 用户希望隧道是“开着”的：成功启动 / 启动时自动连接 / 托盘启动都置 true，
 * 用户主动停止、退出应用、升级安装前置为 false。自动重连只看这个标志，
 * 否则“用户明明点了停止，程序又自己拉起来”会非常吓人。 */
let tunnelDesired = false;
/* 应用内更新期间不能重连：安装器要覆盖文件，抢一个 frpc 只会让升级失败。 */
let updatingNow = false;
/* 健康守护：进程还在但管理 API 连续不通的时间起点（0 = 当前是通的）。 */
let apiDownSince = 0;
/* 上一次看到的网络接口快照，用来发现“换网/网卡重连”。 */
let netSnapshot = '';
/* 发现网络变化的时间点：给 20 秒让 frpc 自己重连，没恢复才交给守护。 */
let netChangedAt = 0;

const follower = new LogFollower('', { maxLines: 600 });
let manager = null;
let supervisor = null;
/* 多连接运行期状态（bootstrap 里初始化；null 表示还没起来）。 */
let multiConnection = null;
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

/* SSH 主机密钥固定表（userData/known-hosts.json）：
 * 首次自动信任并记录指纹，之后必须一致 —— 本程序要用户交 root 密码，
 * 22 端口被劫持（ARP 欺骗 / DNS 投毒 / 恶意热点）时这是唯一能拦住的一层。 */
/* 服务器上 frps.toml 的「修改时间:大小」指纹：用来发现外部改动。
 * 客户端 frpc.toml 有 checkExternalConfig，服务器侧一直没有对应机制 ——
 * 手工在服务器上改了 bindPort 之类的，界面会一直显示旧值。 */
let serverConfigStamp = '';

const knownHosts = new KnownHosts(path.join(settingsModule.dataDir(), 'known-hosts.json'));

function hostKeyGuard(key) {
  const host = serverSession.host;
  const port = serverSession.port || 22;
  const verdict = knownHosts.check(host, port, key);
  if (verdict.status === 'new') {
    knownHosts.trust(host, port, verdict.fingerprint);
    console.log(`[ssh] 首次连接 ${verdict.target}，记录主机指纹 ${verdict.fingerprint}`);
    /* 首次信任说白了是「这次先信你」：给一条可见的通知，用户才知道有这么一层，
     * 也知道真出事时该去哪儿对比（设置页「已知服务器指纹」）。 */
    notify(
      'info',
      `首次连接 ${verdict.target}`,
      `已记下它的主机指纹 ${String(verdict.fingerprint).slice(0, 24)}…，之后每次连接都会比对；对不上会拒绝并让你确认。`,
    );
    return { ...verdict, ok: true };
  }
  if (verdict.status === 'changed') {
    console.warn(`[ssh] ${verdict.target} 主机指纹变了：${verdict.previous} → ${verdict.fingerprint}`);
    return { ...verdict, ok: false };
  }
  return { ...verdict, ok: true };
}
let serverConfig = { path: '', content: '', summary: null, error: '' };
let sessionServerId = '';
/* 最近一次 nginx 检测结果（服务器页进来就会拉一次），端口矩阵用它补 80/443 的「谁在监听」信号。 */
let lastNginxState = null;
/* 配置体检缓存（1.2.72）：{at, host, data}；切服务器/修复后清掉。 */
let nginxHealthCache = null;

/* 服务器证书扫描结果缓存（按 host 记，60 秒内不重复 SSH 扫盘）。 */
let serverCertScanCache = { at: 0, host: '', certs: [], truncated: false };

/* 额外只读扫描的证书目录：安装版的 certs 目录 + 用户自定义目录。
 * 让源码版（独立 userData）也能看到安装版签/导入的证书，不必复制文件。 */
function extraCertDirs() {
  const dirs = new Set();
  const candidates = [];
  if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'frp-console', 'certs'));
  if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'frp-console', 'certs'));
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) dirs.add(path.resolve(c));
    } catch { /* ignore */ }
  }
  for (const d of (settings && Array.isArray(settings.certDirs) ? settings.certDirs : [])) {
    const dir = String(d || '').trim();
    if (!dir) continue;
    try {
      if (fs.existsSync(dir)) dirs.add(path.resolve(dir));
    } catch { /* ignore */ }
  }
  return [...dirs];
}

// 服务器 allowPorts（frps 对 remotePort 的白名单），未连服务器时为 []。
function serverAllowPorts() {
  return (serverConfig.summary && serverConfig.summary.allowPorts) || [];
}
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

/* 按「同一台机器」找档案：host + SSH 端口相同就是同一个目标（用户名只是登录属性）。
 * 连接的入口（连接表单）不给 id，以前一律 upsert 新建，于是用户每连一次就多一条
 * 同名档案——实测一个账号里能攒出 25 条 154.36.178.154。 */
function findServerProfileByKey({ host, port } = {}) {
  const key = settingsModule.serverProfileKey({ host, port });
  if (!key) return null;
  const list = serverProfiles().filter((item) => settingsModule.serverProfileKey(item) === key);
  if (!list.length) return null;
  /* 有多条历史重复档案时，优先用最近连过的、且存了密码的那条，避免用户被要求重输密码。 */
  return list.sort((a, b) => {
    const ap = settingsModule.hasServerSecret(a.id) ? 1 : 0;
    const bp = settingsModule.hasServerSecret(b.id) ? 1 : 0;
    if (ap !== bp) return bp - ap;
    return (Number(b.lastConnectedAt) || 0) - (Number(a.lastConnectedAt) || 0);
  })[0];
}

function activeServerProfile() {
  return findServerProfile(settings.activeServerId) || serverProfiles()[0] || null;
}

/* 方案 Y（nginx 统一终止 TLS）是「某台服务器」的事实，跟着档案走。
 * 读取按隧道绑定的档案（clientServerId，frpc.toml 实际指向的那台）解析；
 * 没有绑定档案时退回当前查看的档案。以前存成全局开关，多服务器用户
 * 切档案后会被上一台的状态污染（无 nginx 的服务器也按 https://域名 显示、探测）。 */
function yModeEnabled() {
  const bound = findServerProfile(settings.clientServerId) || activeServerProfile();
  return !!(bound && bound.nginxProxyEnabled);
}

/* 把 nginx 反代状态写到「这台服务器」的档案上，不再写全局开关。
 * 返回是否真的发生了变化（没变就不动 settings）。 */
function setProfileNginxProxy(profileId, value) {
  if (!profileId) return false;
  const list = serverProfiles();
  const target = list.find((item) => item.id === profileId);
  if (!target || !!target.nginxProxyEnabled === !!value) return false;
  settings = settingsModule.save({ servers: list.map((item) => (item.id === profileId ? { ...item, nginxProxyEnabled: !!value } : item)) });
  return true;
}

/* frps 的 vhost 端口同样是「某台服务器」的事实，跟着档案走。
 * 优先级：① SSH 正连着的就是隧道绑定的那台 → 用刚读到的 serverConfig.summary（实时权威）；
 * ② 隧道绑定档案里记录的 vhostHttpPort/vhostHttpsPort（上次连它时读到并存下来的）；
 * ③ 全局 settings 只在「隧道没绑定任何档案」时兜底。绑定档案存在但还没连过（端口 0）
 *    时宁可落到默认 80/443（vhostPortOf 的缺省），也不能拿「最后连过的另一台」的端口——
 *    那台端口上若有别的服务（比如本机 Docker 的 8080），探测会得到 200 造成假绿。
 * 以前只看 ①+③：连了 A（8080）再切回 B（28080），B 的 http 代理会按 8080 显示和探测。 */
function boundVhostPorts() {
  const bound = findServerProfile(settings.clientServerId) || activeServerProfile();
  const sessionIsBound = !!(serverSession && serverSession.connected && sessionServerId && bound && sessionServerId === bound.id);
  const srvSummary = (sessionIsBound && serverConfig.summary) || null;
  if (bound) {
    /* 档案里没记（0）时回落到全局设置：`settings:save` 会把用户在设置页填的值同步进
     * 绑定档案，但老档案、或刚连上还没同步过的档案这里是空的。直接返回 0 会让探测
     * 按 80/443 去猜 —— 服务端 vhost 端口不是 80 时，每条 http 代理都会永远
     * 显示「公网不可达」，明明隧道是通的。 */
    return {
      vhostHttpPort: (srvSummary && srvSummary.vhostHTTPPort) || Number(bound.vhostHttpPort) || Number(settings.vhostHttpPort) || 0,
      vhostHttpsPort: (srvSummary && srvSummary.vhostHTTPSPort) || Number(bound.vhostHttpsPort) || Number(settings.vhostHttpsPort) || 0,
    };
  }
  return {
    vhostHttpPort: Number(settings.vhostHttpPort) || 0,
    vhostHttpsPort: Number(settings.vhostHttpsPort) || 0,
  };
}

/* subdomain 的真实后缀只有服务器知道（frps.toml 的 subDomainHost）。
 * 隧道绑定的就是当前 SSH 会话时直接用它，好把「demo」补成 demo.<后缀>。 */
function sessionSubDomainHost() {
  const bound = findServerProfile(settings.clientServerId) || activeServerProfile();
  const sessionIsBound = !!(serverSession && serverSession.connected && sessionServerId && bound && sessionServerId === bound.id);
  const fromSession = (serverConfig.summary && serverConfig.summary.subDomainHost) || '';
  if (sessionIsBound) return fromSession;
  /* 会话与绑定档案 id 不同、但 host 相同（档案被清理过、手动重连过）时也认：
   * 后缀是「这台服务器」的事实，host 一致就是同一台。 */
  const sessionHost = serverSession && serverSession.connected ? String(serverSession.host || '').toLowerCase() : '';
  const boundHost = bound ? String(bound.host || '').toLowerCase() : '';
  if (sessionHost && boundHost && sessionHost === boundHost) return fromSession;
  return '';
}

/* 把 SSH 会话读到的 vhost 端口写进「这台服务器」的档案，返回是否发生变化。 */function setProfileVhostPorts(profileId, vhostHttpPort, vhostHttpsPort) {
  if (!profileId) return false;
  const vh = Number(vhostHttpPort) || 0;
  const vs = Number(vhostHttpsPort) || 0;
  const list = serverProfiles();
  const target = list.find((item) => item.id === profileId);
  if (!target) return false;
  if ((Number(target.vhostHttpPort) || 0) === vh && (Number(target.vhostHttpsPort) || 0) === vs) return false;
  settings = settingsModule.save({ servers: list.map((item) => (item.id === profileId ? { ...item, vhostHttpPort: vh, vhostHttpsPort: vs } : item)) });
  return true;
}

/* 面板地址里取 host（解析失败就按字符串粗判），用来判断这个地址属于哪台机器。 */
function hostOfUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const u = new URL(text.includes('://') ? text : 'http://' + text);
    return String(u.hostname || '').toLowerCase();
  } catch (e) {
    const bare = text.includes('://') ? text.slice(text.indexOf('://') + 3) : text;
    return bare.split('/')[0].split(':')[0].toLowerCase();
  }
}

/* 面板地址是「某台服务器的事实」，要跟着服务器走：写进档案，而不是一个全局值用到底。 */
function setProfileDashboardUrl(profileId, url) {
  const next = String(url || '').trim();
  if (!profileId || !next) return false;
  const list = serverProfiles();
  const target = list.find((item) => item.id === profileId);
  if (!target || String(target.dashboardUrl || '') === next) return false;
  settings = settingsModule.save({ servers: list.map((item) => (item.id === profileId ? { ...item, dashboardUrl: next } : item)) });
  return true;
}

/* 当前 SSH 会话对应哪台服务器的档案：按主机名匹配，匹配不上退回当前查看的档案。 */
function profileForSession(session) {
  const host = String((session && session.host) || '').trim().toLowerCase();
  const list = serverProfiles();
  if (host) {
    const byHost = list.find((item) => String(item.host || '').trim().toLowerCase() === host);
    if (byHost) return byHost;
  }
  return activeServerProfile();
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
  /* 档案的身份是「哪台机器」（host + 端口），不是随机 id。没给 id 时先按主机键找一遍：
   * 找到就更新那条，而不是再追加一条新档案（这是 1.2.69 之前堆积重复档案的根因）。 */
  const current = (input && input.id ? findServerProfile(input.id) : null) || findServerProfileByKey(input);
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

/* ---------------------- 服务器档案去重（1.2.69） ----------------------
 * 档案的身份是「哪台机器」= host + SSH 端口。历史上连接表单不给 id 就新建一条，
 * 于是同一个 IP 能堆出十几条同名档案（下拉里分不清、改错条目不生效）。
 * 这里把同一台机器的多条合并成一条：先备份，再搬密码、再重指绑定关系。
 * 幂等：没有重复时什么都不做，也不写盘。 */
function dedupeServerProfiles({ backup = true } = {}) {
  const before = serverProfiles();
  const { servers, merged } = settingsModule.mergeDuplicateServers(before);
  if (!merged.length) return { ok: true, changed: false, before: before.length, after: before.length, groups: [] };

  let backupError = '';
  if (backup) {
    try {
      const dir = path.join(settingsModule.dataDir(), 'backups');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      const files = [
        [settingsModule.settingsFile(), `settings.json.bak-dedupe-${stamp}`],
        [settingsModule.serverSecretFile(), `server-secret.json.bak-dedupe-${stamp}`],
      ];
      for (const [src, name] of files) {
        if (src && fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, name));
      }
    } catch (e) {
      backupError = String((e && e.message) || e);
    }
  }

  /* 密码是按档案 id 存的：被并掉的 id 上的密码必须搬到保留项，否则用户会被要求重输。 */
  for (const group of merged) {
    if (!settingsModule.hasServerSecret(group.keepId)) {
      const donor = group.dropped.find((id) => settingsModule.hasServerSecret(id));
      if (donor) {
        const secret = settingsModule.readServerSecret(donor);
        if (secret) settingsModule.saveServerSecret(group.keepId, secret);
      }
    }
    for (const dropped of group.dropped) settingsModule.clearServerSecret(dropped);
  }

  const remap = new Map();
  for (const group of merged) for (const dropped of group.dropped) remap.set(dropped, group.keepId);
  const activeServerId = remap.get(settings.activeServerId) || settings.activeServerId;
  const clientServerId = remap.get(settings.clientServerId) || settings.clientServerId;
  settings = settingsModule.save({ servers, activeServerId, clientServerId });

  const summary = merged.map((g) => `${g.key} ×${g.dropped.length + 1} → 1`).join('、');
  // eslint-disable-next-line no-console
  console.log(`[profiles] 合并重复服务器档案：${before.length} → ${servers.length}（${summary}）`);
  return { ok: true, changed: true, before: before.length, after: servers.length, groups: merged, summary, backupError };
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
 * Windows 上就是在 HKCU\Software\Microsoft\Windows\CurrentVersion\Run 里写一条记录，
 * 不碰系统服务，也不需要管理员权限。实现细节见下面 applyLaunchAtLogin 的注释：
 * 早期用的是 app.setLoginItemSettings，实测它在本机静默失败（Run 键里什么也没写），
 * 所以改成自己读写注册表。
 *
 * 三个坑仍然适用：
 *  1) 开发模式下 process.execPath 是 electron.exe，必须把项目目录作为参数带上，
 *     否则登录后只会打开一个空白的 Electron 窗口。
 *  2) 便携版的 execPath 指向 %TEMP% 里解出来的副本，必须用 PORTABLE_EXECUTABLE_FILE
 *     指回用户双击的那个 exe，否则重启后路径就失效了。
 *  3) 用户在任务管理器里禁用启动项时，Windows 不删 Run 键，而是在
 *     Explorer\StartupApproved\Run 里把状态改成「已禁用」——只看 Run 键会得到
 *     「已开启」的假象。
 */


/* ---------- 开机自启：Windows 直接读写注册表 ----------
 * 以前靠 app.setLoginItemSettings：实测（源码运行、打包安装版都试过）它调用之后
 * HKCU\...\Run 里什么也没写、getLoginItemSettings 一直回 false，界面只能显示
 * 「系统拒绝了开机启动设置」，开关等于失效。改成自己写注册表：
 *   1) 写完立刻读回来核对，写没写进去一目了然；
 *   2) 能识别「任务管理器 → 启动」里被禁用（StartupApproved\Run 首字节 3/7），
 *      否则界面显示“已开启”、重启却不启动；
 *   3) 便携版指向用户双击的那个 exe，开发模式指向 electron.exe + 应用目录。
 * macOS / Linux 仍走 Electron 自带实现。 */
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const STARTUP_APPROVED_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';

function loginItemCommand() {
  if (process.env.PORTABLE_EXECUTABLE_FILE) return { path: process.env.PORTABLE_EXECUTABLE_FILE, args: [] };
  if (!app.isPackaged) return { path: process.execPath, args: [app.getAppPath()] };
  return { path: process.execPath, args: [] };
}

function loginItemName() {
  return app.getName() || 'frp-console';
}

function quoteArg(value) {
  const text = String(value || '');
  return /[\s"]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

function loginItemCommandLine() {
  const cmd = loginItemCommand();
  return [quoteArg(cmd.path), ...cmd.args.map(quoteArg)].join(' ');
}

/* reg query 的值行长这样：  frp-console    REG_SZ    "C:\path\app.exe" "C:\dir" */
function regQueryValue(key, name) {
  try {
    /* stderr 必须自己吞掉：execFileSync 的 stderr 默认继承父进程，
     * 而 reg 查不到值时一定往 stderr 写「系统找不到指定的注册表项」，
     * 每次轮询都往控制台刷一行错误，看着像程序坏了。 */
    const out = execFileSync('reg', ['query', key, '/v', name], { windowsHide: true, encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] });
    const line = out.split(/\r?\n/).find((l) => l.trim().startsWith(name));
    if (!line) return null;
    const parts = line.trim().split(/\s{2,}/);
    return { type: parts[1] || '', data: parts.slice(2).join('  ') };
  } catch {
    return null;
  }
}

/* 写注册表走 PowerShell（-EncodedCommand，见 util.powershell），不走 reg.exe：
 * reg add 的 /d 值里一旦带引号（命令行路径必然带），reg.exe 会报
 * 「ERROR: Invalid syntax」，实测写不进去。 */
function psQuote(text) {
  return `'${String(text === undefined || text === null ? '' : text).replace(/'/g, "''")}'`;
}

function regPathOf(key) {
  return String(key).replace(/^(HKCU|HKLM|HKCR|HKU)(?=\\)/i, '$1:');
}

async function regSetValue(key, name, value, kind = 'String') {
  const valueExpr = kind === 'Binary' ? '([byte[]](0x02,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00))' : psQuote(value);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    `  New-ItemProperty -Path ${psQuote(regPathOf(key))} -Name ${psQuote(name)} -Value ${valueExpr} -PropertyType ${kind} -Force | Out-Null`,
    "  Write-Output 'OK'",
    '} catch {',
    "  Write-Output ('FAIL ' + $_.Exception.Message)",
    '}',
  ].join('\r\n');
  const result = await powershell(script, { timeout: 20000 });
  const out = String(result.stdout || '').trim();
  // PowerShell 的报错本身带句号，拼进我们的话里会出现「。。」
  const cleaned = out.replace(/[。.!！]+$/, '');
  return { ok: out.startsWith('OK'), detail: cleaned || String(result.stderr || '').trim() };
}

async function regRemoveValue(key, name) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    `  Remove-ItemProperty -Path ${psQuote(regPathOf(key))} -Name ${psQuote(name)} -Force -ErrorAction SilentlyContinue`,
    "  Write-Output 'OK'",
    '} catch {',
    "  Write-Output ('FAIL ' + $_.Exception.Message)",
    '}',
  ].join('\r\n');
  const result = await powershell(script, { timeout: 20000 });
  const out = String(result.stdout || '').trim();
  // PowerShell 的报错本身带句号，拼进我们的话里会出现「。。」
  const cleaned = out.replace(/[。.!！]+$/, '');
  return { ok: out.startsWith('OK'), detail: cleaned || String(result.stderr || '').trim() };
}

/* StartupApproved\Run 里是 12 字节二进制：首字节 02/06 = 启用，03/07 = 禁用。 */
function startupApprovedDisabled(name) {
  const value = regQueryValue(STARTUP_APPROVED_KEY, name);
  if (!value || !value.data) return false;
  const first = String(value.data).replace(/[^0-9a-f]/gi, '').slice(0, 2);
  if (!first) return false;
  const byte = parseInt(first, 16);
  return byte === 3 || byte === 7;
}

/* 返回 { registered, enabled, blocked, error }：
 *   registered  启动项存在（Run 键里有）
 *   enabled     重启后真的会启动（没被任务管理器禁用）
 *   blocked     已注册但被禁用——这正是「设置里显示开着、重启却不启动」的原因 */
function launchAtLoginSnapshot() {
  if (process.platform !== 'win32') {
    let result;
    try {
      result = app.getLoginItemSettings();
    } catch (e) {
      return { registered: false, enabled: false, blocked: false, error: String((e && e.message) || e) };
    }
    const on = !!result.openAtLogin;
    return { registered: on, enabled: on, blocked: false, error: '' };
  }
  const name = loginItemName();
  const value = regQueryValue(RUN_KEY, name);
  if (!value) return { registered: false, enabled: false, blocked: false, error: '' };
  const disabled = startupApprovedDisabled(name);
  return { registered: true, enabled: !disabled, blocked: disabled, error: '' };
}

function launchAtLoginState() {
  return launchAtLoginSnapshot().enabled;
}

/* 注册表写不进去时的退路：把快捷方式放进当前用户的「启动」文件夹。
 * 这个路径（%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup）通常不需要提升权限，
 * 也不会被 HKCU\...\Run 那条 ACL 挡住。用 WScript.Shell 生成 .lnk，免掉手写 COM 互操作。 */
/* PowerShell 的 stderr 是 CLIXML：<Objs…><S S="Error">正文</S>…，并且换行被写成 _x000D__x000A_。
 * 直接塞进 warning 给用户看是一串乱码，这里抽正文、还原换行、去掉行号上下文。 */
function humanizePowerShellError(text) {
  const raw = String(text || '');
  if (!raw) return '';
  const parts = [...raw.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map((m) => m[1]);
  const body = (parts.length ? parts.join(' ') : raw)
    .replace(/_x000D__x000A_/g, '\n')
    .replace(/\+\s*~+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return body.slice(0, 300);
}

function startupShortcutPath() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'FRP 控制台.lnk');
}

async function writeStartupShortcut(enabled) {
  const link = startupShortcutPath();
  const esc = (s) => String(s || '').replace(/'/g, "''");
  if (!enabled) {
    try {
      if (fs.existsSync(link)) fs.unlinkSync(link);
      return { ok: true, target: '' };
    } catch (e) {
      return { ok: false, error: `删除启动文件夹快捷方式失败：${e.message || e}` };
    }
  }
  const cmd = loginItemCommand();
  const target = cmd.path;
  const args = (cmd.args || []).join(' ');
  const script = [
    '$ws = New-Object -ComObject WScript.Shell;',
    `$lnk = $ws.CreateShortcut('${esc(link)}');`,
    `$lnk.TargetPath = '${esc(target)}';`,
    `$lnk.Arguments = '${esc(args)}';`,
    `$lnk.WorkingDirectory = '${esc(path.dirname(target))}';`,
    '$lnk.WindowStyle = 1;',
    '$lnk.Save();',
  ].join(' ');
  const res = await powershell(script);
  const ok = !res.error && fs.existsSync(link);
  if (!ok) console.warn('[startup-shortcut] 创建失败', JSON.stringify({ error: res.error && String(res.error.message || res.error).slice(0, 200), code: res.code, stderr: String(res.stderr || '').slice(0, 200), link, target, args }));
  return ok ? { ok: true, target: link } : { ok: false, error: humanizePowerShellError(res.stderr) || (res.error && res.error.message) || '创建快捷方式失败' };
}

async function applyLaunchAtLogin(enabled) {
  if (process.platform !== 'win32') {
    try {
      app.setLoginItemSettings({ openAtLogin: !!enabled });
    } catch (e) {
      return { ok: false, error: `写入开机启动项失败：${e.message || e}` };
    }
    const on = launchAtLoginSnapshot().enabled;
    if (on === !!enabled) return { ok: true, actual: on };
    return {
      ok: false,
      actual: on,
      error: '系统拒绝了开机启动设置（可能被组策略或安全软件拦截），可以改用 shell:startup 文件夹里的快捷方式',
    };
  }

  /* 先走 Electron 自带的 setLoginItemSettings（干净、和其它平台一致）。
   * 它不一定可靠：实测某些受限环境里调用完 Run 键里什么也没写、也不报错，
   * 所以每次都读回来核对，没生效再自己写注册表兜底。 */
  const cmd = loginItemCommand();
  try {
    app.setLoginItemSettings({ openAtLogin: !!enabled, path: cmd.path, args: cmd.args });
  } catch {
    /* 忽略：下面自己写 */
  }
  let state = launchAtLoginSnapshot();
  if (state.enabled === !!enabled) return { ok: true, actual: state.enabled };

  const name = loginItemName();
  if (!enabled) {
    const removed = await regRemoveValue(RUN_KEY, name);
    await regRemoveValue(STARTUP_APPROVED_KEY, name);
    if (!removed.ok) {
      return { ok: false, actual: launchAtLoginSnapshot().enabled, error: `删除开机启动项失败：${removed.detail}` };
    }
  } else {
    const written = await regSetValue(RUN_KEY, name, loginItemCommandLine(), 'String');
    if (!written.ok) {
      return {
        ok: false,
        actual: launchAtLoginSnapshot().enabled,
        error: `写入开机启动项失败：${written.detail}。可以改用 shell:startup 文件夹里的快捷方式`,
      };
    }
    // 以前被任务管理器禁用过就在 StartupApproved 里留着「已禁用」，这里顺手改回启用。
    if (startupApprovedDisabled(name)) await regSetValue(STARTUP_APPROVED_KEY, name, '', 'Binary');
  }

  state = launchAtLoginSnapshot();
  if (enabled && state.blocked) {
    return {
      ok: false,
      blocked: true,
      actual: false,
      error: '启动项已写入系统，但它在「任务管理器 → 启动」里处于“已禁用”，重启后不会运行。请到那里把它设为“已启用”。',
    };
  }
  if (state.enabled !== !!enabled) {
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
async function syncLaunchAtLogin() {
  if (!settings) return;
  const want = settings.launchAtLogin === true;
  const state = launchAtLoginSnapshot();
  if (want && state.blocked) {
    settings = settingsModule.save({ launchAtLogin: false });
    console.warn('[startup] 启动项被用户在任务管理器里禁用，已把设置同步为关闭');
    return;
  }
  if (want === state.enabled) return;
  const result = await applyLaunchAtLogin(want);
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
      if (result.ok) {
        tunnelDesired = true;
        if (supervisor) supervisor.cancel('');
      }
      notify(result.ok ? 'info' : 'error', result.ok ? '隧道已启动' : '启动失败', result.error || '');
      await manager.refresh().catch(() => {});
      pushState();
      refreshTray();
    },
    'tun.stop': async () => {
      suppressExitUntil = Date.now() + 12000;
      tunnelDesired = false;
      if (supervisor) supervisor.cancel('用户停止了隧道');
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
  // 云防火墙/安全组「代答」特征：TCP 三次握手能成，但数据被中间设备掐断。
  // frpc 报 EOF / session shutdown / connection reset，而不是 timeout——这正是阿里云安全组、
  // 轻量服务器防火墙等云平台防火墙没放行端口时的典型现象（见广州 8.148.198.61 案例）。
  if (/EOF|session shutdown|reset by peer|connection reset|ECONNRESET/i.test(text)) return 'firewall';
  if (/timeout|timed out|unreachable|network is unreachable|no such host|NXDOMAIN/i.test(text)) return 'unreachable';
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

/* 「正在跑的 frpc 用的是哪份连接参数」。和当前配置不一致 = 界面显示的
 * 「已连接」其实连的是旧服务器（真机全剧本就这么假绿过一次）。 */
let startedFingerprint = '';

/* ===== 多连接的运行期辅助（阶段 2） ===== */

/* 按 id 找连接；找不到返回 null（不用 findConnection 的“落回第一条”，
 * 否则传错 id 会静默操作另一条隧道 —— 那比报错危险得多）。 */
function connectionById(connId) {
  const list = (settings && settings.connections) || [];
  return list.find((item) => item.id === connId) || null;
}

/* 每条连接自己的那三样路径。frpcPath 全局共用（同一个可执行文件）。 */
function connectionPaths(conn) {
  return {
    frpcPath: paths.frpcPath,
    configPath: conn.configPath || '',
    logPath: conn.logPath || '',
  };
}

/* 配置文件被改写（启动前补 webServer、外部改动、用户保存）之后必须丢掉缓存，
 * 否则健康检查还按旧端口/旧代理列表判，界面会显示上一次的状态。 */
function invalidateConnectionModel(connId) {
  if (multiConnection && multiConnection.parkedModels) multiConnection.parkedModels.delete(connId);
}

/* 连接自己的配置模型：当前连接用全局 model，其它连接按需读自己的 frpc.toml。
 * 读不到就返回 null —— 让 FrpcManager 报“配置不可用”，而不是拿别人的配置去连。 */
function connectionModel(conn) {
  if (!conn) return null;
  if (conn.id === settings.activeConnectionId) return model;
  const cache = multiConnection && multiConnection.parkedModels;
  if (cache && cache.has(conn.id)) return cache.get(conn.id);
  let parsedModel = null;
  try {
    /* 用 configModule.readConfig：它负责读文件 + 解析 + 保留原文（BOM 也在别处统一处理），
     * 别自己 toml.parse —— 1.2.113 那次 execFileP 按 reject 写就踩过“想当然的 API”。 */
    parsedModel = configModule.readConfig(conn.configPath);
  } catch (e) {
    parsedModel = null;
  }
  if (cache) cache.set(conn.id, parsedModel);
  return parsedModel;
}

/* 非当前连接启动前也要保证它自己的 frpc.toml 里有管理端口与口令，
 * 否则 frpc 会用默认 7400/admin 起来，和多连接抢占同一个端口。 */
function ensureAdminForConnection(conn) {
  if (!conn || !conn.configPath) return { ok: false, error: '这条连接还没有配置文件' };
  const connModel = connectionModel(conn);
  if (!connModel) return { ok: false, error: `读不到配置文件：${conn.configPath}` };
  /* 用「这条连接自己的」管理端口/口令，不能拿全局 settings：
   * 全局那份描述的是当前连接，写进别的连接会让两条隧道抢同一个端口。 */
  const connSettings = {
    ...settings,
    adminPort: Number(conn.adminPort) || settings.adminPort,
  };
  const changed = configModule.ensureAdmin(connModel, connSettings);
  if (!changed) return { ok: true };
  const write = configModule.writeConfig(conn.configPath, connModel);
  if (write.ok === false) return { ok: false, error: write.error };
  invalidateConnectionModel(conn.id);
  return { ok: true };
}

/* 拿一条连接的管理器；懒创建。当前连接直接用全局 manager，保证既有代码都走同一条路径。 */
function managerForConnection(connId) {
  const conn = connectionById(connId);
  if (!conn) return null;
  if (conn.id === settings.activeConnectionId) return manager;
  const store = multiConnection && multiConnection.extraManagers;
  if (!store) return null;
  if (store.has(conn.id)) return store.get(conn.id);
  const created = new FrpcManager({
    getSettings: () => ({ ...settings, adminPort: Number(conn.adminPort) || settings.adminPort }),
    getPaths: () => connectionPaths(conn),
    getConfig: () => connectionModel(conn),
    ensureAdminConfig: async () => ensureAdminForConnection(conn),
    /* 服务模式只支持一台（README 里写明）：多出来的连接一律托管进程，
     * 这样也不会去 sc start 一个和别的连接同名的服务。 */
    stopService: async () => ({ ok: false, error: '多连接只支持「应用托管进程」' }),
  });
  /* 非当前连接也要能自己回来：它和当前连接一样会遇到「frpc 被外面杀掉 / 睡眠后假死」。
   * 每条连接一个守护，互不影响（当前连接的守护在 bootstrap 里建，逻辑不变）。 */
  const guard = new ReconnectSupervisor({
    restart: async () => {
      suppressExitUntil = Date.now() + 8000;
      /* force：进程是被外面杀掉的，apiOk 还是旧值，不 force 会误判『已经在跑』。 */
      const result = await created.start({ runMode: 'managed', force: true });
      await created.refresh().catch(() => {});
      pushState();
      return result;
    },
    canRestart: () => settings.autoReconnect !== false && conn.enabled !== false,
    onChange: () => pushState(),
    log: (message, level) => {
      const line = `${new Date().toISOString().slice(0, 19).replace('T', ' ')} ${level === 'error' ? 'ERR' : 'WRN'} [${conn.name}] ${message}`;
      if (process.env.FRP_CONSOLE_DEBUG) console.log('[guard]', conn.id, message);
      try {
        follower.appendLines(line);
      } catch { /* 日志失败不影响重连 */ }
    },
  });
  created.on('exit', (info) => {
    if (process.env.FRP_CONSOLE_DEBUG) console.log('[guard-exit]', conn.id, JSON.stringify(info));
    invalidateConnectionModel(conn.id);
    pushState();
    refreshTray();
    const stoppedAt = (multiConnection && multiConnection.stopRequests.get(conn.id)) || 0;
    const justStoppedByUs = Date.now() - stoppedAt < 3000;
    if (process.env.FRP_CONSOLE_DEBUG) console.log('[guard-window]', conn.id, 'sinceStop=', Date.now() - stoppedAt, 'skip=', justStoppedByUs);
    /* 不再看 info.intentional：frpc 的 stopping 标记在 stop→start 边界上不可靠
     *（探针里被 taskkill 掉的进程仍报 intentional:true），只信时间窗。 */
    if (info && !justStoppedByUs) {
      guard.arm(String(info.error || '连接意外退出').slice(0, 120));
    }
  });
  if (multiConnection) multiConnection.guards.set(conn.id, guard);
  created.on('error', (e) => {
    if (process.env.FRP_CONSOLE_DEBUG) console.warn('[connections] manager error', e && e.message);
  });
  store.set(conn.id, created);
  return created;
}

/* 一条连接的代理计数。口径与概览一致：status=running 且（没有健康数据或健康通过）才算在线，
 * 「没测过」单独计一档，方便界面显示「待检测」而不是假装在线。 */
function connectionCounts(conn) {
  const isActive = conn.id === settings.activeConnectionId;
  const connModel = isActive ? model : connectionModel(conn);
  const mm = isActive ? manager : (multiConnection && multiConnection.extraManagers.get(conn.id));
  const statuses = (mm && mm.proxyStatus) || new Map();
  const list = (connModel && connModel.proxies) || [];
  let online = 0;
  let unchecked = 0;
  for (const proxy of list) {
    const st = statuses.get(proxy.name) || null;
    const health = healthCache.get(connectionsModule.keyOf(conn.id, proxy.name)) || null;
    if (!health) unchecked += 1;
    if (st && st.status === 'running' && (!health || health.ok)) online += 1;
  }
  return { total: list.length, online, unchecked, unhealthy: list.length - online };
}

/* 一条连接的对外摘要（给界面/诊断用，不含配置内容与 token）。 */
function connectionSummary(conn) {
  const mm = conn.id === settings.activeConnectionId ? manager : (multiConnection && multiConnection.extraManagers.get(conn.id));
  const snap = mm ? mm.snapshot() : null;
  return {
    id: conn.id,
    name: conn.name,
    serverId: conn.serverId,
    configPath: conn.configPath,
    adminPort: (snap && snap.adminPort) || conn.adminPort,
    enabled: conn.enabled,
    active: conn.id === settings.activeConnectionId,
    counts: connectionCounts(conn),
    runtime: snap
      ? {
        mode: snap.mode,
        running: snap.running,
        connected: snap.connected,
        foreign: snap.foreign,
        pid: snap.pid,
        proxyCount: (snap.proxies || []).length,
      }
      : { mode: 'stopped', running: false, connected: false, foreign: false, pid: null, proxyCount: 0 },
  };
}

/* 返回“现在不该自动重连”的原因；空串表示可以重连。
 * 抽成函数是为了出问题时有话可说：日志里能看到到底被哪一条挡住。 */
function supervisorBlockReason() {
  if (!settings) return '设置还没加载';
  if (settings.autoReconnect === false) return '用户关掉了「断线自动重连」';
  if (!tunnelDesired) return '隧道不是程序启动的（用户没让它开）';
  if (updatingNow) return '正在安装更新';
  if (!manager) return '管理器还没准备好';
  if (manager.snapshot().foreign) return '管理端口上是别人的 frpc';
  const snap = manager.snapshot();
  if (snap.mode === 'service' || snap.runtimeMode === 'service') return '隧道由系统服务托管，进程不归程序管';
  const errors = (buildState().validation && buildState().validation.errors) || [];
  if (errors.length) return `配置有 ${errors.length} 处错误，先改配置`;
  return '';
}

function runtimeView(runtime) {
  const apiOk = !!runtime.connected;
  /* 只有 frpc 真的会去启动的代理才算「本该注册」：
   * 配置里有 start = [...] 时，名单外的代理 frpc 根本不管，
   * 把它们算进来会让「一个都没注册上」成立，于是把好好的隧道报成
   * 「frpc 连不上 frps / Token 校验失败」。 */
  const startNames = model ? configModule.startNamesOf(model) : [];
  const declared = model
    ? (model.proxies || []).filter((p) => !startNames.length || startNames.includes(p.name)).length
    : 0;
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
  /* 自动重连进度（守卫可能还是 null：bootstrap 早期） */
  const reconnect = supervisor
    ? supervisor.view()
    : { state: 'idle', active: false, attempts: 0, nextInMs: 0, reason: '', lastError: '', slowMode: false };
  return {
    ...runtime,
    /* 跑着的 frpc 不是用当前配置起的：改了服务器地址/端口/token 但没重启，
     * 或者外部改了配置文件而重载没生效。 */
    staleConfig: !!(runtime.mode === 'managed' && startedFingerprint && startedFingerprint !== configModule.connFingerprint(model)),
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
    // 断线自动重连的进度：界面用它显示「第 N 次重连 · X 秒后」和取消按钮
    reconnect,
    adminConflict: runtime.foreign ? `管理端口 ${runtime.adminPort || 7400} 上的 frpc 不是本配置启动的` : '',
  };
}

/* ---------------- 代理「访问路径」（1.2.71） ----------------
 * 不少服务根路径回 404（Go 的 http.NotFound 就是 "404 page not found" 这句话），
 * 真正的入口在 /panel/ 这类子路径上。frp 只按 Host 路由、不做路径改写，
 * 所以「点开就是对的页面」只能由我们记住这条路径：
 *   · 生成链接 / 复制地址用它
 *   · 健康检查第 3 层用它探测（否则永远只探根路径）
 *   · 方案 Y（nginx 443）下可以顺手给根路径加一条 302 跳过去
 * 注意：不能写进 frpc.toml —— frp 遇到未知字段会让整份配置 unmarshal 失败
 *（tcpmux 写 remotePort 就是这么炸的），所以存 settings.proxyOpenPaths。 */
/* 访问路径只接受 URL 路径字符。
 * 这个值有三个去处：拼探测 URL、拼代理表里的可点链接、以及写进服务器 nginx 的
 * `return 302 <path>;`（syncCertToServerNginx → writeNginxProxyConfig 直接插进配置行）。
 * 最后那个是裸拼接：一个换行或分号就能插进任意 nginx 指令，轻则 `nginx -t` 失败把站点
 * 弄挂，重则把站点指到别处。所以白名单收紧在这里——不合规的值一律不落盘，也不会写进
 * 服务器配置（旧版本存下来的脏值也会被这里挡掉）。 */
const OPEN_PATH_UNSAFE = /[^\w\-./~%!$&'()*+,=:@?]/;

function normalizeOpenPath(value) {
  let s = String(value === undefined || value === null ? '' : value).trim();
  if (!s) return '';
  s = (s.startsWith('/') ? s : `/${s}`).replace(/\/{2,}/g, '/');
  if (s.length > 200) s = s.slice(0, 200);
  if (OPEN_PATH_UNSAFE.test(s) || s.includes('..')) return '';
  return s;
}

/* 只有能直接点开 HTTP 的代理类型才谈得上「访问路径」：
 * tcp 也算（1.2.71 起对 tcp 公网端口做 404 软探测），udp/stcp/sudp/xtcp/tcpmux 不是 HTTP。 */
const OPEN_PATH_TYPES = ['tcp', 'http', 'https'];

function openPathAllowedForType(type) {
  return OPEN_PATH_TYPES.includes(String(type || '').toLowerCase());
}

function proxyOpenPath(name) {
  const map = (settings && settings.proxyOpenPaths) || {};
  return normalizeOpenPath(map[name]);
}

function setProxyOpenPath(name, value) {
  /* 存的时候也过一遍类型闸：proxy:save 是唯一入口，但历史数据、以后的批量导入都可能
   * 绕过它 —— 类型不允许就顺手把这条记录删掉，别让它留成下一次改类型的定时炸弹。 */
  const existing = model && (model.proxies || []).find((p) => p.name === name);
  const clean = existing && !openPathAllowedForType(existing.type) ? '' : normalizeOpenPath(value);
  const map = { ...((settings && settings.proxyOpenPaths) || {}) };
  if (clean) map[name] = clean;
  else delete map[name];
  settings = settingsModule.save({ proxyOpenPaths: map });
  return clean;
}

function dropProxyOpenPath(name) {
  const map = { ...((settings && settings.proxyOpenPaths) || {}) };
  if (!(name in map)) return;
  delete map[name];
  settings = settingsModule.save({ proxyOpenPaths: map });
}

/* 外部改配置时（手改 frpc.toml、用别的工具删掉代理），settings 里的访问路径记录
 * 不会跟着消失；等哪天新建一条同名代理，就会「凭空」继承一个用户从没设过的路径
 * —— 界面上突然出现「复制/打开」跳到某个 /panel/，很难解释。每次成功读到配置后
 * 对一遍名字表，把已经不存在的清掉。 */
function pruneProxyOpenPaths() {
  const map = { ...((settings && settings.proxyOpenPaths) || {}) };
  const names = new Set(((model && model.proxies) || []).map((p) => p.name));
  let changed = false;
  for (const key of Object.keys(map)) {
    if (!names.has(key)) {
      delete map[key];
      changed = true;
    }
  }
  if (changed) settings = settingsModule.save({ proxyOpenPaths: map });
  return changed;
}

/* frpc.toml 顶层的 start = [...] 是「只启动列出的这些代理」的白名单。
 * 控制台自己增删代理时要同步它，否则「界面上新建了、隧道里却没有这条」会让人
 * 以为是端口或 token 的问题。只动这一个名字，其它条目原样保留；
 * 配置里没有 start 时什么也不做（默认就是全部启动）。 */
function startListPatch(model, { add = '', remove = '' } = {}) {
  const raw = model && model._extra && model._extra.start;
  if (!Array.isArray(raw) || !raw.length) return null;
  const before = raw.map((n) => String(n == null ? '' : n));
  const next = before.filter((n) => !remove || n !== remove);
  const added = !!add && !next.includes(add);
  if (added) next.push(add);
  const changed = added || next.length !== before.length;
  return changed ? { list: next, added } : null;
}

/* 启动时清理访问路径的历史脏数据：代理已经删掉的、类型不允许的、字符不合规的一律丢掉。
 * 返回被清理掉的条数（只在确实有变化时写盘，避免每次启动都改 settings.json）。 */
function pruneOpenPaths() {
  const map = (settings && settings.proxyOpenPaths) || {};
  const names = Object.keys(map);
  if (!names.length) return 0;
  const byName = new Map(((model && model.proxies) || []).map((p) => [p.name, p]));
  const next = {};
  let dropped = 0;
  for (const name of names) {
    const proxy = byName.get(name);
    const clean = proxy && openPathAllowedForType(proxy.type) ? normalizeOpenPath(map[name]) : '';
    if (clean) next[name] = clean;
    else dropped += 1;
  }
  if (dropped) settings = settingsModule.save({ proxyOpenPaths: next });
  return dropped;
}

/* frpc 管理 API 的凭据强度：空口令 / 默认口令 / 短口令都算弱。
 * 它只监听 127.0.0.1，但本机任何进程都能连上去读 token、改代理、重启隧道。 */
function adminWeakness() {
  const user = String((settings && settings.adminUser) || 'admin');
  const pass = String((settings && settings.adminPassword) || '');
  const reasons = [];
  if (!pass) reasons.push('还没有设置口令');
  else if (pass === 'admin' || pass === 'password' || pass === '123456') reasons.push('用的是默认口令');
  else if (pass.length < 10) reasons.push('口令太短（少于 10 位）');
  if (user === 'admin' && pass === 'admin') reasons.push('用户名和口令都是默认的 admin');
  return { weak: reasons.length > 0, reasons, user, length: pass.length };
}

function buildState() {
  if (!manager) {
    return {
      app: { version: app.getVersion(), frpcVersion, elevated, proxyEnvKeys: proxyEnvKeys() },
      settings: settingsForState(),
      paths: pathsForState(),
      config: null,
      configError,
      configVerifyError,
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
  const validation = model ? configModule.validate(model, { allowPorts: serverAllowPorts() }) : { errors: [], warnings: [] };
  /* 配置里有 start = [...] 时，不在这份名单里的代理 frpc 根本不会启动。
   * 让它单独成一档，否则界面会把它报成「隧道未建立」，把人骗去查端口和 token。 */
  const startNames = model ? configModule.startNamesOf(model) : [];
  const proxies = (model ? model.proxies : []).map((proxy) => {
    // 管理端口上是别人的 frpc 时，它报的代理状态与本配置无关，一律当作没同步
    const st = runtime.foreign ? null : manager.proxyStatus.get(proxy.name) || null;
    /* 健康缓存的键带连接前缀：两台服务器可能有同名代理，按裸名字查会互相串。 */
    const health = healthCache.get(connectionsModule.keyOf(settings.activeConnectionId, proxy.name)) || null;
    const openPath = proxyOpenPath(proxy.name);
    const publicAddress = configModule.publicAddressFor(model, proxy, { ...settings, ...boundVhostPorts(), subDomainHost: sessionSubDomainHost(), nginxProxyEnabled: yModeEnabled() });
    return {
      ...proxy,
      // 公网地址跟「隧道绑定档案」的 nginx 状态走，不再读全局（多服务器时全局是
      // 最后连过的那台的事实，拿来渲染别的服务器会显示成错的 https://域名）。
      publicAddress,
      openPath,
      /* 点开就该是能用的页面：tcp 型是 http://IP:端口/panel/，http/https 型是 http(s)://域名/panel/。
       * udp 没有可访问的 URL，保持空串。 */
      openUrl: (() => {
        if (proxy.type === 'udp' || proxy.type === 'sudp' || proxy.type === 'xtcp' || proxy.type === 'stcp') return '';
        if (!publicAddress) return '';
        /* 「只有 subdomain、还不知道服务器后缀」时 publicAddress 是 `subdomain:demo`——
         * 这不是地址，补成 http:// 只会给出一个必然打不开的链接。 */
        if (/^subdomain:/i.test(publicAddress)) return '';
        const base = /^[a-z][a-z0-9+.-]*:\/\//i.test(publicAddress) ? publicAddress : `http://${publicAddress}`;
        return openPath ? `${base.replace(/\/+$/, '')}${openPath}` : base;
      })(),
      status: st && st.status ? st.status : runtime.loggedIn ? 'pending' : 'unknown',
      statusError: st && st.err ? st.err : '',
      runtimeLocal: st ? st.local_addr : '',
      runtimeRemote: st ? st.remote_addr : '',
      startExcluded: startNames.length > 0 && !startNames.includes(proxy.name),
      health,
    };
  });
  return {
    app: {
      version: app.getVersion(),
      frpcVersion,
      elevated,
      /* 本机 frpc 管理 API 的凭据强度：默认 admin/admin 或空口令意味着本机任何程序都能改隧道。 */
      adminWeak: adminWeakness(),
      platform: process.platform,
      arch: process.arch,
      /* 设置页用它说明「不继承系统代理」现在有没有意义（Windows 的「系统代理」不写这些变量）。 */
      proxyEnvKeys: proxyEnvKeys(),
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
    configVerifyError,
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
      /* 「路径 404」单独成一档：隧道其实是通的，只是根路径（或填的访问路径）在目标服务上不存在。
       * 混进「连通性异常」会让人去查安全组/隧道，查半天查不出。 */
      const path404 = failed.filter((p) => p.health.pathMissing).length;
      /* 公网层失败里，「域名没解析 / 没指向这台服务器」跟「端口不通」是两回事：
       * 前者要改 DNS 记录，后者要查防火墙。概览分开计数，用户才知道该点哪里。 */
      const dnsFailed = failed.filter((p) => /^域名/.test(String(p.health.reason || ''))).length;
      /* 被 start 列表排除的代理：不是"坏了"，是我们压根没让它起来。
       * 单独一档，否则「N 个隧道未建立」会把人骗去查网络。
       * 条数按代理自己的标记数（不是 health 缓存）：隧道停着时缓存是空的，
       * 但「被 start 排除」这个事实来自配置，跟隧道有没有跑无关。 */
      const startExcluded = proxies.filter((p) => p.startExcluded).length;
      const startExcludedFailed = failed.filter((p) => p.health.startExcluded).length;
      return {
        total: proxies.length,
        online: verified.filter((p) => p.health.ok && p.status === 'running').length,
        unhealthy: failed.length - path404 - startExcludedFailed,
        path404,
        dnsFailed,
        startExcluded,
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
    // 兼容旧字段名：nginx 反代状态已改为按档案存储，这里始终给
    // 「隧道绑定档案」的当前值，界面/托盘读它不会读到别的服务器的状态。
    nginxProxyEnabled: yModeEnabled(),
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
  // 端口的权威来源是 frps 配置（真机常改端口，7500 只是兜底默认）。
  const webPort = (serverConfig.summary && serverConfig.summary.webPort) || 0;
  // 主机的权威来源是「现在连着的这台」，没连接时才退回隧道目标地址。
  // 以前 settings.frpsDashboardUrl 一存到底：连过 A 再换 B，设置页和「打开服务器面板」
  // 仍然指向 A（用户实际看到的就是这个问题）。
  const connectedHost = serverSession.connected ? String(serverSession.host || '') : '';
  const host = connectedHost || String((model && model.serverAddr) || '').trim();
  const portOf = (value) => Number((String(value || '').match(/:([0-9]{1,5})\b/) || [])[1]) || 0;
  if (host) {
    const lower = host.toLowerCase();
    /* 端口优先级：当前 frps 配置里的 webServer.port > 这台服务器档案记过的
     * > 全局记过的（只有同机才敢信）> 7500。没连服务器时也能给出对的端口。 */
    const profile = serverProfiles().find((item) => hostOfUrl(item.dashboardUrl) === lower);
    const port = webPort
      || (profile ? portOf(profile.dashboardUrl) : 0)
      || (hostOfUrl(settings.frpsDashboardUrl) === lower ? portOf(settings.frpsDashboardUrl) : 0)
      || 7500;
    return `http://${host}:${port}`;
  }
  if (settings.frpsDashboardUrl) return settings.frpsDashboardUrl;
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
    model = configModule.parseConfigText(text, { nginxProxyEnabled: yModeEnabled() });
    /* 文件里写了 serverAddr = "[::1]"：frpc 会拼成 [[::1]]:7000。模型里已经剥成 ::1，
     * 这里把文件也改回来，否则「看着保存成功、隧道却一直连不上」。 */
    const bracketed = /^\s*serverAddr\s*=\s*["']\[([^\]]+)\]["']/m.exec(text);
    if (bracketed && model && model.serverAddr === bracketed[1]) {
      try {
        const written = configModule.writeConfig(paths.configPath, model);
        if (written && written.ok !== false) {
          notify('warn', '服务器地址的方括号已去掉', `frpc 不认「[${bracketed[1]}]」这种写法（会拼成 [[…]]:端口），已按 ${bracketed[1]} 写回配置文件`);
        }
      } catch { /* 写不回去就只是提示，不阻断启动 */ }
    }
    configHash = hashText(text);
    const st = fs.statSync(paths.configPath);
    configStamp = { mtimeMs: st.mtimeMs, size: st.size };
    configError = null;
    pruneProxyOpenPaths();
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
  const validation = configModule.validate(nextModel, { allowPorts: serverAllowPorts() });
  if (validation.errors.length) {
    return { ok: false, errors: validation.errors, validation };
  }
  if (!paths.configPath) {
    return { ok: false, error: '尚未配置 frpc.toml 路径，请先在设置中选择配置文件' };
  }
  const write = configModule.writeConfig(paths.configPath, nextModel);
  if (write.ok === false) return { ok: false, error: write.error };
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
  /* 回滚用的原文：写盘前先留一份，frpc 拒绝新配置时用得上 */
  const previousText = paths.configPath && fs.existsSync(paths.configPath) ? fs.readFileSync(paths.configPath, 'utf8') : null;
  const saved = persistModel(nextModel);
  if (!saved.ok) return saved;
  let reloadResult = null;
  if (reload && manager && manager.apiOk) {
    reloadResult = await manager.reload();
    if (!reloadResult.ok) {
      /* frpc 拒绝了新配置：回滚。留着坏配置的话，用户以为没保存成功，
       * 但下次启动隧道会被这份配置卡死（插件证书缺失之类会拦住整条隧道）。 */
      let rolledBack = false;
      if (previousText !== null && paths.configPath) {
        const back = configModule.writeRawConfig(paths.configPath, previousText);
        rolledBack = back.ok !== false;
        if (rolledBack) {
          loadConfigFromDisk();
          await manager.reload().catch(() => {});
        }
      }
      healthCache.clear();
      scheduleHealth(900);
      const reason = reloadFailureText(reloadResult.error, model.proxies);
      const tail = rolledBack ? '（已回滚到修改前的内容）' : `（回滚失败，请手动检查 ${paths.configPath}）`;
      return { ok: false, error: `frpc 拒绝了这份配置：${reason}${tail}`, saved: false, rolledBack, restartRecommended };
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
    /* 健康守护（档 2）：frpc 进程还活着，但管理 API 连续 15 秒不响应 ——
     * 这不是“正在连接”，是卡死了（socket 假活 / 进程挂起）。交给守护重启，
     * 否则界面会一直停在“正在连接服务器”，用户还是只能手动点。 */
    if (supervisor && tunnelDesired && !foreignNow && !updatingNow && manager.isChildAlive) {
      if (manager.snapshot().connected) {
        apiDownSince = 0;
      } else if (!apiDownSince) {
        apiDownSince = Date.now();
      } else if (Date.now() - apiDownSince > 15000 && !supervisor.isWaiting()) {
        apiDownSince = 0;
        supervisor.arm('管理 API 连续 15 秒无响应');
      }
    } else {
      apiDownSince = 0;
    }
    /* 档 3：换网 / 网卡重连 / 睡眠唤醒。frpc 自己会重连，但假活的 socket 不会自己好，
     * 给 20 秒宽限，仍然没连上就交给守护重启。 */
    if (Date.now() - (tick.lastNet || 0) > 15000) {
      tick.lastNet = Date.now();
      const snapText = JSON.stringify(
        Object.entries(os.networkInterfaces()).map(([name, list]) => [name, (list || []).map((x) => `${x.address}/${x.netmask}`)])
      );
      if (netSnapshot && snapText !== netSnapshot) {
        netChangedAt = Date.now();
        console.warn('[reconnect] 网络接口发生变化，20 秒后仍未连上就重启隧道');
      }
      netSnapshot = snapText;
    }
    if (netChangedAt && Date.now() - netChangedAt > 20000) {
      netChangedAt = 0;
      if (tunnelDesired && !updatingNow && !foreignNow && supervisor && !supervisor.isWaiting() && !manager.snapshot().connected) {
        supervisor.arm('网络变化后没能自动恢复');
      }
    }
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

/* 解析域名的 A/AAAA/CNAME 记录，并判断是否指向当前 frps 服务器。
 * v1.2.58 起不再只问本机解析器：同时查两个公共 DoH（1.1.1.1 / 8.8.8.8）+ 本机 + 权威 NS，
 * 交叉给结论。原因见 src/main/dnscheck.js 头部注释（本机 DNS 超时 + NXDOMAIN 负缓存
 * 会让「刚加完记录」的域名报「未解析」，误导用户以为 CF 没配好）。 */
async function resolveDomainInfo(domain) {
  const clean = String(domain || '').trim().toLowerCase();
  if (!clean) return { resolved: [], pointsToServer: false, error: '缺少域名', sources: [] };
  /* customDomains 里可以直接写 IP（frp 按 Host 匹配，浏览器也能用 http://1.2.3.4 访问）。
   * IP 根本不需要解析，走 DNS 只会得到「查不到 A/AAAA 记录」这种假故障 ——
   * 之前填 127.0.0.1 的 http 代理会一直红着「域名没有解析」，第三层探测也永远不跑。 */
  if (isIpLike(clean) || net.isIP(clean)) {
    return {
      resolved: [clean],
      pointsToServer: true,
      error: '',
      verdict: 'ok',
      tone: 'ok',
      title: '这是 IP，不需要域名解析',
      detail: '',
      soaMinTtl: 0,
      sources: [],
      checkedAt: Date.now(),
    };
  }
  const server = String((model && model.serverAddr) || '').trim().toLowerCase();
  try {
    const info = await dnsCheck.resolveName(clean);
    const judge = dnsCheck.judgeResolution({ sources: info.sources, serverAddr: server, name: clean });
    const addrs = judge.addrs || [];
    return {
      resolved: addrs,
      pointsToServer: !!judge.matchesServer,
      error: judge.verdict === 'ok' || judge.verdict === 'proxied' ? '' : judge.title,
      verdict: judge.verdict,
      tone: judge.tone,
      title: judge.title,
      detail: judge.detail,
      soaMinTtl: info.soaMinTtl || 0,
      sources: info.sources,
      checkedAt: Date.now(),
    };
  } catch (e) {
    return { resolved: [], pointsToServer: false, error: String((e && (e.code || e.message)) || e), sources: [] };
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

/* 浏览器该打开的那个地址：target.display 就是界面上给用户看的公网地址
 *（方案 Y 是 https://域名，vhost 是 http(s)://域名:端口），再把访问路径接上。
 * 兜底探测要用它，不能用「连 IP + SNI」那条 URL —— 浏览器不会这么连。 */
function browserUrlFor(target) {
  if (!target) return '';
  const base = String(target.display || '');
  if (!/^https?:\/\//i.test(base)) return '';
  const openPath = String(target.openPath || '');
  if (!openPath) return base;
  return `${base.replace(/\/+$/, '')}${openPath}`;
}

/* 单条代理的三层检查。任何异常都收敛成一条失败结果：
 * 一条代理出问题不能让整轮检查作废（以前 Promise.all 一 reject，整轮全丢）。 */
async function checkProxyHealth(p, ctx) {
  const at = Date.now();
  const layers = {};
  const type = p.type || 'tcp';
  /* 多连接：本地探测与代理状态都取自「这条连接自己的」管理器。 */
  const mm = ctx.mm || manager;
  /* start 列表外的代理 frpc 不会启动：本地服务通不通都没意义，
   * 直接给定这一档原因，别让它落到「隧道未建立」把人骗去查网络。 */
  if (p.startExcluded) {
    return [p.name, { ok: false, startExcluded: true, reason: '不在 start 列表里（frpc 不会启动它）', ms: 0, error: null, layers, at }];
  }
  let local;
  if (type === 'udp' || type === 'sudp') {
    // UDP 是无连接的，没有 TCP 三次握手可用来判断「本地服务是否在听」；
    // Windows 上往关闭端口发包连 ICMP port-unreachable 都不会回到 socket，
    // 硬拿 tcpCheck 去连只会把好好的 UDP 服务误报成「本地服务不通」。本地层跳过。
    local = { ok: true, ms: 0, error: null, skipped: true };
  } else {
    local = await mm.testLocal(p);
  }
  layers.local = { ok: !!local.ok, ms: local.ms || 0, error: local.error || null, skipped: !!local.skipped };
  if (!local.ok) {
    /* 区分「本地服务没起」和「本机防火墙拦了」：只有绑定到非回环地址时才可能是后者。
     * 127.0.0.1 上的连接不经过 Windows 防火墙，绑定局域网 IP 才会被入站规则拦。 */
    const localHost = String(p.localIP || '127.0.0.1');
    const loopback = /^(127\.|::1$|localhost$)/i.test(localHost);
    const refused = /ECONNREFUSED/i.test(String(local.error || ''));
    const reason = (!loopback && refused) ? '本地服务不通（可能被本机防火墙拦）' : '本地服务不通';
    layers.local.hint = (!loopback && refused)
      ? `绑定的是 ${localHost}（非回环地址），Windows 防火墙可能拦了入站连接；可先把 localIP 改成 127.0.0.1 验证`
      : '';
    return [p.name, { ok: false, reason, ms: local.ms || 0, error: local.error || null, layers, at }];
  }

  // 第 2 层：本地 frpc 已连上远程服务器，且该代理已在服务端注册（frpc 状态 running）。
  const status = mm.proxyStatus.get(p.name);
  const running = !!status && status.status === 'running';
  if (!running) {
    const raw = String((status && (status.err || status.status)) || '').trim();
    layers.tunnel = { ok: false, ms: 0, error: raw || '代理尚未在服务端注册' };
    /* start error 是 frps 明确拒绝了这个代理，和「还没开始注册」是两件事：
     * 最常见的原因是域名/端口被别的代理占了（router config conflict）。 */
    const conflict = /router config conflict|already (?:used|exists)|port .*in use/i.test(raw);
    /* frps 对「端口占不到」只回一句 port unavailable（不带端口号），而最常见的一种是
     * 用户把公网端口填成了 frps 自己的 bindPort——原来的提示完全不指向问题。 */
    const portUnavailable = /port unavailable/i.test(raw);
    const hitsServerPort = portUnavailable && Number(p.remotePort) > 0
      && Number(p.remotePort) === Number(model && model.serverPort);
    const reject = (status && status.status === 'start error') || conflict;
    /* 服务器没配 subDomainHost 时，frpc 只回一句英文
     * "subdomain is not supported because this feature is not enabled in server"，
     * 用户既不知道该改 frps.toml，也不知道「只填 customDomains 也能用」。 */
    const subdomainUnsupported = /subdomain is not supported/i.test(raw);
    const reason = conflict ? '域名或端口与别的代理冲突'
      : hitsServerPort ? `公网端口 ${p.remotePort} 就是 frps 的监听端口`
        : portUnavailable ? `公网端口 ${p.remotePort} 在 frps 上用不了`
          : subdomainUnsupported ? '服务器没有开启 subdomain'
            : reject ? 'frps 拒绝启动这个代理'
              : '隧道未建立';
    const hint = conflict
      ? '同一个域名只能给一条 http/https/tcpmux 代理；公网端口也不能两条 tcp/udp 代理共用。改掉其中一条即可。'
      : hitsServerPort
        ? `这个端口是 frpc 连 frps 用的（服务器端口 ${p.remotePort} / bindPort），frps 自己占着，换个别的公网端口。`
        : portUnavailable
          ? `frps 说 ${p.remotePort} 它用不了：可能被服务器上别的程序占着，也可能被别的客户端先注册了。到服务器页跑一次「检查端口」就能看清。`
          : subdomainUnsupported
            ? '两条路选一条：①在服务器 frps.toml 里配 subDomainHost（子域名后缀），重启 frps；②不填 subdomain，直接在「自定义域名」里写完整域名（两条都填时 frp 仍要求服务器开启 subdomain）。'
            : reject
              ? '看「实时日志」里这条代理的 start error 行，通常是域名/端口冲突或配置层拒绝。'
              : '';
    if (hint) layers.tunnel.hint = hint;
    return [p.name, { ok: false, reason, ms: local.ms || 0, error: layers.tunnel.error, layers, at }];
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
  // vhost 端口是 frps 侧的配置。按「隧道绑定的那台服务器」解析（boundVhostPorts）：
  // 优先 SSH 正连着的实时 summary，其次绑定档案里存的，最后才是全局兜底。
  const vhostOpts = {
    ...settings,
    ...boundVhostPorts(),
    subDomainHost: sessionSubDomainHost(),
    // settings 里的全局 nginxProxyEnabled 是「最后一次连过的服务器」的事实（兼容字段），
    // 探测必须按隧道绑定档案解析，否则切档案后 http 代理会按错的服务器探测 443。
    nginxProxyEnabled: yModeEnabled(),
  };
  /* 域名解析先查：界面要展示 DNS 层，兜底探测也要用它当前提——
   * 只有「域名确实指向这台服务器」时，用浏览器栈探测才是对同一个入口的复验；
   * 否则可能打开的是别人家的同名站点，反而制造假绿。 */
  let dnsInfo = null;
  if (type === 'http' || type === 'https') {
    const domainForDns = configModule.firstDomainOf(p);
    if (domainForDns) {
      dnsInfo = await resolveDomainInfo(domainForDns);
      layers.dns = { ok: dnsInfo.resolved.length > 0, skipped: false, resolved: dnsInfo.resolved, pointsToServer: dnsInfo.pointsToServer, error: dnsInfo.error };
    }
  }
  const target = configModule.probeTargetFor(model, p, vhostOpts);
  if (!target) {
    pub = { ok: false, ms: 0, error: type === 'http' || type === 'https' ? '缺少公网域名' : '缺少公网端口' };
    layers.public = { ok: false, ms: 0, error: pub.error, skipped: true };
  } else if (target.kind === 'http') {
    const tlsOptions = target.servername || typeof target.rejectUnauthorized === 'boolean'
      ? { servername: target.servername, rejectUnauthorized: target.rejectUnauthorized }
      : null;
    pub = await httpProbe(target.url, 5000, target.host ? { Host: target.host } : null, tlsOptions);
    /* 404 不是「连不上」：TCP 握手、TLS、HTTP 全都成功，只是这个路径在目标服务上不存在。
     * 之前的判定（status < 500 就算通）会让「点开是 404」和「一切正常」长得一模一样，
     * 所以这里单独打上 pathMissing，交给下面归类成「路径 404」一档。 */
    if (pub.ok && Number(pub.status) === 404) {
      pub = { ...pub, ok: false, pathMissing: true };
    }
    /* node 的 https 探测被重置时，用 Chromium 的网络栈再试一次（浏览器同款 ClientHello）。
     * 实测：某个域名在云厂商那边没备案时，边缘会按 TLS 层直接 RST —— 同一台机器上
     * Chrome 能正常打开，而 node 的 https（BoringSSL）和 PowerShell 的 schannel 都在
     * 握手阶段收到 ECONNRESET。只认 node 这一条路，就会把「浏览器明明能开」说成
     * 「公网不可达」。兜底探测成功时标注 via:'browser'，界面上说明是靠浏览器栈验证的。 */
    let browserTry = null;
    if (!pub.ok && !pub.pathMissing) {
      const browserUrl = browserUrlFor(target);
      /* 只在「域名确实解析到这台服务器」时复验：否则浏览器栈可能打开的是别人家的
       * 同名站点（DNS 还没生效 / 解析被劫持），把故障说成通过。 */
      const dnsPointsHere = !dnsInfo || dnsInfo.pointsToServer;
      if (browserUrl && dnsPointsHere) {
        browserTry = await browserProbe.probeWithChromium(browserUrl, 6000);
        if (browserTry && browserTry.ok && Number(browserTry.status) === 404) {
          pub = { ...pub, ok: false, pathMissing: true, error: `HTTP ${browserUrl} 返回 404` };
        } else if (browserTry && browserTry.ok) {
          pub = {
            ok: true,
            status: browserTry.status,
            ms: (pub.ms || 0) + (browserTry.ms || 0),
            error: null,
            via: 'browser',
            directError: pub.error || null,
            browserUrl,
          };
        }
      }
    }
    layers.public = {
      ok: !!pub.ok, ms: pub.ms || 0, error: pub.error || null,
      status: pub.status || 0, url: target.display || target.url,
      path: target.openPath || '',
      pathMissing: !!pub.pathMissing,
      via: pub.via || null,
      directError: pub.directError || null,
      browserUrl: (pub.via === 'browser' ? pub.browserUrl : '') || '',
      browserError: (!pub.ok && browserTry && !browserTry.unavailable) ? (browserTry.error || '') : '',
      browserUnavailable: !!(browserTry && browserTry.unavailable),
    };
    if (pub.via === 'browser') {
      layers.public.hint = `本机 node 直连被重置（${pub.directError || 'TLS 握手失败'}），用浏览器同款网络栈（Chromium）验证可以通过——隧道和域名本身是正常的。`
        + '这类重置常见于云厂商对未备案域名的 443 拦截：浏览器能开，命令行/接口类客户端会被拦。';
    }
  } else {
    pub = await tcpCheck(target.host, target.port, 2500);
    layers.public = { ok: !!pub.ok, ms: pub.ms || 0, error: pub.error || null };
    /* TCP 通了只说明端口在听：如果对方其实是 HTTP 服务，根路径照样可能回 404
     *（Go 写的面板、Jellyfin 前置、部分 Web 后台都是这样），用户点开就是
     * "404 page not found"。这里补一次软探测：
     *   · 只在 TCP 通过时做，超时 1500ms，拿不到 HTTP 响应就当对方不是 HTTP 服务（RDP/SSH 等），完全静默
     *   · 回 404 → 单独判成「路径 404」（隧道通、端口通，只是路径不对）
     *   · 回 2xx/3xx → 说明这就是个正常 Web 服务，额外记一笔供界面展示 */
    if (pub.ok && type !== 'tcpmux') {
      const httpUrl = `http://${target.host}:${target.port}${target.openPath || '/'}`;
      const probe = await httpProbe(httpUrl, 1500, null, null).catch(() => null);
      if (probe && probe.status === 404) {
        pub = { ...pub, ok: false, pathMissing: true, error: `HTTP ${httpUrl} 返回 404` };
        layers.public = { ...layers.public, ok: false, status: 404, url: httpUrl, path: target.openPath || '', pathMissing: true };
      } else if (probe && probe.ok) {
        layers.public = { ...layers.public, status: probe.status || 0, url: httpUrl };
      }
    }
  }
  if (!pub.ok) {
    /* 「公网不可达」太笼统，会把三种完全不同的故障说成同一件事：
     *   ① 云厂商备案拦截（80/8080 上返回备案提示页，请求根本没到 frps）
     *   ② nginx 上没有这个域名的 443（证书没部署，请求落到默认站点）
     *   ③ frps 上确实没有这个路由（frpc 刚断/正在重连，或域名写错）
     * 分开说，用户才知道下一步该点哪里。 */
    let reason = '公网不可达';
    let error = pub.error || null;
    let hint = '';
    const pubDomain = (type === 'http' || type === 'https') ? configModule.firstDomainOf(p) : '';
    const recentNginx = (lastNginxState && lastNginxState.serverHost === serverSession.host
      && Date.now() - lastNginxState.at < 120000) ? lastNginxState : null;
    if (pub.blocked === 'icp') {
      reason = '公网端口被云厂商备案拦截';
      hint = '这个域名没有在服务器所属云厂商备案，HTTP 端口（80/8080）上的请求会被直接换成备案提示页。要么完成备案，要么改成走 443：在「HTTPS 证书」页把该域名部署到 nginx，然后用 https://域名 访问。';
    } else if (pubDomain && dnsInfo && (dnsInfo.resolved.length === 0 || !dnsInfo.pointsToServer)) {
      /* 域名没解析 / 解到别的机器：这是 http(s) 代理最常见的一类故障，
       * 而探到的错误往往是 ECONNREFUSED / 404 / 502 之类，全被说成「公网不可达」的话，
       * 用户会去翻防火墙、翻 frps 配置，其实是 DNS 根本没指过来。
       * 这里直接用前面查到的 DNS 结果定因（没有 dnsInfo 时不猜）。 */
      if (!dnsInfo.resolved.length) {
        reason = '域名没有解析';
        error = `${pubDomain} 查不到 A/AAAA 记录${dnsInfo.error ? `（${dnsInfo.error}）` : ''} —— 浏览器打开也会是「找不到服务器」`;
        hint = `到域名服务商给 ${pubDomain} 加一条 A 记录指向 ${model.serverAddr}（Cloudflare 记得把云朵关掉，走灰云直连）；生效后本页下一轮检查会自动变绿。`;
      } else {
        reason = '域名没指向这台服务器';
        error = `${pubDomain} 现在解析到 ${dnsInfo.resolved.join('、')}，而这条隧道连的是 ${model.serverAddr}`;
        hint = `二选一：把 ${pubDomain} 的 A 记录改成 ${model.serverAddr}，或者换一个已经指向这台服务器的域名；DNS 缓存里可能还留着旧值，刚改完要等 TTL。`
          + '（如果这个域名走的是 Cloudflare 代理，A 记录本来就会显示 CF 的地址而不是服务器 IP —— 那种情况属于正常，重点看上面公网那一层的报错。）';
      }
    } else if (pub.pathMissing) {
      /* 404 单独一档：隧道、TCP、TLS 全都通了，是这个路径在目标服务上不存在
       *（最常见：服务入口在 /panel/ 这类子路径）。说成「公网不可达」会把人带偏。 */
      const where = (target.kind === 'http' ? target.url : `http://${target.host}:${target.port}${target.openPath || '/'}`);
      reason = p.openPath ? '访问路径 404' : '路径 404';
      error = `${where} 返回 404 —— 隧道是通的，但目标服务上没有这个路径`;
      hint = p.openPath
        ? `代理里填的访问路径是 ${p.openPath}，服务上返回了 404：确认路径大小写、结尾斜杠（多数服务要 /panel/ 而不是 /panel），或问一下这个服务的真实入口`
        : '很多服务（Go 面板、Jellyfin 前置等）根路径就是 404，入口在 /panel/ 之类的子路径：编辑这条代理，在「访问路径」里填上它，链接与检查都会跟着变';
    } else if (vhostOpts.nginxProxyEnabled && recentNginx && recentNginx.port443Free === true) {
      /* Y 模式（走 nginx 443）下，探测目标是 https://<服务器IP>/。443 根本没人监听时，
       * 拿到的只是 ECONNREFUSED，说成「公网不可达」会让人去查安全组——查半天也查不出。
       * 真正的原因是 nginx 上没有 443 段（常见于证书被删/还没签发）。 */
      reason = 'nginx 没有监听 443';
      error = `探测目标 https://${serverSession.host}/ 连不上：服务器上 443 没有任何监听，frp-console.conf 里也没有 ssl 证书段`;
      hint = '到「HTTPS 证书」页签发或导入一张覆盖该域名的证书，然后「部署到 nginx」，它会补上 443 段与证书';
    } else if (/ECONNRESET|EPROTO|ECONNABORTED|socket hang up|TLS|SSL/i.test(String(pub.error || ''))) {
      /* TLS 层被重置 ≠ 公网不可达：端口是通的（前面 tunnel 层已经证明），
       * 握手在中间被掐掉了。常见于云厂商对未备案域名的 443 拦截——
       * 浏览器有时仍能打开（Chromium 的 ClientHello 被放行），
       * node/schannel 这类客户端直接收到 RST。说成「公网不可达」会让人去查安全组。 */
      /* 有可能是「服务器上 443 根本没在听」被云厂商边缘 RST 盖住了表象：
       * 缓存里的 nginx 状态可能过期或还没拉过，这里现场查一次，别让用户白猜备案。 */
      let port443Free = recentNginx ? recentNginx.port443Free : undefined;
      if (port443Free === undefined && vhostOpts.nginxProxyEnabled && serverSession && serverSession.connected) {
        const listening = await serverSession.hasListener(443);
        if (listening !== null) port443Free = listening === false;
      }
      if (vhostOpts.nginxProxyEnabled && port443Free === true) {
        reason = 'nginx 没有监听 443';
        error = `探测目标 https://${target.host}/ 在握手阶段收到 ${pub.error}，而服务器上 443 确实没有任何监听（nginx 只配了 80）`;
        hint = '这条隧道本身是好的，缺的是 443 入口：到「HTTPS 证书」页签发或导入一张覆盖该域名的证书并「部署到 nginx」，它会补上 443 段与证书；'
          + '补完再点一次检查。若域名未备案，云厂商还会在 443 上重置握手，那就得先备案或换已备案的域名。';
      } else if (/altname|not in the cert|CERT_ALTNAME_INVALID|certificate has expired|CERT_HAS_EXPIRED|self[- ]signed|DEPTH_ZERO_SELF_SIGNED/i.test(String(pub.error || ''))) {
        /* 证书层面失败（1.2.98）：443 握手是通的，但服务端出示的证书没覆盖这个域名。
         * 最常见的原因是 nginx 上只有「别的域名」的 443 站点——请求落到默认站点，
         * 拿到的是那个站点的证书，客户端校验 altname 时直接断。
         * 这类错误以前被归到「TLS 握手被中断」并提示去备案，方向完全错了：
         * 用户要的是「给这个域名补一个 443 站点/证书」。 */
        const shown = (String(pub.error || '').match(/DNS:([^"'\s,]+)/g) || [])
          .map((s) => s.slice(4))
          .filter(Boolean)
          .slice(0, 3);
        const expired = /expired|CERT_HAS_EXPIRED/i.test(String(pub.error || ''));
        const selfSigned = /self[- ]signed|DEPTH_ZERO_SELF_SIGNED/i.test(String(pub.error || ''));
        reason = expired ? '证书已过期' : selfSigned ? '证书是自签的（不被信任）' : '证书与域名不匹配';
        error = `${target.kind === 'http' ? target.url : `https://${target.host}/`} 握手成功，但服务端出示的证书`
          + (shown.length ? `只覆盖 ${shown.join(' / ')}` : '不覆盖这个域名')
          + (expired ? '（已过期）' : '')
          + `：${String(pub.error || '').slice(0, 200)}`;
        hint = '这是 nginx 上的站点/证书没对上，不是备案也不是隧道：'
          + '到「HTTPS 证书」页给这个域名签发或导入一张覆盖它的证书，再点「部署到 nginx」——'
          + '它会在 443 上补一个属于这个域名的 server 块（同一台机器上别的域名不会被顶掉）。'
          + (shown.length ? `
现在 443 上返回的是 ${shown.join(' / ')} 的证书，说明请求落到了默认站点。` : '');
      } else {
        reason = '公网 TLS 握手被中断';
        error = `${target.kind === 'http' ? target.url : `https://${target.host}/`} 握手阶段收到 ${pub.error}（端口是通的，连接是被中途重置的）`;
        hint = '先用浏览器打开这个域名确认：如果浏览器能打开、只有本机探测被重置，通常是云厂商按域名在做 TLS 层拦截（未备案最常见），隧道本身没问题；'
          + '要彻底消除就到云厂商完成备案，或把域名解析到已备案的机器上。';
      }
      const browserErr = layers.public.browserError;
      if (browserErr) hint += `\n浏览器同款网络栈（Chromium）也没能打开：${browserErr}`;
      else if (layers.public.browserUnavailable) hint += '\n（本次没能用浏览器网络栈复核：只在 Electron 主进程里可用。）';
    } else if (pubDomain && /frps 上没有匹配到该域名/.test(String(pub.error || ''))) {
      const names = (recentNginx && Array.isArray(recentNginx.serverNames)) ? recentNginx.serverNames : [];
      const covered = names.some((n) => coversDomain(n, pubDomain));
      if (vhostOpts.nginxProxyEnabled && names.length && !covered) {
        reason = 'nginx 上没有这个域名';
        error = `nginx 的 frp-console.conf 里没有为 ${pubDomain} 配置 443（当前只配了 ${names.join('、')}），请求落到了默认站点，再被 frps 拒掉`;
        hint = '在「HTTPS 证书」页把覆盖该域名的证书「部署到 nginx」，它会补上对应的 server 块与证书';
      } else {
        reason = '服务器上没有这个域名的路由';
        error = `${pub.error}：frpc 与 frps 的连接可能刚断开或正在重连，也可能代理里写的域名和访问的域名不一致`;
        hint = '先确认隧道是否在线（frpc 是否登录成功）；如果刚好是断开后的几秒内，下一轮检查会自动恢复';
      }
    }
    layers.public.hint = hint;
    return [p.name, { ok: false, reason, ms: (local.ms || 0) + (server.ms || 0) + (layers.public.ms || 0), error, layers, at, pathMissing: !!pub.pathMissing }];
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

/* 一条连接的健康检查。
 *
 * 缓存键必须带连接前缀：两台服务器出现同名代理完全合法，而 healthCache 过去
 * 只按名字做键 —— 多连接之后那样会让 A 的「三层全通」直接套到 B 的同名代理上。
 */
async function checkConnectionHealth(connId, connModel, mm) {
  const prefix = `${connId}::`;
  const dropMine = () => {
    for (const key of Array.from(healthCache.keys())) if (key.startsWith(prefix)) healthCache.delete(key);
  };
  if (!connModel || !connModel.serverAddr) {
    dropMine();
    return;
  }
  /* frpc 没在跑（没启动 / 已停止 / 管理 API 不可达）时不要做检查：
   * 隧道层必然失败，于是每条代理都被判成「隧道未建立」，概览一片红字
   * 「16 个隧道未建立」——用户明明是自己没启动，却像是全坏了。
   * 清掉缓存，界面回到「待检测」，等隧道起来再测。 */
  const snap = mm ? mm.snapshot() : null;
  if (!snap || !snap.connected) {
    dropMine();
    return;
  }
  // plugin 代理里，socks5/http_proxy/static_file 等没有可探测的本地后端，跳过；
  // 但 https2http/https2https 有 plugin.localAddr 后端 + https vhost 公网入口，正常测。
  const startNames = configModule.startNamesOf(connModel);
  /* 访问路径按「当前连接」取：proxyOpenPaths 在阶段 6 才会加连接前缀，
   * 现阶段只有当前连接的代理在界面上可见，拿自己的路径就够了。 */
  const isActive = connId === settings.activeConnectionId;
  const targets = connModel.proxies.filter((p) => {
    if (startNames.length && !startNames.includes(p.name)) return false;
    if (!p.plugin) return true;
    const pt = p.plugin && p.plugin.type;
    return pt === 'https2http' || pt === 'https2https';
  }).map((p) => ({
    ...p,
    openPath: isActive ? proxyOpenPath(p.name) : '',
  }));
  const ctx = { serverAddr: connModel.serverAddr, mm };
  let serverCheck = null;
  ctx.serverCheck = () => {
    if (!serverCheck) serverCheck = tcpCheck(ctx.serverAddr, Number(connModel.serverPort), 2500);
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
  for (const item of results) if (item) healthCache.set(connectionsModule.keyOf(connId, item[0]), item[1]);
  /* 被 start 列表排除的代理也给一条结果：否则它们既不在「在线」也不在「异常」，
   * 只会挂在「还没测完」，界面上永远显示「待检测」。 */
  if (startNames.length) {
    for (const p of connModel.proxies) {
      if (startNames.includes(p.name)) continue;
      healthCache.set(connectionsModule.keyOf(connId, p.name), { ok: false, startExcluded: true, reason: '不在 start 列表里（frpc 不会启动它）', ms: 0, error: null, layers: {}, at: started });
    }
  }
  // 配置里已经删掉的代理要顺手清掉，否则以后加回同名代理会读到上一次的旧结果。
  // 只清这条连接的键：别的连接的缓存不能连带删掉。
  const alive = new Set(connModel.proxies.map((p) => connectionsModule.keyOf(connId, p.name)));
  for (const key of Array.from(healthCache.keys())) {
    if (key.startsWith(prefix) && !alive.has(key)) healthCache.delete(key);
  }
}

/* 一轮健康检查：把「所有有 frpc 在跑的连接」都过一遍。
 *
 * 当前连接用全局 model 与 manager；其它连接用各自缓存的模型与 extraManagers。
 * 串行跑（而不是 Promise.all）：SSH/本机探测都是 IO，串行能让总耗时可控，
 * 也避免几十条代理同时打满连接数。 */
async function checkHealth() {
  const list = (settings && settings.connections) || [];
  const activeId = settings ? settings.activeConnectionId : '';
  if (!list.length) {
    // 还没迁移出连接（理论上 bootstrap 之后不会发生）：退回单连接行为
    await checkConnectionHealth(activeId || '', model, manager);
    return;
  }
  for (const conn of list) {
    const isActive = conn.id === activeId;
    const mm = isActive ? manager : (multiConnection && multiConnection.extraManagers.get(conn.id));
    const connModel = isActive ? model : connectionModel(conn);
    /* 未启动的连接不必探测：manager 为 undefined 时 checkConnectionHealth 会清掉它的缓存。 */
    await checkConnectionHealth(conn.id, connModel, mm).catch((e) => {
      if (process.env.FRP_CONSOLE_DEBUG) console.warn('[health] 连接检查失败', conn.id, e && e.message);
    });
  }
}

/* 用 frpc 自己的解析器过一遍配置：像 `bogusTopLevel` 这种字段我们读得懂（进了 _extra），
 * frpc 却会在启动时直接报 `json: unknown field` 并退出——不做这一步，界面只会显示
 * 「隧道未运行 / 管理 API 未启动」，用户完全看不出是自己手改坏了配置。 */
async function verifyConfigWithFrpc(file) {
  if (!paths.frpcPath || !fs.existsSync(paths.frpcPath) || !file || !fs.existsSync(file)) {
    return { ok: true, skipped: true };
  }
  const pick = (text) => String(text || '').trim().split('\n').filter(Boolean).slice(-1)[0] || '';
  try {
    const r = await execFileP(paths.frpcPath, ['verify', '-c', file], { timeout: 8000 });
    /* execFileP 失败时是「正常返回 {ok:false,...}」而不是抛异常（见 util.execFileP） */
    if (r && r.ok === false) {
      return { ok: false, error: pick(r.stdout) || pick(r.stderr) || r.message || 'frpc 校验未通过' };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: pick(e && (e.stderr || e.stdout || e.message)) || 'frpc 校验未通过' };
  }
}

/* 内存里的配置模型可能落后于磁盘（用户手改、外部脚本改、或者启动瞬间）。
 * 需要用「磁盘上的真实内容」做判断之前，先对一次。 */
function syncModelFromDiskIfChanged() {
  if (!paths.configPath || !fs.existsSync(paths.configPath)) return false;
  try {
    const text = fs.readFileSync(paths.configPath, 'utf8');
    if (configHash && hashText(text) === configHash) return false;
    loadConfigFromDisk();
    return true;
  } catch {
    return false;
  }
}

async function checkExternalConfig() {
  if (!paths.configPath) return;
  let st;
  try {
    st = fs.statSync(paths.configPath);
  } catch {
    /* 文件不在了（被删/被移走/盘符掉线）。以前这里直接 return，界面继续显示最后一次读到的
     * 配置、一句话都不说，用户以为一切正常，实际改文件也不会生效（下次保存又把旧内容写回去）。
     * 现在给一次明确提示，并且等文件回来后再清掉。 */
    if (configHash && !configMissingNotified) {
      configMissingNotified = true;
      configError = `配置文件不在了：${paths.configPath}（被外部删除或移动）。界面显示的是最后一次读到的内容，下次保存会重新写回这个路径。`;
      pushState();
      send('notify', { kind: 'warn', title: '配置文件不见了', message: paths.configPath });
    }
    return;
  }
  configMissingNotified = false;
  if (st.mtimeMs === configStamp.mtimeMs && st.size === configStamp.size) {
    return;
  }
  let text;
  try {
    text = fs.readFileSync(paths.configPath, 'utf8');
  } catch {
    return;
  }
  const hash = hashText(text);
  if (hash === configHash) {
    configStamp = { mtimeMs: st.mtimeMs, size: st.size };
    // 文件内容跟「最后一次成功解析」的一样（比如坏的写完又改回来了）。
    // 如果还挂着上一轮坏文件的解析错误，要清掉，否则界面上会一直红着，
    // 用户把文件改回去也看不到恢复。
    if (configError || configVerifyError) {
      configError = null;
      configVerifyError = null;
      pushState();
    }
    return;
  }
  const beforeClient = settings.clientServerId;
  try {
    model = configModule.parseConfigText(text, { nginxProxyEnabled: yModeEnabled() });
    configHash = hash;
    configStamp = { mtimeMs: st.mtimeMs, size: st.size };
    configError = null;
    updateLogFile();
    /* 先让 frpc 自己校验：不通过就不重载、也不改运行状态，只把原因摆到界面上。
     * 否则 frpc 会带着坏配置退出，界面上只剩「隧道未运行」，看不出为什么。 */
    const verdict = await verifyConfigWithFrpc(paths.configPath);
    if (!verdict.ok) {
      configVerifyError = `frpc 不认这份配置：${verdict.error}`;
      configStamp = { mtimeMs: st.mtimeMs, size: st.size };
      pushState();
      send('notify', { kind: 'error', title: '配置文件有问题', message: verdict.error });
      return;
    }
    configVerifyError = null;
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
    // 坏文件也要记 stamp：否则「坏文件→改回原内容（mtime 恰好等于旧值或被还原）」时
    // stat 与旧 stamp 相同、函数直接 return，界面会永远红着，用户把文件改回去也不恢复。
    configStamp = { mtimeMs: st.mtimeMs, size: st.size };
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

/* 管理端口被别的 frpc 占着时，spawn 出去只会 bind 失败（Go 原文还很难懂），
 * 而设置页里那个"改管理端口"的入口已经撤掉了 —— 所以这里自动挪到下一个空闲端口，
 * 并同步写回 frpc.toml 的 webServer.port 与 settings.adminPort，让隧道照常起来。
 * 返回一句给用户看的说明（没挪则返回空串）。 */
async function ensureAdminPortUsable() {
  if (!model) return '';
  // 自家 frpc 正在跑（或本进程已经握有 API）时不要动端口，否则会把好好的隧道踢掉。
  if (manager.apiOk || manager.isChildAlive) return '';
  const taken = async (port) => tcpCheck('127.0.0.1', port, 400).then((r) => !!(r && r.ok)).catch(() => true);
  if (!(await taken(settings.adminPort))) return '';
  const from = Number(settings.adminPort) || 7400;
  /* 别的连接预留的端口不能用：它们不属于「空闲」，只是还没启动。
   * 不排除的话，A 会挪到 B 的端口上，B 之后永远起不来（而且报的是「被别的 frpc 占用」，
   * 排查方向完全跑偏）。 */
  const reserved = new Set(((settings && settings.connections) || [])
    .filter((conn) => conn && conn.id !== settings.activeConnectionId)
    .map((conn) => Number(conn.adminPort) || 0));
  let picked = 0;
  for (let port = from + 1; port <= Math.min(65535, from + 30); port += 1) {
    if (reserved.has(port)) continue;
    // eslint-disable-next-line no-await-in-loop
    if (!(await taken(port))) { picked = port; break; }
  }
  if (!picked) return '';
  settings = settingsModule.save({ adminPort: picked });
  /* 连接档案上的端口也要跟着改，否则界面读的是旧值、frpc.toml 却是新值。 */
  if (settings.activeConnectionId) {
    settings = settingsModule.save({
      connections: (settings.connections || []).map((conn) => (conn.id === settings.activeConnectionId
        ? { ...conn, adminPort: picked }
        : conn)),
    });
  }
  configModule.ensureAdmin(model, settings);
  const saved = persistModel(model, { reload: false });
  if (!saved.ok) {
    settings = settingsModule.save({
      adminPort: from,
      connections: (settings.connections || []).map((conn) => (conn.id === settings.activeConnectionId
        ? { ...conn, adminPort: from }
        : conn)),
    });
    return '';
  }
  pushState();
  notify('warn', '管理端口被占用，已自动换端口', `本机 ${from} 被另一个 frpc 占着（另一份配置、另一个控制台实例或手工开的 frpc），这次改用 ${picked}，已写进 frpc.toml。`);
  return `管理端口 ${from} 被占用，已自动改用 ${picked}`;
}

/* 插件代理（https2http / https2https）引用的证书文件在本机不存在时，frpc 会拒绝加载
 * 整份配置 —— 表现为「一条都连不上」，报错却是英文的证书读取失败。
 * 启动前先扫一遍，把「哪条代理缺哪个文件」用中文说清楚（1.2.72）。 */
function pluginCertProblems() {  const out = [];
  for (const proxy of (model && model.proxies) || []) {
    const plugin = proxy && proxy.plugin;
    if (!plugin || !plugin.type) continue;
    if (plugin.type !== 'https2http' && plugin.type !== 'https2https') continue;
    const missing = [];
    for (const [field, value] of [['crtPath', plugin.crtPath], ['keyPath', plugin.keyPath]]) {
      const p = String(value || '').trim();
      if (!p) { missing.push(`${field} 未填写`); continue; }
      if (!fs.existsSync(p)) { missing.push(`${field} 不存在：${p}`); continue; }
      /* 文件在但内容不是 PEM（空文件、选错了文件、被截断）时 frpc 同样会拒绝整份配置，
       * 这里粗检一行 header 就能拦住绝大多数误选。 */
      try {
        const head = fs.readFileSync(p, 'utf8').slice(0, 4096);
        const want = field === 'crtPath' ? /-----BEGIN CERTIFICATE-----/ : /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
        if (!want.test(head)) missing.push(`${field} 不是 PEM 格式（${p}）`);
      } catch (error) {
        missing.push(`${field} 读取失败：${(error && error.message) || error}`);
      }
    }
    if (missing.length) out.push({ name: proxy.name, missing });
  }
  return out;
}

function pluginCertProblemError() {
  const problems = pluginCertProblems();
  if (!problems.length) return '';
  const first = problems[0];
  const names = problems.map((p) => p.name).join('、');
  return `代理「${names}」的证书文件不可用（${first.missing.join('；')}）。frpc 会因此拒绝加载整份配置、所有代理都起不来——请到「代理映射」里重新选择证书，或到「HTTPS 证书」页重新签发/部署`;
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
      const code = String((e && e.code) || '');
      const reason = code === 'EPERM' || code === 'EACCES'
        ? '设置文件不可写（可能被设成只读，或被安全软件占用）'
        : code === 'EBUSY'
          ? '设置文件正被其它程序占用'
          : code === 'ENOSPC'
            ? '磁盘空间不足'
            : (e && e.message) || String(e);
      return fail(`保存设置失败：${reason}`);
    }
  });

  async function saveSettingsPatch(patch) {
    const allowed = [
      'frpcPath', 'configPath', 'frpsDashboardUrl', 'serviceName', 'runMode',
      'adminPort', 'adminUser', 'adminPassword', 'autoReload', 'pollIntervalMs', 'closeToTray',
      'startMinimized', 'launchTunnelOnStart', 'autoReconnect', 'serviceAutoDetect', 'logBuffer',
      'stripProxyEnv', 'launchAtLogin', 'vhostHttpPort', 'vhostHttpsPort',
      'acmeEmail', 'dnsProvider', 'certDirs',
    ];
    const clean = {};
    for (const key of allowed) if (patch && Object.prototype.hasOwnProperty.call(patch, key)) clean[key] = patch[key];
    if (clean.certDirs !== undefined) {
      clean.certDirs = (Array.isArray(clean.certDirs) ? clean.certDirs : [])
        .map((d) => String(d || '').trim())
        .filter(Boolean)
        .slice(0, 8);
    }
    /* 开机自启：值没变就不去动系统（否则每次「保存行为设置」都会为一个没改的开关去写注册表，
     * 写不进去就把整次保存丢掉）；真写不进去时退到「启动」文件夹的快捷方式；
     * 两者都不成也只回一条 warning —— 不能让「开机自启」一项否决其它所有设置。 */
    const settingWarnings = [];
    if (clean.launchAtLogin !== undefined) {
      const desired = !!clean.launchAtLogin;
      if (desired === !!settings.launchAtLogin && launchAtLoginSnapshot().enabled === desired) {
        clean.launchAtLogin = desired;
      } else {
        let result = await applyLaunchAtLogin(desired);
        if (!result.ok) {
          const viaShortcut = await writeStartupShortcut(desired);
          if (viaShortcut.ok) {
            result = { ok: true, actual: desired };
            settingWarnings.push('注册表里的开机启动项写不进去，已改用「启动」文件夹里的快捷方式，效果一样。');
          } else {
            console.warn('[settings] 开机自启两条路都失败：', result.error, '|', viaShortcut.error);
            settingWarnings.push(`开机自启没设成功：${result.error}。也可以点下方的「打开启动文件夹」，把 FRP 控制台的快捷方式拖进去（效果一样）。`);
          }
        }
        if (result.ok) clean.launchAtLogin = !!result.actual;
        else delete clean.launchAtLogin;
      }
    }
    if (clean.pollIntervalMs !== undefined) clean.pollIntervalMs = Math.min(30000, Math.max(1000, Number(clean.pollIntervalMs) || 3000));
    /* 端口类字段以前是「静默夹取」：填 70000 会变成 65535、填 0 会变回默认值，界面不吭声，
     * 用户以为自己设成了 70000（或以为填 0 能关掉管理接口）。现在越界直接拒绝保存。 */
    for (const [key, label, fallback] of [
      ['adminPort', '管理 API 端口', 7400],
      ['vhostHttpPort', 'frps 的 HTTP 端口', 80],
      ['vhostHttpsPort', 'frps 的 HTTPS 端口', 443],
    ]) {
      if (clean[key] === undefined) continue;
      if (clean[key] === null || clean[key] === '') { clean[key] = fallback; continue; }
      const n = Number(clean[key]);
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        return fail(`${label}必须是 1 - 65535 的整数，收到「${clean[key]}」`);
      }
      clean[key] = n;
    }
    /* 用户在设置页手填 vhost 端口时，隧道若绑定了档案，要同步写进该档案：
     * 探测/显示按绑定档案解析（boundVhostPorts），只改全局的话界面上看不到任何变化，
     * 用户会以为设置没生效。 */
    if (clean.vhostHttpPort !== undefined || clean.vhostHttpsPort !== undefined) {
      const bound = findServerProfile(settings.clientServerId) || activeServerProfile();
      if (bound) {
        setProfileVhostPorts(
          bound.id,
          clean.vhostHttpPort !== undefined ? clean.vhostHttpPort : bound.vhostHttpPort,
          clean.vhostHttpsPort !== undefined ? clean.vhostHttpsPort : bound.vhostHttpsPort,
        );
      }
    }
    if (clean.adminPort !== undefined && Number(clean.adminPort) === Number(model && model.serverPort)) {
      return fail(`管理 API 端口不能和服务器端口 ${model.serverPort} 相同`);
    }
    if (clean.logBuffer !== undefined) clean.logBuffer = Math.min(2000, Math.max(100, Number(clean.logBuffer) || 600));
    // 日志缓冲上限要立刻作用到正在跑的 LogFollower，否则要等下次启动才生效。
    if (clean.logBuffer) {
      follower.maxLines = clean.logBuffer;
      if (follower.lines.length > follower.maxLines) follower.lines.splice(0, follower.lines.length - follower.maxLines);
    }
    /* 'service'（Windows 服务模式）已经没有入口了：设置页那张卡删掉了，
     * 也没有“把 frpc 装成服务”的按钮。老客户端传上来就归一到 auto，
     * 不让它落到“未检测到 FRP 系统服务”那种死路上。 */
    if (clean.runMode === 'service') clean.runMode = 'auto';
    if (clean.runMode && !['auto', 'managed'].includes(clean.runMode)) delete clean.runMode;
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
    /* frpc.exe 同理：填了但文件不存在就直接报错。
     * 以前只存不查，refreshPaths 发现路径无效会静默回落成"自动发现"的那个，
     * 接口还返回 ok —— 用户选错了 exe，界面看不出来，只有启动隧道时才莫名连到别的版本。 */
    if (clean.frpcPath !== undefined) {
      const wanted = String(clean.frpcPath || '').trim();
      if (wanted) {
        let st = null;
        try { st = fs.statSync(wanted); } catch { st = null; }
        if (!st) return fail(`frpc.exe 不存在：${wanted}`);
        if (st.isDirectory()) return fail(`这是一个文件夹，不是可执行文件：${wanted}`);
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
    const adminWarnings = [];
    if (adminChanged && model) {
      const changed = configModule.ensureAdmin(model, settings);
      if (changed) {
        const saved = persistModel(model, { reload: false });
        /* 写不进去通常是配置本身还有别的问题（全新安装时 serverAddr 还空着就是最常见的一种）。
         * 设置已经保存了，为一个跟口令无关的校验错误整次失败只会让人困惑；
         * 这里如实说明「没写进 frpc.toml」以及补救方式——启动隧道时 ensureAdminConfig 会再写一次。 */
        if (!saved.ok) {
          adminWarnings.push(`管理 API 的端口/口令没能立刻写进 frpc.toml：${saved.error || '未知原因'}。等配置修好后保存一次，或下次启动隧道时会再写。`);
        }
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
    return ok({ state: buildState(), paths: pathsForState(), warnings: [...settingWarnings, ...adminWarnings] });
  }

  /* 开机自启自动写不进去时（注册表 ACL、安全软件、组策略都可能拦），
   * 给用户一个能自己动手的出口：直接打开「启动」文件夹。 */
  ipcMain.handle('app:open-startup-folder', async () => {
    const dir = path.dirname(startupShortcutPath());
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch { /* 目录已存在或没权限，交给下面 openPath 报 */ }
    const err = await shell.openPath(dir);
    if (err) return fail(`打不开启动文件夹：${err}`);
    return ok({ path: dir });
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
    /* 以前未知类型会静默落回「配置文件」，调用方拿到 ok 但其实打开的是别的东西；
     * 现在只认这三个，别的一律报错，找不到目标也如实说。 */
    const known = { log: paths.logPath, frpc: paths.frpcPath, config: paths.configPath };
    if (!Object.prototype.hasOwnProperty.call(known, which)) {
      return fail(`不认识的路径类型「${which}」，可用：config / frpc / log`);
    }
    const target = known[which];
    if (!target) return fail('路径尚未设置');
    if (!fs.existsSync(target)) return fail(`文件不存在：${target}`);
    shell.showItemInFolder(target);
    return ok({ revealed: true, path: target });
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
    }, { nginxProxyEnabled: yModeEnabled() });
    clean._sourceText = model._sourceText;
    const validation = configModule.validate(clean, { allowPorts: serverAllowPorts() });
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
    /* 连接参数变了、隧道还在跑：frpc 不会自己换服务器，直接重启一次。
     * 不重启的话界面显示「已连接」，实际连的还是旧的那台。 */
    let restarted = false;
    let restartError = '';
    if (connChanged && manager && manager.isChildAlive) {
      const r = await manager.restart({ runMode: settings.runMode });
      restarted = !!(r && r.ok !== false);
      if (restarted) startedFingerprint = configModule.connFingerprint(model);
      else restartError = String((r && r.error) || '重启失败');
      await manager.refresh().catch(() => {});
      healthCache.clear();
      scheduleHealth(1200);
      pushState();
    }
    return ok({ state: buildState(), reloaded: result.reloaded, restartRecommended: connChanged, restarted, restartError });
  });

  /* frpc.toml 原文（配置编辑器用）：读、校验、保存。 */
  const verifyFrpcRaw = async (content) => {
    if (!paths.frpcPath || !fs.existsSync(paths.frpcPath)) return { ok: false, error: '未找到 frpc.exe，无法校验配置' };
    const dir = paths.configPath ? path.dirname(paths.configPath) : (paths.frpcPath ? path.dirname(paths.frpcPath) : process.cwd());
    const tmp = path.join(dir, `.frpc-verify-${process.pid}.toml`);
    try {
      fs.writeFileSync(tmp, String(content || ''), 'utf8');
      const r = await execFileP(paths.frpcPath, ['verify', '-c', tmp], { timeout: 10000 });
      const out = `${r.stdout || ''}\n${r.stderr || ''}`.trim();
      if (r.ok) return { ok: true, output: out };
      const firstErr = String(out || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).find((l) => /error|invalid|fail|unknown/i.test(l)) || out;
      return { ok: false, error: firstErr || '配置校验失败' };
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  };

  ipcMain.handle('config:raw', async () => {
    try {
      if (!paths.configPath) return fail('尚未配置 frpc.toml 路径');
      if (!fs.existsSync(paths.configPath)) return fail('frpc.toml 不存在');
      return ok({ content: fs.readFileSync(paths.configPath, 'utf8'), path: paths.configPath });
    } catch (e) {
      return fail(String((e && e.message) || e));
    }
  });

  ipcMain.handle('config:verify-raw', async (event, payload = {}) => {
    const content = String(payload.content || '');
    if (!content.trim()) return fail('配置内容为空');
    const verify = await verifyFrpcRaw(content);
    return verify.ok ? ok({ valid: true, output: verify.output }) : fail(`配置校验不通过：${verify.error}`, { valid: false });
  });

  ipcMain.handle('config:save-raw', async (event, payload = {}) => {
    const content = String(payload.content || '');
    const restart = !!payload.restart;
    if (!content.trim()) return fail('配置内容为空');
    if (!paths.configPath) return fail('尚未配置 frpc.toml 路径');
    const verify = await verifyFrpcRaw(content);
    if (!verify.ok) return fail(`配置校验不通过：${verify.error}`, { valid: false });
    const write = configModule.writeRawConfig(paths.configPath, content);
    if (write.ok === false) return fail(write.error, { valid: true });
    loadConfigFromDisk();
    let restarted = false;
    let reloadError = null;
    if (restart) {
      suppressExitUntil = Date.now() + 15000;
      const r = await manager.restart({ runMode: settings.runMode });
      restarted = r && r.ok;
      if (!restarted) reloadError = (r && r.error) || '重启 frpc 失败';
    } else if (manager && manager.apiOk) {
      const r = await manager.reload().catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
      if (r && !r.ok) reloadError = r.error;
    }
    await manager.refresh().catch(() => {});
    healthCache.clear();
    scheduleHealth(900);
    pushState();
    if (reloadError) return fail(`配置已保存，但${restart ? '重启' : '热重载'}失败：${reloadError}`, { state: buildState(), changed: write.changed, backup: write.backup });
    return ok({ state: buildState(), changed: write.changed, backup: write.backup, restarted });
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
    const yMode = yModeEnabled();
    const proxy = configModule.makeProxy(input, { nginxProxyEnabled: yMode });
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
    }, { nginxProxyEnabled: yMode });
    if (mode === 'add' && model.proxies.some((p) => p.name === proxy.name)) {
      return { ok: false, error: `代理名称「${proxy.name}」已存在`, validation: configModule.validate(next, { allowPorts: serverAllowPorts() }) };
    }
    /* frpc 顶层 start = [...] 是「只启动列表里的代理」的白名单（手改配置时常见）。
     * 在界面上新建/改名的代理如果不在名单里，frpc 会静默跳过它 —— 用户只会看到
     * 「隧道未建立」。这里把它补进名单，并把这件事说出来，而不是让配置偷偷失效。 */
    const startPatch = startListPatch(next, {
      add: proxy.name,
      remove: mode === 'edit' && originalName && originalName !== proxy.name ? originalName : '',
    });
    if (startPatch) next._extra = { ...(next._extra || {}), start: startPatch.list };
    const validation = configModule.validate(next, { allowPorts: serverAllowPorts() });
    if (validation.errors.length) {
      return { ok: false, error: validation.errors[0].message, errors: validation.errors, validation };
    }
    /* 访问路径：类型不对就忽略（udp/stcp 这类没有「点开」这回事），
     * 字符不合规直接报错而不是悄悄丢掉——用户填了半天路径却什么都没保存，比报错更难查。 */
    const rawOpenPath = String(input.openPath === undefined || input.openPath === null ? '' : input.openPath).trim();
    let openPath = '';
    let openPathIgnored = false;
    if (rawOpenPath) {
      if (!openPathAllowedForType(proxy.type)) {
        // 类型不允许时静默忽略不礼貌，放进 warnings 里说明
        openPathIgnored = true;
      } else if (rawOpenPath.length > 200) {
        /* 以前是「悄悄截到 200 字符」：用户贴了一大串路径，存下来的却是前半截，
         * 公网访问自然 404，还查不出为什么。宁可报错。 */
        return {
          ok: false,
          error: `访问路径太长（${rawOpenPath.length} 字符，最长 200 字符）。只填路径部分即可，例如 /panel/。`,
          validation,
        };
      } else {
        openPath = normalizeOpenPath(rawOpenPath);
        if (!openPath) {
          return {
            ok: false,
            error:
              `访问路径「${rawOpenPath}」不合法。规则：只填路径部分（以 / 开头），` +
              '只用 URL 安全字符（字母 数字 - . _ ~ / % ! $ & \' ( ) * + , = : @ ?）；' +
              '不能有空格、引号、分号、反斜杠、换行，也不能出现 ..；' +
              '中文请用百分号编码（「/中文/」写成 /%E4%B8%AD%E6%96%87/，例如 /panel/）',
            validation,
          };
        }
      }
    }
    const proxyWarnings = certCoverageWarnings(proxy);
    /* 这条代理自己的校验警告（公网端口撞服务器端口、浏览器禁用端口、不在 allowPorts 里…）
     * 以前只留在 state.validation 里，用户保存完只看到一句「已保存」，等 frps 拒绝注册才发现。
     * 这里挑出属于这条代理的那几条，交给界面在保存后直接提示。 */
    const savedIndex = next.proxies.findIndex((p) => p.name === proxy.name && p.type === proxy.type);
    if (savedIndex >= 0) {
      const prefix = `proxies[${savedIndex}].`;
      for (const w of validation.warnings) {
        if (w && typeof w.field === 'string' && w.field.startsWith(prefix) && !proxyWarnings.includes(w.message)) {
          proxyWarnings.push(w.message);
        }
      }
    }
    if (openPathIgnored) {
      proxyWarnings.push(`${proxy.type} 类型的代理没有「访问路径」：已忽略填写的 ${rawOpenPath}`);
    }
    if (startPatch && startPatch.added) {
      proxyWarnings.push(`配置里有 start 列表（只启动列出的代理）：已把「${proxy.name}」加进列表，否则 frpc 会跳过这条代理`);
    }
    /* 方案 Y：用户填了 https 类型或 TLS 插件，被自动纠正成纯 http 时明确告知，
     * 免得「我明明选了 https 怎么变成 http」的困惑。 */
    const wantedTls = String(input.type || '').toLowerCase() === 'https' || !!(input.plugin && input.plugin.type);
    if (yMode && wantedTls && proxy.type === 'http') {
      proxyWarnings.push('此服务器已由 nginx 统一终止 TLS：已自动改为 http 类型（无需证书插件），浏览器访问 https://域名 即可');
    }
    const result = await applyAndMaybeReload(next);
    if (!result.ok) return result;
    /* 访问路径存在我们这边（frpc.toml 不认这个字段）。改名时把旧名下的记录搬过来，
     * 免得「改个名访问路径就丢了」。 */
    if (mode === 'edit' && originalName && originalName !== proxy.name) dropProxyOpenPath(originalName);
    setProxyOpenPath(proxy.name, openPath);
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
    }, { nginxProxyEnabled: yModeEnabled() });
    healthCache.delete(name);
    dropProxyOpenPath(name);
    /* 删掉的代理还留在 start 名单里是无害的（frpc 忽略不存在的名字），
     * 但会越积越脏，顺手清掉；名单本身不动其它条目。 */
    const startPatch = startListPatch(next, { remove: name });
    if (startPatch) next._extra = { ...(next._extra || {}), start: startPatch.list };
    const result = await applyAndMaybeReload(next);
    if (!result.ok) return result;
    pushState();
    return ok({ state: result.state, reloaded: result.reloaded });
  });

  /* 端口建议/随机：找不到时必须说清原因。以前只回 {port:null}，
   * 界面把 null 写进输入框等于什么都不发生，用户以为按钮坏了。 */
  const noPortReason = (allowPorts) => {
    if (allowPorts && allowPorts.length) {
      return `服务器的 allowPorts（${configModule.formatAllowPorts(allowPorts)}）里已经没有空闲端口了`;
    }
    return '10000–64999 之间没找到空闲端口（代理数量太多？）';
  };

  ipcMain.handle('proxy:suggest-port', async (event, type) => {
    if (!model) return ok({ port: 10000 });
    const allowPorts = (serverConfig.summary && serverConfig.summary.allowPorts) || [];
    const port = configModule.suggestRemotePort(model, type, { allowPorts });
    return ok(port ? { port } : { port: null, reason: noPortReason(allowPorts) });
  });

  ipcMain.handle('proxy:random-port', async (event, type) => {
    if (!model) return ok({ port: 10000 });
    const allowPorts = (serverConfig.summary && serverConfig.summary.allowPorts) || [];
    const port = configModule.randomRemotePort(model, type, { allowPorts });
    return ok(port ? { port } : { port: null, reason: noPortReason(allowPorts) });
  });

  ipcMain.handle('proxy:check-port', async (event, payload) => {
    /* 兼容旧调用（直接传数字）与新的 { port, proto }：proto 决定查哪条防火墙规则。 */
    const raw = payload && typeof payload === 'object' ? payload.port : payload;
    const proto = payload && typeof payload === 'object' && payload.proto === 'udp' ? 'udp' : 'tcp';
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return fail('端口必须是 1 - 65535 的整数');
    if (!serverSession.connected) return fail('尚未连接服务器，无法检测端口占用');
    const result = await serverSession.checkPortInUse(n);
    if (!result.ok) return fail(result.error);
    const allowPorts = (serverConfig.summary && serverConfig.summary.allowPorts) || [];
    const allowOk = configModule.portInAllowList(n, allowPorts);
    /* 防火墙这一层单独查：端口没被占、allowPorts 也允许，但防火墙没放行的时候，
     * 配好的隧道照样连不上（实测广州机就是这样，用户以为是程序坏了）。 */
    const firewall = await serverSession.checkFirewallPort(n, proto).catch((error) => ({
      ok: false, manager: '', active: false, allowed: null, detail: String((error && error.message) || error),
    }));
    return ok({
      port: n,
      proto,
      inUse: result.inUse,
      process: result.process,
      pid: result.pid,
      allowOk,
      allowPortsText: configModule.formatAllowPorts(allowPorts),
      firewall,
    });
  });

  ipcMain.handle('tunnel:start', async () => {
    /* 还没配好就直接 spawn，只会弹出 "spawn EPERM" 这种没人看得懂的错误，
     * 所以先在主进程里把缺的前提说清楚。 */
    const missing = tunnelPrerequisiteError();
    if (missing) return fail(missing, { state: buildState() });
    /* 插件证书缺失会让 frpc 整份配置加载失败（不是这一条代理不通，是全部不通），
     * 所以启动前就说清楚是哪几条、缺哪个文件，别等 frpc 报一段英文。 */
    const certProblem = pluginCertProblemError();
    if (certProblem) return fail(certProblem, { state: buildState() });
    const adminNote = await ensureAdminPortUsable();
    await refreshService({ detect: true });
    /* 用户点了启动 = 希望隧道是开着的；就算这次失败，也该由守护继续试，
     * 而不是让他每隔几秒回来点一次。 */
    tunnelDesired = true;
    const result = await manager.start({ runMode: settings.runMode });
    await manager.refresh().catch(() => {});
    healthCache.clear();
    scheduleHealth(1500);
    pushState();
    if (!result.ok) {
      if (supervisor) supervisor.arm(result.error || '启动失败');
      return fail(result.error, { state: buildState() });
    }
    startedFingerprint = configModule.connFingerprint(model);
    if (supervisor) supervisor.cancel('');
    return ok({ state: buildState(), mode: result.mode, adminNote: adminNote || '' });
  });

  ipcMain.handle('tunnel:stop', async () => {
    suppressExitUntil = Date.now() + 12000;
    startedFingerprint = '';
    tunnelDesired = false;
    if (supervisor) supervisor.cancel('用户停止了隧道');
    await refreshService({ detect: false });
    const result = await manager.stop({ runMode: settings.runMode });
    await manager.refresh().catch(() => {});
    pushState();
    if (!result.ok) return fail(result.error, { state: buildState() });
    return ok({ state: buildState(), mode: result.mode });
  });

  ipcMain.handle('tunnel:restart', async () => {
    const certProblem = pluginCertProblemError();
    if (certProblem) return fail(certProblem, { state: buildState() });
    await refreshService({ detect: false });
    suppressExitUntil = Date.now() + 15000;
    const result = await manager.restart({ runMode: settings.runMode });
    await manager.refresh().catch(() => {});
    pushState();
    if (!result.ok) return fail(result.error, { state: buildState() });
    tunnelDesired = true;
    if (supervisor) supervisor.cancel('');
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

  /* ===== 多连接（阶段 2：只提供“看清 + 单独启停”的能力，界面暂不展示）=====
   * 现有 tunnel:* IPC 全部作用于「当前选中」的连接，语义不变；
   * 这三个接口按 id 操作某一条，供后续界面与自动化使用。 */
  ipcMain.handle('connections:list', async () => ok({
    activeConnectionId: settings.activeConnectionId,
    connections: (settings.connections || []).map(connectionSummary),
  }));

  ipcMain.handle('connections:start', async (event, connId) => {
    const conn = connectionById(String(connId || ''));
    if (!conn) return fail('连接不存在（可能已被删除）');
    if (!conn.configPath) return fail('这条连接还没有配置文件：先给它选一个 frpc.toml');
    if (!conn.enabled) return fail('这条连接被设为不启用');
    if (conn.id === settings.activeConnectionId) {
      /* 当前连接走原路径：它还要处理服务模式、端口冲突提示、插件证书校验等。 */
      const result = await manager.start({ runMode: settings.runMode });
      await manager.refresh().catch(() => {});
      if (result.ok) {
        tunnelDesired = true;
        startedFingerprint = configModule.connFingerprint(model);
        if (supervisor) supervisor.cancel('');
      }
      pushState();
      return result.ok ? ok({ connection: connectionSummary(conn) }) : fail(result.error, { connection: connectionSummary(conn) });
    }
    /* 外部可能刚改过这份配置：启动前必须重新读，否则用旧模型补齐 webServer/做健康检查。 */
    invalidateConnectionModel(conn.id);
    const mm = managerForConnection(conn.id);
    if (!mm) return fail('多连接运行期还没准备好');
    /* 非当前连接一律托管进程：服务模式只能有一台（否则要处理 nssm 多实例与 UAC）。 */
    const result = await mm.start({ runMode: 'managed' });
    await mm.refresh().catch(() => {});
    pushState();
    if (!result.ok) return fail(result.error, { connection: connectionSummary(conn) });
    return ok({ connection: connectionSummary(conn), mode: result.mode });
  });

  ipcMain.handle('connections:stop', async (event, connId) => {
    const conn = connectionById(String(connId || ''));
    if (!conn) return fail('连接不存在（可能已被删除）');
    if (conn.id === settings.activeConnectionId) {
      suppressExitUntil = Date.now() + 12000;
      tunnelDesired = false;
      startedFingerprint = '';
      if (supervisor) supervisor.cancel('用户停止了隧道');
      const result = await manager.stop({ runMode: settings.runMode });
      await manager.refresh().catch(() => {});
      pushState();
      return result.ok ? ok({ connection: connectionSummary(conn) }) : fail(result.error, { connection: connectionSummary(conn) });
    }
    const mm = managerForConnection(conn.id);
    if (!mm) return fail('多连接运行期还没准备好');
    const guard = multiConnection && multiConnection.guards.get(conn.id);
    if (guard) guard.cancel('用户停止了这条连接');
    if (multiConnection) multiConnection.stopRequests.set(conn.id, Date.now());
    const result = await mm.stop({ runMode: 'managed' });
    await mm.refresh().catch(() => {});
    pushState();
    return result.ok ? ok({ connection: connectionSummary(conn) }) : fail(result.error, { connection: connectionSummary(conn) });
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
    /* 读不到文件时不要把旧指纹留着：留着的话，「文件被删了」在指纹比对里永远显示成「没变化」，
     * 界面会一直停在删除前那份摘要上（真机 rm /etc/frp/frps.toml 复现过）。 */
    const stampNow = await serverSession.fileStamp(serverSession.configPath || configResult.path);
    serverConfigStamp = stampNow || (configResult.ok ? serverConfigStamp : '');
    if (configResult.ok) {
      const parsed = frpsConfig.parseConfig(configResult.content);
      serverConfig = {
        path: configResult.path,
        content: configResult.content,
        summary: parsed.ok ? frpsConfig.summary(parsed.data) : null,
        error: parsed.ok ? '' : `配置解析失败：${parsed.error}`,
      };
      /* 文件能读出来不等于 frps 认它：服务器上被人手改过（塞错字段、写坏引号）时，
       * 现在是「读进来、界面上看着一切正常」，可一旦重启 frps 就起不来。
       * 用服务器自己的 frps verify 过一遍，不通过就把错误摊在配置卡上。 */
      if (parsed.ok) {
        const verified = await serverSession.verifyConfigFile(configResult.path).catch(() => ({ ok: true, skipped: true }));
        if (!verified.ok) {
          serverConfig.error = `服务器上的 frps.toml 校验没通过：${verified.message}（现在跑着的还是旧配置，但重启 frps 或重启机器后会起不来）`;
        }
      }
    } else {
      serverConfig = { path: serverSession.configPath || '', content: '', summary: null, error: configResult.error || '' };
    }
    /* 服务器页已经拿到真实 Dashboard 端口，就把「打开服务器面板」的地址记住，
     * 概览/tray 才不至于重启后还跳回默认的 7500。只在用户没手动设过时自动填。 */
    if (serverConfig.summary && serverConfig.summary.webPort && serverSession.host) {
      const discovered = `http://${serverSession.host}:${serverConfig.summary.webPort}`;
      const dashProfile = profileForSession(serverSession);
      if (dashProfile) setProfileDashboardUrl(dashProfile.id, discovered);
      // 全局值只当「没连服务器时」的兜底：它属于这台机器才用，属于别人就换成这台的。
      if (hostOfUrl(settings.frpsDashboardUrl) !== String(serverSession.host || '').toLowerCase()) {
        settings = settingsModule.save({ frpsDashboardUrl: discovered });
      }
    }
    /* 服务器页已经拿到真实 vhost 端口，同步到「这台服务器」的档案：否则应用重启后
     * 还没重连服务器页，概览健康检查会拿旧的 vhost 端口去探 http/https 代理，
     * 把它们误报成「公网不可达」。服务器实际配置才是权威来源。
     * 全局 settings.vhostHttpPort 继续跟着写（作为「隧道没绑定任何档案」时的兜底），
     * 但探测/显示优先读绑定档案——否则连了 A 再切回 B 会被 A 的端口污染。 */
    if (serverConfig.summary) {
      const vh = Number(serverConfig.summary.vhostHTTPPort) || 0;
      const vs = Number(serverConfig.summary.vhostHTTPSPort) || 0;
      const vhostProfile = profileForSession(serverSession);
      if (vhostProfile && (vh > 0 || vs > 0)) setProfileVhostPorts(vhostProfile.id, vh, vs);
      if (vh > 0 && Number(settings.vhostHttpPort) !== vh) settings = settingsModule.save({ vhostHttpPort: vh });
      if (vs > 0 && Number(settings.vhostHttpsPort) !== vs) settings = settingsModule.save({ vhostHttpsPort: vs });
    }
    /* nginx 反代状态同步：服务器上 frp-console.conf 是否存在，决定 http/https 代理的
     * 公网地址要不要带内网端口（8080/8443）。每次连服务器 / 刷新都轻量检测一次，
     * 用户不用再去服务器页手动点「nginx 检测」，新建代理时地址就是对的。 */
    try {
      const proxyConfigured = await serverSession.nginxProxyConfigured();
      // 状态是「这台服务器」的：写进对应档案，而不是全局开关。
      setProfileNginxProxy(profileForSession(serverSession).id, proxyConfigured);
    } catch { /* nginx 检测失败不影响主流程 */ }
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

  /* 重新抓一次服务器信息（hostname / OS / frps 状态与版本 / 配置路径）。
   * 服务器是会被手动折腾的：停服务、升级二进制、直接改 frps.toml。界面上的
   * 「运行状态」如果一直用连接瞬间的快照，就会出现「自检说 frps 没有运行、
   * 卡片头还写着 running」这种自相矛盾（真机故障注入发现）。 */
  /* ---- SSH 主机指纹：查看 / 信任新指纹 / 忘记 ---- */
  ipcMain.handle('server:known-hosts', async () => ok({ hosts: knownHosts.list() }));
  ipcMain.handle('server:trust-host', async (_event, payload = {}) => {
    const host = String((payload && payload.host) || '').trim();
    const port = Number(payload && payload.port) || 22;
    const fingerprint = String((payload && payload.fingerprint) || '').trim();
    if (!host) return fail('缺少主机地址');
    if (!/^SHA256:[A-Za-z0-9+/]+$/.test(fingerprint)) return fail('指纹格式不对（应为 SHA256:…）');
    knownHosts.trust(host, port, fingerprint);
    console.log(`[ssh] 用户确认信任 ${host}:${port} 的新指纹 ${fingerprint}`);
    return ok({ host, port, fingerprint, hosts: knownHosts.list() });
  });
  ipcMain.handle('server:forget-host', async (_event, payload = {}) => {
    const host = String((payload && payload.host) || '').trim();
    const port = Number(payload && payload.port) || 22;
    if (!host) return fail('缺少主机地址');
    knownHosts.forget(host, port);
    return ok({ host, port, hosts: knownHosts.list() });
  });

  ipcMain.handle('server:recheck', async () => {
    if (!serverSession.connected) return fail('尚未连接服务器');
    const epoch = sessionEpoch;
    const inspected = await serverSession.inspect();
    if (epoch !== sessionEpoch) return staleFail();
    if (!inspected.ok) return fail(inspected.error || '读取服务器信息失败');
    /* frps.toml 被外部改过？（改 bindPort、加 allowPorts 之类）
     * 客户端 frpc.toml 有 checkExternalConfig，服务器侧一直没对应机制，
     * 结果界面上的配置摘要会一直是连接时那份旧值。 */
    const stamp = await serverSession.fileStamp(serverSession.configPath || inspected.configPath || '');
    if (epoch !== sessionEpoch) return staleFail();
    let drifted = false;
    /* 文件之前是有的（serverConfigStamp 非空），现在读不到指纹 = 被删掉或改名了。
     * 这种情况以前被 `stamp &&` 挡在外面，摘要就一直显示删除前那份。 */
    const gone = !stamp && !!serverConfigStamp;
    if (gone || (stamp && serverConfigStamp && stamp !== serverConfigStamp)) {
      const snap = await loadServerSnapshot({ inspect: false });
      if (epoch !== sessionEpoch) return staleFail();
      drifted = !!snap.ok;
      if (drifted) {
        notify(
          'warn',
          gone ? '服务器上的 frps.toml 不见了' : '服务器上的 frps.toml 被外部修改了',
          gone ? '可能被删掉或改名了；界面上的配置摘要已清空，确认后可以重新写入或从零初始化' : '已重新读取，界面上的端口/允许端口等摘要已更新',
        );
        pushState();
      }
    }
    return ok({
      info: serverSession.info || null,
      epoch: sessionEpoch,
      configPath: inspected.configPath || '',
      drifted,
      stamp: stamp || '',
    });
  });

  /* 手动「整理重复档案」：与启动时的自动迁移同一套逻辑，幂等，随时可按。 */
  ipcMain.handle('server:profiles-dedupe', async () => {
    const result = dedupeServerProfiles();
    if (result.changed) {
      notify('info', '已合并重复的服务器档案', `${result.before} 条 → ${result.after} 条：${result.summary || ''}`);
      pushState();
    }
    return ok({ ...result, state: serverState(), backupError: result.backupError || '' });
  });

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
    /* 表单连接没带档案时，先看是不是连「同一台机器」——有就复用，别每次新建一条同名档案。
     * 复用后仍会走下面的 upsert 更新地址/端口，并把 activeServerId 指过去。 */
    if (!profile) profile = findServerProfileByKey({ host, port });
    const wasNew = !profile;
    if (!profile) profile = upsertServerProfile({ host, port, username, name: host });
    if (!password) password = settingsModule.readServerSecret(profile.id);
    if (!password) return fail(changed ? '档案地址已变更，请重新输入 SSH 密码' : '请输入密码', { needsPassword: true, state: serverState() });

    // 会话即将变更：让所有在途的读请求结果失效，防止旧档案的数据回写到新页面。
    bumpSessionEpoch();
    const myEpoch = sessionEpoch;
    const result = await serverSession.connect({ host, port, username, password, onHostKey: hostKeyGuard });
    // SSH 连接期间用户可能删掉了这个档案 / 切到了别的档案：此时必须放弃这次连接，
    // 不能继续 upsert（会偷偷重建一个档案），更不能去读配置回写页面。
    if (sessionEpoch !== myEpoch) {
      serverSession.disconnect();
      sessionServerId = '';
      serverConfig = { path: '', content: '', summary: null, error: '' };
      return fail('连接期间服务器档案已变更，本次连接已取消', { stale: true, state: serverState() });
    }
    if (!result.ok) {
      // 连接失败：这次临时新建的档案不能留着——否则用户只是手滑输错端口 / 网络不通，
      // 列表里就多一条永远连不上的“垃圾档案”，还会把 activeServerId 顶到这条废档案上。
      if (wasNew) {
        const rest = serverProfiles().filter((item) => item.id !== profile.id);
        settings = settingsModule.save({
          servers: rest,
          activeServerId: settings.activeServerId === profile.id ? (rest[0] ? rest[0].id : '') : settings.activeServerId,
        });
      }
      /* 主机指纹不一致：把两份指纹原样带给界面，让用户自己确认（不能自动放行）。 */
      if (result.needsTrustHost) {
        return fail(result.error, { state: serverState(), needsTrustHost: result.needsTrustHost });
      }
      return fail(sshConnectHint(result.error), { state: serverState() });
    }
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
    send('server:session-changed', { connected: true, host: serverSession.host || host });
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
    send('server:session-changed', { connected: false });
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

  let bootstrapCancelRequested = false;

  ipcMain.handle('server:bootstrap', async (event, payload = {}) => {
    if (!serverSession.connected) return fail('尚未连接服务器');
    bootstrapCancelRequested = false;
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
      if (!binary.ok) return fail(withOutboundHint(binary.error, '下载 frps 二进制'));
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
      shouldCancel: () => bootstrapCancelRequested,
    });
    if (result.cancelled) return fail(result.error || '初始化已取消', { cancelled: true, steps: result.steps || [] });
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
    return ok({
      ...result,
      localSync,
      /* 面板密码留空时我们自动生成了一个：这里带回去让界面提示用户记下。 */
      generatedPassword: generated.generatedPassword || '',
      generatedToken: generated.generatedToken || '',
      warnings: generated.warnings || [],
      state: serverState(),
      appState: buildState(),
    });
  });

  ipcMain.handle('server:bootstrap-cancel', async () => {
    bootstrapCancelRequested = true;
    return ok(true);
  });

  /* 卸载 frps：停服务/删 unit/删二进制/备份后删配置（可恢复）。 */
  ipcMain.handle('server:uninstall', async (event, payload = {}) => {
    if (!serverSession.connected) return fail('尚未连接服务器');
    try {
      const result = await serverSession.uninstall({ removeConfig: payload.removeConfig !== false });
      if (!result.ok) return fail(result.error);
      await loadServerSnapshot({ inspect: true });
      return ok({ ...result, state: serverState(), appState: buildState() });
    } catch (e) {
      return fail(String((e && e.message) || e));
    }
  });

  /* ---- nginx 反代（方案 Y）---- */

  ipcMain.handle('server:nginx-state', async () => {
    if (!serverSession.connected) return fail('尚未连接服务器');
    try {
      const det = await serverSession.detectNginx();
      // 缓存最近一次 nginx 检测：端口矩阵要用 80/443 是否在监听、是否被非 nginx 占用，
      // 又不想为它多跑一轮 SSH（服务器页进来就会先拉一次 nginx 状态）。
      lastNginxState = { ...det, at: Date.now(), serverHost: serverSession.host };
      // 同步 nginx 反代状态：frp-console.conf 是否存在，决定 http/https 代理的公网地址要不要带端口。
      // 状态属于「这台服务器」，写进对应档案。
      setProfileNginxProxy(profileForSession(serverSession).id, det.proxyConfigured);
      return ok(det);
    } catch (e) {
      return fail(String((e && e.message) || e));
    }
  });

  /* 一键配置 nginx 反代：检测 →（缺则）安装 → 检查 80/443 冲突 → 找一张生产证书 → 上传 + 写配置 + reload。 */
  ipcMain.handle('server:nginx-setup', async (event, payload = {}) => {
    if (!serverSession.connected) return fail('尚未连接服务器');
    try {
      let detect = await serverSession.detectNginx();
      if (!detect.installed) {
        const install = await serverSession.installNginx();
        if (!install.ok) return fail(install.error);
        detect = await serverSession.detectNginx();
      }
      // 80/443 被 nginx 之外的程序占用时，nginx 无法绑定标准端口，反代不起作用。
      // 这里不硬来，返回冲突报告，交给前端弹窗让用户决定「终止占用进程」或「取消」。
      if (detect.port80Conflict || detect.port443Conflict) {
        const conflicts = [
          detect.port80Conflict ? { port: 80, by: detect.port80By, pids: detect.port80Pids } : null,
          detect.port443Conflict ? { port: 443, by: detect.port443By, pids: detect.port443Pids } : null,
        ].filter(Boolean);
        return ok({ conflict: true, conflicts, installed: detect.installed, running: detect.running });
      }
      const certs = acmeManager.list();
      const cert = certs.find((c) => c.exists) || null;
      if (!cert) {
        return ok({
          installed: detect.installed,
          running: detect.running,
          certMissing: true,
          message: 'nginx 已就绪，但还没有可用的证书。请先到「HTTPS 证书」页签发一张，再回来配置反代。',
        });
      }
      const sync = await syncCertToServerNginx(cert);
      return ok({ installed: detect.installed, running: detect.running, ...sync });
    } catch (e) {
      return fail(String((e && e.message) || e));
    }
  });

  /* 手动开启 vhost 端口（代理表单里「服务器未开 vhostHTTPPort」提示旁边的「一键开启」）。 */
  ipcMain.handle('server:vhost-enable', async (event, payload = {}) => {
    if (!serverSession.connected) return fail('尚未连接服务器');
    try {
      const r = await ensureVhostPort(payload && payload.kind === 'https' ? 'https' : 'http');
      if (!r.ok) return fail(r.error || '开启 vhost 端口失败', { state: serverState() });
      return ok({ ...r, state: serverState() });
    } catch (e) {
      return fail(String((e && e.message) || e), { state: serverState() });
    }
  });

  /* 终止占用 80/443 的非 nginx 进程，然后重新探测（供前端「终止占用进程并继续」调用）。 */
  ipcMain.handle('server:nginx-free', async () => {
    if (!serverSession.connected) return fail('尚未连接服务器');
    try {
      const detect = await serverSession.detectNginx();
      const pids = [
        ...(detect.port80Conflict ? (detect.port80Pids || []) : []),
        ...(detect.port443Conflict ? (detect.port443Pids || []) : []),
      ];
      const kill = await serverSession.killPids(pids);
      await new Promise((r) => setTimeout(r, 800));
      const after = await serverSession.detectNginx();
      return ok({ killed: kill.killed, note: kill.note, after });
    } catch (e) {
      return fail(String((e && e.message) || e));
    }
  });

  /* 配置体检（1.2.72）：nginx -t + 所有 ssl_certificate 文件是否还在。
   * 只读，缓存 60 秒（一次体检要跑 grep + test -f，别每次重画卡片都跑）。 */
  ipcMain.handle('server:nginx-health', async (event, payload = {}) => {
    if (!serverSession.connected) return fail('尚未连接服务器');
    const force = !!(payload && payload.force);
    const host = serverSession.host;
    if (!force && nginxHealthCache && nginxHealthCache.host === host && Date.now() - nginxHealthCache.at < 60000) {
      return ok(nginxHealthCache.data);
    }
    try {
      const health = await serverSession.checkNginxHealth();
      if (!health.ok) return fail(health.error || '配置体检失败');
      nginxHealthCache = { at: Date.now(), host, data: health };
      return ok(health);
    } catch (e) {
      return fail(String((e && e.message) || e));
    }
  });

  /* 一键修复：只动我们自己生成的 frp-console.conf（别人家的配置只报告不碰）。 */
  ipcMain.handle('server:nginx-repair', async (event, payload = {}) => {
    if (!serverSession.connected) return fail('尚未连接服务器');
    try {
      const paths = Array.isArray(payload && payload.paths) ? payload.paths : [];
      const repair = await serverSession.repairNginxCertRefs({ paths });
      if (!repair.ok) return fail(repair.error || '修复失败');
      nginxHealthCache = null;
      /* 没有 frp-console.conf 时会话层已经处理；缓存清掉让界面重新体检一次 */
      const health = await serverSession.checkNginxHealth().catch(() => null);
      if (health && health.ok) nginxHealthCache = { at: Date.now(), host: serverSession.host, data: health };
      return ok({ ...repair, health: health && health.ok ? health : null });
    } catch (e) {
      return fail(String((e && e.message) || e));
    }
  });

  /* 「其它站点配置」里的悬空引用：只读查看 + 注释掉那条引用（1.2.73）。
   * 不是我们生成的配置，所以不做整块删除，只把引用那几行注释掉并留 backup。 */
  ipcMain.handle('server:nginx-conf-view', async (event, payload = {}) => {
    if (!serverSession.connected) return fail('尚未连接服务器');
    try {
      const view = await serverSession.readConfAround({
        file: payload && payload.file,
        paths: (payload && payload.paths) || [],
      });
      if (!view.ok) return fail(view.error);
      return ok(view);
    } catch (e) {
      return fail(String((e && e.message) || e));
    }
  });

  ipcMain.handle('server:nginx-comment-ref', async (event, payload = {}) => {
    if (!serverSession.connected) return fail('尚未连接服务器');
    try {
      const res = await serverSession.commentCertRef({
        file: payload && payload.file,
        paths: (payload && payload.paths) || [],
      });
      if (!res.ok) return fail(res.error || '注释失败');
      nginxHealthCache = null;
      const health = await serverSession.checkNginxHealth().catch(() => null);
      if (health && health.ok) nginxHealthCache = { at: Date.now(), host: serverSession.host, data: health };
      return ok({ ...res, health: health && health.ok ? health : null });
    } catch (e) {
      return fail(String((e && e.message) || e));
    }
  });

  /* 服务器防火墙：只读状态 + 一键放行 frps 需要监听的端口。 */
  /* 本机 frpc 指向当前服务器时，代理映射的 remotePort 也在 frps 上监听、同样需要防火墙放行。 */
  function proxyRemotePorts() {
    if (!model || !model.serverAddr || !serverSession.host) return [];
    const same = String(model.serverAddr).toLowerCase() === String(serverSession.host).toLowerCase();
    if (!same) return [];
    const out = [];
    const seen = new Set();
    for (const p of model.proxies || []) {
      /* tcpmux 不吃 remotePort（frpc 收到会报 unknown field remotePort），它的入口是
       * frps 的 tcpmuxHTTPConnectPort —— 由 configPorts() 那条线负责，这里排除掉。 */
      if (!p.remotePort || !['tcp', 'udp'].includes(p.type)) continue;
      const proto = p.type === 'udp' ? 'udp' : 'tcp';
      const key = `${proto}:${p.remotePort}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ port: p.remotePort, proto, label: p.name || '代理' });
    }
    return out;
  }

  /* 系统端口（SSH + nginx 80/443）：判定和「一键放行」都要用。
   * nginx 状态用 60 秒缓存，缺失时现查一次（否则刚打开服务器页时矩阵里没有 443）。 */
  async function collectSystemPorts() {
    const out = [];
    if (serverSession.port) out.push({ port: Number(serverSession.port), proto: 'tcp', label: 'SSH' });
    let ng = (lastNginxState && lastNginxState.serverHost === serverSession.host && Date.now() - lastNginxState.at < 60000)
      ? lastNginxState
      : null;
    if (!ng) {
      try {
        ng = { ...(await serverSession.detectNginx()), at: Date.now(), serverHost: serverSession.host };
        lastNginxState = ng;
      } catch { ng = null; }
    }
    if (ng && ng.installed) {
      /* 443/80 是「方案 Y 的入口」，不是必须存在的端口：服务器上还没配 https 站点时 443 本来
       * 就不该有人监听。标成 optional，矩阵里显示「未启用」而不是「没有程序监听」的红色告警，
       * 也不计入问题数（1.2.73）。 */
      const hasTls = Array.isArray(ng.certs) && ng.certs.length > 0;
      const httpsLive = ng.port443Free === false;
      const httpLive = ng.port80Free === false;
      if (httpsLive || (ng.proxyConfigured && hasTls)) out.push({ port: 443, proto: 'tcp', label: 'nginx' });
      else out.push({ port: 443, proto: 'tcp', label: 'nginx', optional: true });
      if (httpLive || ng.proxyConfigured) out.push({ port: 80, proto: 'tcp', label: 'nginx' });
      else out.push({ port: 80, proto: 'tcp', label: 'nginx', optional: true });
    }
    return out;
  }

  ipcMain.handle('server:firewall-state', async () => {
    if (!serverSession.connected) return fail('尚未连接服务器');
    try {
      const det = await serverSession.detectFirewall();
      const cfgPorts = serverConfig.summary ? serverSession.configPorts(serverConfig.content) : [];
      const proxyPorts = proxyRemotePorts();
      /* 系统端口也要参与判定：SSH 是管理通道，nginx 80/443 是方案 Y 的公网入口。
       * 以前这两类完全不在清单里，用户根本看不到「443 有没有被放行」。 */
      const sysPorts = await collectSystemPorts();
      const [allowed, listenPorts] = await Promise.all([
        serverSession.readFirewallAllowed(),
        serverSession.readListenPorts().catch(() => null),
      ]);
      /* 我们现在就通过这条 SSH 连接在说话 —— 那 SSH 端口必然在监听。
       * ss 偶尔读不到（权限、容器内无 ss、输出格式不同）时，别把管理通道误判成「没有程序监听」。 */
      if (listenPorts && listenPorts.tcp && serverSession.port) {
        listenPorts.tcp.add(Number(serverSession.port));
      }
      // S3：从本机实测（TCP 全部实测；UDP 无握手，只在矩阵里按规则给「很可能被拦」）。
      const reachMap = new Map();
      const tcpTargets = [...new Map([...cfgPorts, ...proxyPorts, ...sysPorts]
        .filter((p) => p.proto === 'tcp' && p.port)
        .map((p) => [Number(p.port), p])).values()];
      await Promise.all(tcpTargets.map(async (p) => {
        const r = await probePort({ host: serverSession.host, port: Number(p.port), timeout: 2000 });
        reachMap.set(`tcp:${p.port}`, r.ok === true);
      }));
      /* UDP 也要探一次：没有握手，但服务器会回 ICMP 端口不可达。
       * 拿到 ICMP 就说明「包到了、没人听」，这是 UDP 唯一能确诊的信号。最多探 4 个，避免拖慢刷新。 */
      const udpTargets = [...new Map([...cfgPorts, ...proxyPorts, ...sysPorts]
        .filter((p) => p.proto === 'udp' && p.port)
        .map((p) => [Number(p.port), p])).values()].slice(0, 4);
      await Promise.all(udpTargets.map(async (p) => {
        const r = await probeUdp({ host: serverSession.host, port: Number(p.port), timeout: 1200 }).catch(() => null);
        if (r && r.kind === 'refused') reachMap.set(`udp:${p.port}`, false);
        else if (r && r.ok) reachMap.set(`udp:${p.port}`, true);
      }));
      const withReach = (list) => (list || []).map((p) => ({
        ...p,
        reachable: reachMap.has(`${p.proto}:${p.port}`) ? reachMap.get(`${p.proto}:${p.port}`) : null,
      }));
      const frpsWithReach = withReach(cfgPorts);
      const proxyWithReach = withReach(proxyPorts);
      const sysWithReach = withReach(sysPorts);
      /* 本机隧道是不是正连着这台服务器：决定了代理端口「没在监听」是故障还是正常。 */
      const tunnelActive = !!(model && model.serverAddr && serverSession.host
        && String(model.serverAddr).toLowerCase() === String(serverSession.host).toLowerCase()
        && manager && manager.snapshot().connected);
      const rows = buildPortMatrix({
        cfgPorts: frpsWithReach,
        proxyPorts: proxyWithReach,
        sysPorts: sysWithReach,
        allowed,
        fwActive: !!det.active,
        listenPorts,
        tunnelActive,
      });
      return ok({
        ...det,
        ports: [...frpsWithReach, ...proxyWithReach],
        frpsPorts: frpsWithReach,
        proxyPorts: proxyWithReach,
        sysPorts: sysWithReach,
        sshPort: Number(serverSession.port) || 0,
        allowed,
        matrix: rows,
        conclusion: summarizeMatrix(rows),
        ruleTexts: buildRuleTexts(cfgPorts, proxyPorts, sysPorts, serverSession.port),
      });
    } catch (e) {
      return fail(String((e && e.message) || e));
    }
  });

  /* 单端口探测（前端在「打开面板」「复制规则前校验」等场景直接问一句）。 */
  ipcMain.handle('server:probe-port', async (_event, payload = {}) => {
    const host = String(payload.host || serverSession.host || '').trim();
    const port = Number(payload.port);
    const proto = String(payload.proto || 'tcp').toLowerCase() === 'udp' ? 'udp' : 'tcp';
    if (!host || !port) return fail('缺少主机或端口');
    try {
      const r = proto === 'udp'
        ? await probeUdp({ host, port, timeout: 1200 })
        : await probePort({ host, port, timeout: Number(payload.timeout) || 2000 });
      return ok({ host, port, proto, ...r });
    } catch (e) {
      return fail(String((e && e.message) || e));
    }
  });

  ipcMain.handle('server:firewall-open', async () => {
    if (!serverSession.connected) return fail('尚未连接服务器');
    try {
      const cfgPorts = serverConfig.summary ? serverSession.configPorts(serverConfig.content) : [];
      const proxyPorts = proxyRemotePorts();
      /* 系统端口（SSH、nginx 80/443）也要放：否则用户点完「一键放行」，
       * 矩阵里的 443 依然是红的——那正是这次要解决的场景。 */
      const sysPorts = await collectSystemPorts();
      const ports = [...cfgPorts, ...proxyPorts, ...sysPorts];
      if (!ports.length) return fail('没有可放行的端口（先确认服务器上已读取到 frps 配置或本机代理映射）');
      const result = await serverSession.openFirewallPorts(ports);
      return ok(result);
    } catch (e) {
      return fail(String((e && e.message) || e));
    }
  });

  /* 服务器没有防火墙时，安装并启用（ufw/firewalld），先放行 SSH 再放行 frps/代理端口。 */
  ipcMain.handle('server:firewall-install', async () => {
    if (!serverSession.connected) return fail('尚未连接服务器');
    try {
      const cfgPorts = serverConfig.summary ? serverSession.configPorts(serverConfig.content) : [];
      const proxyPorts = proxyRemotePorts();
      /* 装防火墙的那一刻如果漏掉 SSH / nginx 端口，用户一开防火墙就把自己锁在门外
       * （SSH 断了就再也进不来）。installFirewall 内部已经先放行 SSH，这里把系统端口一并交进去。 */
      const sysPorts = await collectSystemPorts();
      const ports = [...cfgPorts, ...proxyPorts, ...sysPorts];
      const result = await serverSession.installFirewall(ports);
      if (!result.ok) return fail(result.error, { manager: result.manager, opened: result.opened || [], notes: result.notes || [] });
      return ok(result);
    } catch (e) {
      return fail(String((e && e.message) || e));
    }
  });

  /* 手动放行任意端口/端口范围（如 1-65500 / 8080 / 8000-9000,10000）。 */
  ipcMain.handle('server:firewall-open-ports', async (_event, payload) => {
    if (!serverSession.connected) return fail('尚未连接服务器');
    try {
      const text = String((payload && payload.text) || '').trim();
      const proto = (payload && payload.proto) || 'tcp';
      if (!text) return fail('请输入要放行的端口');
      const result = await serverSession.openFirewallPortsManual(text, proto);
      if (!result.ok) return fail(result.error, { manager: result.manager, opened: result.opened || [], notes: result.notes || [] });
      return ok(result);
    } catch (e) {
      return fail(String((e && e.message) || e));
    }
  });

  /* 撤销放行（按规则 spec 删除）。payload.specs = ['7000/tcp', '1:65535/tcp', ...]。 */
  ipcMain.handle('server:firewall-close', async (_event, payload) => {
    if (!serverSession.connected) return fail('尚未连接服务器');
    try {
      const specs = (payload && payload.specs) || [];
      if (!Array.isArray(specs) || !specs.length) return fail('请先勾选要删除的规则');
      const result = await serverSession.closeFirewallRules(specs);
      if (!result.ok) return fail(result.error, { manager: result.manager, removed: result.removed || [], notes: result.notes || [] });
      return ok(result);
    } catch (e) {
      return fail(String((e && e.message) || e));
    }
  });

  /* ---------------- SSH 交互式终端（真 PTY）----------------
   * 与其它 IPC 的「一问一答」不同：打开后主进程把远端输出持续推给
   * 渲染层（ssh:data 事件），渲染层把按键 / 窗口尺寸送回来。
   * 切换服务器 / 断开连接 → disconnect() → closeShell() → onClose，
   * 渲染层会收到 { closed: true }，把界面收掉。 */
  ipcMain.handle('server:shell-open', async (_event, payload = {}) => {
    if (!serverSession.connected) return fail('尚未连接服务器');
    const rows = Math.max(2, Math.min(200, Number(payload.rows) || 30));
    const cols = Math.max(2, Math.min(500, Number(payload.cols) || 100));
    const result = await serverSession.openShell({
      rows,
      cols,
      onData: (chunk) => send('ssh:data', { chunk }),
      onClose: () => send('ssh:data', { closed: true }),
    });
    if (!result.ok) return fail(result.error);
    return ok({ host: serverSession.host, rows, cols });
  });

  // 按键流：一次一个字符 / 一个控制序列，走事件（on）而不是 invoke，
  // 避免每个按键都创建一个 Promise 往返。
  ipcMain.on('server:shell-input', (_event, payload) => {
    if (payload && typeof payload.text === 'string') serverSession.shellWrite(payload.text);
  });

  // vim / htop 全屏排版需要 PTY 窗口尺寸跟着终端容器走。
  ipcMain.on('server:shell-resize', (_event, payload) => {
    if (payload) serverSession.shellResize(payload.rows, payload.cols);
  });

  ipcMain.handle('server:shell-close', async () => {
    serverSession.closeShell();
    return ok({});
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
      /* info 是「连上那一刻」的快照：服务器上把 frps 二进制换掉 / 删掉之后，
       * 拿旧快照判断只会说"一切正常"。点自检就是要看现在，所以先重新探一次。 */
      await serverSession.inspect().catch(() => null);
      if (epoch !== sessionEpoch) return staleFail();
      /* 一条脚本读三种托管方式，免得为了“在不在跑”来回 SSH 三趟。 */
      const rawUnit = (active && active.serviceName) || (serverSession.info && serverSession.info.serviceName) || 'frps';
      // 单元名会拼进 shell 命令，只放行 systemd 允许的字符，避免带引号的名字造成注入。
      const unit = /^[A-Za-z0-9_.@-]+$/.test(rawUnit) ? rawUnit : 'frps';
      const script = [
        `echo @@ACTIVE; systemctl is-active -- ${unit} 2>/dev/null || true`,
        `echo @@ENABLED; systemctl is-enabled -- ${unit} 2>/dev/null || true`,
        "echo @@PROC; for d in /proc/[0-9]*; do [ \"$(cat $d/comm 2>/dev/null)\" = frps ] && echo \"$d\"; done | head -n 1",
        "echo @@DOCKER; docker ps --format '{{.Names}}\\t{{.Status}}' 2>/dev/null | grep -i frp | head -n 1",
        `echo @@UNIT; systemctl cat ${unit} >/dev/null 2>&1 && echo yes || echo no`,
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
        /* 正在跑 ≠ 重启后还能起来。没设开机自启时以前只是少半句话，用户看不出来，
         * 这里明确点出来并置 warn，让界面显示成「就绪（有提醒）」。 */
        const notEnabled = unitActive === 'active' && unitEnabled !== 'enabled';
        const boot = notEnabled
          ? '，但没有设为开机自启——服务器重启后 frps 不会自己起来（在服务器上执行 systemctl enable frps，或用「从零初始化」）'
          : unitEnabled === 'enabled'
            ? '，已设为开机自启'
            : '';
        /* 进程在跑不等于装好了：二进制被移走时它还能撑到下次重启。 */
        const info = serverSession.info || {};
        const gone = info.binaryExists === false;
        const broken = !gone && info.binaryBroken === true;
        const warn = gone
          ? `；但可执行文件 ${info.installedPath || 'frps'} 已不存在，重启 frps 或重启机器后会起不来`
          : broken
            ? `；但可执行文件 ${info.installedPath || 'frps'} 跑不起来（可能被替换成别的文件或已损坏），重启 frps 或重启机器后会起不来`
            : '';
        return ok({ layer, ok: true, warn: gone || broken || notEnabled, ms: Date.now() - startedAt, detail: `${where}${boot}${warn}` });
      }
      /* unit 文件被删掉（卸载残留、手工清理）时，光说「没有运行」会让用户去 start，
       * 但 systemctl 只会回 "Unit frps.service not found."。这里直接改口。 */
      const unitExists = pick('UNIT') !== 'no';
      /* 被 mask 的单元 systemd 根本不会加载：说「没有运行」会让人去点启动，
       * 点下去只会得到 "Unit is masked"，所以这里单独说清。 */
      const maskedUnit = (serverSession.info && serverSession.info.masked && serverSession.info.maskedUnit) || '';
      if (maskedUnit) {
        return ok({
          layer,
          ok: false,
          ms: Date.now() - startedAt,
          reason: `${maskedUnit} 被 mask 了`,
          detail: `systemd 禁止启动被 mask 的单元：在服务器上执行 \`systemctl unmask ${maskedUnit}\` 之后再启动；也可以用「从零初始化」重写服务单元`,
        });
      }
      return ok({
        layer,
        ok: false,
        ms: Date.now() - startedAt,
        reason: unitExists ? 'frps 没有运行' : 'frps 服务不存在',
        detail: unitExists
          ? unitActive === 'failed'
            ? `${unit}.service 处于 failed，展开实时日志看原因`
            : `没有找到运行的 frps（${unit}.service 未激活，也没有 frps 进程或容器）`
          : `这台服务器上没有 ${unit}.service（服务单元被删或从没建过）：用「从零初始化」重装 frps，或手工把 systemd 服务建回来`,
      });
    }

    if (layer === 'bindPort') {
      if (!bindPort) return ok({ layer, ok: false, ms: Date.now() - startedAt, reason: 'bindPort 未知', detail: '服务器上没有可读的 frps 配置，先在向导里生成一份' });
      /* 「监听者是不是 frps」要用新鲜事实判断，不能用连上那一刻的快照。 */
      await serverSession.inspect().catch(() => null);
      if (epoch !== sessionEpoch) return staleFail();
      const result = await serverSession.exec(
        `echo @@SS; (ss -lntpH 2>/dev/null || ss -lntp 2>/dev/null || netstat -lntp 2>/dev/null) | grep -E '[:.]${bindPort}([[:space:]]|$)' | head -n 3`,
        12000,
      );
      if (epoch !== sessionEpoch) return staleFail();
      const body = String(result.stdout || '');
      const ssPart = (/@@SS([\s\S]*?)(?:@@|$)/.exec(body) || [])[1] || '';
      const listenLine = ssPart.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] || '';
      /* 端口在监听 ≠ frps 在监听：别的程序占着同一个端口时 frps 根本起不来，
       * 但这个自检会看到「有人在听」，再测公网可达就报绿——典型的假绿。 */
      const holder = parseSocketHolder(listenLine);
      const frpsAlive = !!(serverSession.info && (serverSession.info.status === 'running' || serverSession.info.processAlive));
      if (holder && !/frps/i.test(holder.name)) {
        return ok({
          layer,
          ok: false,
          ms: Date.now() - startedAt,
          reason: 'bindPort 被别的程序占用',
          detail: `${bindPort} 上监听的是 ${holder.name}（PID ${holder.pid}），不是 frps。${frpsAlive ? 'frps 进程在反复重启（抢不到端口），' : 'frps 起不来就是因为这个端口被占了：'}先停掉 ${holder.name}，或者在配置里换一个 bindPort。`,
        });
      }
      if (listenLine) {
        /* 「本机在监听」只说明 frps 起来了，不代表外面连得上：云安全组、网络 ACL、
         * 运营商封端口都在这之后才生效。补一次从本机的实测，才能回答用户真正关心的问题。 */
        const reach = await probePort({ host: serverSession.host, port: bindPort, timeout: 3000 });
        if (epoch !== sessionEpoch) return staleFail();
        if (reach.ok) {
          return ok({
            layer,
            ok: true,
            ms: Date.now() - startedAt,
            detail: `服务器本机在 ${bindPort} 上监听，公网实测可达（${reach.ms} ms）`,
          });
        }
        return ok({
          layer,
          ok: false,
          ms: Date.now() - startedAt,
          reason: '公网连不上这个端口',
          detail: `服务器本机确实在 ${bindPort} 监听（${listenLine.replace(/\s+/g, ' ').slice(0, 60)}），但从本机连不上（${reach.error || reach.kind}）。`
            + '本机防火墙放不放行都管不到这一层——多半是云厂商安全组/防火墙没放行（阿里云轻量：控制台 → 防火墙；ECS：安全组入方向），也可能是运营商/网络 ACL 封了端口。',
        });
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
      /* 配置文件根本读不到时（被删、改名、权限不够），summary 是空的；
       * 那种情况说「服务端未启用鉴权」是错的——服务端多半好好的，是我们没读到它。 */
      if (!serverConfig || !serverConfig.content) {
        return ok({
          layer,
          ok: false,
          ms: Date.now() - startedAt,
          reason: '读不到服务器上的 frps.toml',
          detail: (serverConfig && serverConfig.error) || '先确认配置文件路径，点「重新读取」再试',
        });
      }
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

    return fail(`未知的检测层（可用：ssh / service / bindPort / token）：${layer}`);
  });

  ipcMain.handle('server:control', async (event, payload = {}) => {
    const action = String(payload.action || '');
    if (!['start', 'stop', 'restart'].includes(action)) return fail('未知操作');
    const epoch = sessionEpoch;
    const result = await serverSession.control(action);
    if (epoch !== sessionEpoch) return staleFail();
    if (!result.ok) {
      const refined = frpsConfig.refineStartError(result.error, serverConfig.summary);
      return fail(refined, { state: serverState() });
    }
    await loadServerSnapshot({ epoch });
    return ok({ ...result, serverId: sessionServerId, state: serverState() });
  });

  /* 服务器侧 frps 面板口令轮换：只算出新内容交回渲染层，
   * 再由它走「保存并重启 frps」那条既有路径（校验、备份、冲突确认都在那儿）。 */
  ipcMain.handle('server:rotate-web-password', async () => {
    if (!serverSession.connected) return fail('尚未连接服务器', { state: serverState() });
    if (!serverConfig.content) return fail('还没读到服务器上的 frps.toml', { state: serverState() });
    const password = randomToken(20);
    const content = frpsConfig.rotateWebPassword(serverConfig.content, password);
    if (!content) {
      return fail('这份 frps.toml 里没有 [webServer] 段，没法自动换面板口令', {
        hint: '可以在下面的「配置文件」里手动加一个 [webServer] 段，或者用「从零初始化」重新生成配置。',
        state: serverState(),
      });
    }
    return ok({ content, password });
  });

  ipcMain.handle('server:save-config', async (event, payload = {}) => {
    let content = String(payload.content || '');
    const resolve = payload.resolve || null; // { action: 'remap' } 自动换端口
    if (!content.trim()) return fail('配置内容为空');
    if (!serverSession.connected) return fail('尚未连接服务器', { state: serverState() });
    const check = frpsConfig.validateText(content);
    if (!check.ok) return fail(`配置语法错误：${check.error}`);
    const epoch = sessionEpoch;

    // 「自动换端口」：为冲突端口找空闲替代，改配置后再写。旧端口会联动 nginx 反代与本机隧道。
    let remapResult = null;
    if (resolve && resolve.action === 'remap') {
      const details = await serverSession.portConflictDetails(serverSession.configPorts(content));
      if (epoch !== sessionEpoch) return staleFail();
      if (details.length) {
        const remap = {};
        const remapLabels = {};
        for (const d of details) {
          const free = await serverSession.findFreePort(Number(d.port) + 1000);
          remap[d.port] = free;
          remapLabels[d.label] = free;
        }
        const remapped = serverSession.remapConfigPorts(content, remap);
        if (!remapped.ok) return fail(`自动换端口失败：${remapped.error}`, { state: serverState() });
        content = remapped.content;
        remapResult = { remap, remapLabels, conflicts: details };
      }
    }

    const result = await serverSession.writeConfig(content, { restart: !!payload.restart });
    if (epoch !== sessionEpoch) return staleFail();
    if (!result.ok) return fail(result.error, { state: serverState(), conflicts: result.conflicts || [], conflictDetails: result.conflictDetails || [] });
    // 重新读快照：dashboardUrl / vhost 设置 / adoptServerAuthFromConfig 都会在这里对齐。
    await loadServerSnapshot({ inspect: true, epoch });
    if (epoch !== sessionEpoch) return staleFail();

    // remap 后的联动（best-effort，失败不阻断保存结果）：
    let nginxSync = null;
    let clientSync = null;
    if (remapResult) {
      // 1) vhostHTTPPort 变了 → 用新端口重写 nginx 反代配置（有证书才做）。
      if (remapResult.remapLabels.vhostHTTPPort) {
        const certs = acmeManager.list();
        const cert = certs.find((c) => c.exists) || null;
        if (cert && cert.crtPath && cert.keyPath) {
          nginxSync = await syncCertToServerNginx(cert).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
        }
      }
      // 2) bindPort 变了 → 本机 frpc 的 serverPort 跟着改并重启隧道（仅当本机正连这台服务器）。
      if (remapResult.remapLabels.bindPort) {
        const nextPort = Number(remapResult.remapLabels.bindPort);
        const owner = sessionServerId ? findServerProfile(sessionServerId) : null;
        if (model && model.serverAddr && owner
          && String(model.serverAddr).toLowerCase() === String(owner.host).toLowerCase()
          && Number(model.serverPort) !== nextPort) {
          const next = structuredClone(model);
          next.serverPort = nextPort;
          const saved = persistModel(next, { reload: false });
          if (saved.ok) {
            if (manager) {
              const rt = manager.snapshot();
              if (rt.running || rt.connected) {
                await manager.restart({ runMode: settings.runMode }).catch(() => ({}));
                await manager.refresh().catch(() => {});
                healthCache.clear();
                scheduleHealth(1200);
              }
            }
            clientSync = { ok: true, serverPort: nextPort };
          } else {
            clientSync = { ok: false, error: saved.error || '本机 frpc 配置写入失败' };
          }
        }
      }
    }

    return ok({ backup: result.backup, restarted: result.restarted, serverId: sessionServerId, remap: remapResult && remapResult.remap, nginx: nginxSync, client: clientSync, state: serverState() });
  });

  /* 终止占用指定端口的非 frps 进程（「端口冲突」弹窗的「终止占用进程」用）。 */
  ipcMain.handle('server:kill-ports', async (event, payload = {}) => {
    if (!serverSession.connected) return fail('尚未连接服务器');
    try {
      const ports = (payload.ports || []).map(Number).filter((p) => p && p > 0);
      const kill = await serverSession.killPortOccupants(ports);
      await new Promise((r) => setTimeout(r, 800));
      return ok(kill);
    } catch (e) {
      return fail(String((e && e.message) || e));
    }
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

  /* 方案 Y（nginx 在 80/443 终止 TLS → frps 的 vhost 端口 → frpc）的前提：
   * frps 必须真的在监听一个 HTTP vhost 端口，nginx 才有上游可反代。
   * 只在服务器上写 nginx 配置、却不管 frps.toml，就会出现「nginx 明明起着、访问却是 502」——
   * nginx 的 proxy_pass 指向 127.0.0.1:8080，而 frps 根本没监听 8080。
   * 这里在需要时把这个端口补进 frps.toml（顶层键）并重启 frps。 */
  async function ensureVhostPort(kind = 'http') {
    const isHttps = kind === 'https';
    const key = isHttps ? 'vhostHTTPSPort' : 'vhostHTTPPort';
    const settingKey = isHttps ? 'vhostHttpsPort' : 'vhostHttpPort';
    const fallback = isHttps ? 8443 : 8080;
    const current = serverConfig.summary ? Number(serverConfig.summary[key]) || 0 : 0;
    if (current > 0) return { ok: true, key, port: current, changed: false };
    if (!serverSession.connected) return { ok: false, key, error: '尚未连接服务器' };
    if (!serverConfig.content) return { ok: false, key, error: '读不到服务器上的 frps 配置（/etc/frp/frps.toml）' };
    const epoch = sessionEpoch;
    let port = Number(settings[settingKey]) || fallback;
    // 端口被别的服务占着时 frps 会起不来：先探测，占了就往后挪。
    for (let i = 0; i < 20; i++) {
      const probe = await serverSession.checkPortInUse(port).catch(() => ({ ok: false }));
      if (!probe || !probe.ok || !probe.inUse) break;
      port += 1;
    }
    if (epoch !== sessionEpoch) return { ok: false, key, error: '会话已切换' };
    const next = frpsConfig.setTopLevelInt(serverConfig.content, key, port);
    const written = await serverSession.writeConfig(next, { restart: true });
    if (epoch !== sessionEpoch) return { ok: false, key, error: '会话已切换' };
    if (!written.ok) return { ok: false, key, port, error: written.error || '写入 frps 配置失败' };
    // 重读快照：summary / 档案 vhost 端口 / nginx 状态都会在这里对齐。
    await loadServerSnapshot({ inspect: true, epoch });
    const after = serverConfig.summary ? Number(serverConfig.summary[key]) || 0 : 0;
    return {
      ok: after > 0, key, port: after || port, changed: true,
      backup: written.backup, restarted: written.restarted,
      error: after > 0 ? '' : '写入后 frps 仍未监听该端口，请查看 frps 日志',
    };
  }

  /* 方案 Y：把一张已签发的证书同步到服务器 nginx（上传证书 + 写反代配置 + reload）。
   * best-effort：服务器没连/没 nginx 时返回 ok:false 但不抛错，证书仍留在本机。 */
  /* 方案 Y 下给根路径加一条 302：nginx 已经替我们终止 TLS 并反代给 frps，
 * 这里顺手把「/」跳到用户填的访问路径（例如 /panel/），根路径也就可用了。
 * 只对填了访问路径、且域名与本次写进 server_name 的域名匹配的代理生效。 */
function nginxRootRedirectFor(serverNames) {
  const names = String(serverNames || '').split(/\s+/).filter(Boolean).map((s) => s.toLowerCase());
  if (!names.length) return '';
  for (const proxy of (model && model.proxies) || []) {
    const path = proxyOpenPath(proxy.name);
    if (!path || path === '/') continue;
    const domains = (Array.isArray(proxy.customDomains) ? proxy.customDomains : [])
      .map((d) => String(d || '').toLowerCase())
      .filter(Boolean);
    const hit = domains.some((d) => names.includes(d) || names.some((n) => coversDomain(n, d) || coversDomain(d, n)));
    if (hit) return path;
  }
  return '';
}

async function syncCertToServerNginx(cert) {
    if (!cert || !Array.isArray(cert.domains) || !cert.domains.length) {
      return { ok: false, error: '缺少证书信息' };
    }
    const serverHost = serverSession.connected ? String(serverSession.host || '') : '';
    if (!serverSession.connected) {
      const r = { ok: false, error: '尚未连接服务器，证书已保存到本机但未上传到 nginx' };
      acmeManager.markNginx(cert.domain, r, serverHost);
      return r;
    }
    // 反代的上游是 frps 的 vhost HTTP 端口：没开就先补上，否则写出来的反代一定 502。
    const vhost = await ensureVhostPort('http').catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
    if (!vhost.ok) {
      const r = { ok: false, error: `服务器 frps 没有可用的 vhostHTTPPort（nginx 反代的上游）：${vhost.error || '未知原因'}` };
      acmeManager.markNginx(cert.domain, r, serverHost);
      return r;
    }
    /* 没有 nginx 时后面每一步都没有意义（写进去的配置也没人 reload），
     * 而且原来的报错是 "bash: line 1: nginx: command not found"，用户看不出该干什么。 */
    const nginxNow = await serverSession.detectNginx().catch((e) => ({ installed: false, error: String((e && e.message) || e) }));
    if (!nginxNow.installed) {
      const r = {
        ok: false,
        error: '这台服务器上没有可用的 nginx：先到「HTTPS 域名反代（nginx）」卡片点「安装 nginx 并配置」，装好之后再部署证书',
        nginxMissing: true,
      };
      acmeManager.markNginx(cert.domain, r, serverHost);
      return r;
    }
    const frpsHttpPort = Number(vhost.port) || 8080;
    const upload = await serverSession.uploadCertToNginx(cert.domain, { certPath: cert.crtPath, keyPath: cert.keyPath });
    if (!upload.ok) { acmeManager.markNginx(cert.domain, upload, serverHost); return upload; }
    const serverNames = serverSession.nginxServerName(cert.domains);
    const rootRedirect = nginxRootRedirectFor(serverNames);
    const write = await serverSession.writeNginxProxyConfig({ serverNames, certDir: upload.dir, frpsHttpPort, rootRedirect });
    if (!write.ok) { acmeManager.markNginx(cert.domain, write, serverHost); return write; }
    const reload = await serverSession.reloadNginx();
    if (!reload.ok) { acmeManager.markNginx(cert.domain, reload, serverHost); return reload; }
    // 反代配置写成功并 reload 后，公网入口就是 nginx 443，代理地址不再带端口。
    setProfileNginxProxy(profileForSession(serverSession).id, true);
    const r = { ok: true, serverNames, certDir: upload.dir, frpsHttpPort, vhost };
    acmeManager.markNginx(cert.domain, r, serverHost);
    return r;
  }

  /* ---- HTTPS 证书（Let's Encrypt / DNS-01）---- */

  ipcMain.handle('cert:list', async () => ok({ certs: acmeManager.list({ extraDirs: extraCertDirs() }) }));

  ipcMain.handle('cert:issue', async (event, payload = {}) => {
    try {
      const domains = payload.domains;
      const email = String(payload.email || settings.acmeEmail || '').trim();
      /* 先看用户填的域名，再看渠道：没填域名却提示「尚未配置 DNS 验证渠道」，
       * 会让人以为先去配 token 就能签 —— 其实什么都没填。 */
      const wantedDomains = (Array.isArray(domains) ? domains : [domains])
        .map((d) => String(d || '').trim().toLowerCase())
        .filter(Boolean);
      if (!wantedDomains.length) return fail('请先填写要签发的域名（第一项作为主域名）');
      const badDomain = wantedDomains.find((d) => !/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d));
      if (badDomain) return fail(`域名「${badDomain}」不合法：只填域名本身，通配符写成 *.example.com`);
      const provider = currentDnsProvider();
      if (!provider.ok) return fail(provider.error);
      const sendProgress = (data) => {
        try { event.sender.send('cert:progress', data); } catch { /* 窗口销毁时忽略 */ }
      };
      sendProgress({ label: '开始签发证书…', percent: 0 });
      const result = await acmeManager.issue({ domains, email, dns: provider.dns, onProgress: sendProgress });
      if (!result.ok) return fail(withOutboundHint(result.error, '证书签发'));
      // 证书签发后，自动上传到服务器 nginx 终止 TLS（方案 Y）。
      sendProgress({ label: '部署到服务器 nginx（上传证书 + 重载）…', percent: 95 });
      const nginx = await syncCertToServerNginx(result);
      sendProgress({ label: '完成', percent: 100 });
      pushState();
      return ok({ ...result, nginx });
    } catch (e) {
      return fail(withOutboundHint(String((e && e.message) || e), '证书签发'));
    }
  });

  ipcMain.handle('cert:renew', async (event, payload = {}) => {
    try {
      const domain = String((payload && payload.domain) || '').trim();
      if (!domain) return fail('缺少域名');
      const existing = acmeManager.get(domain);
      const provider = currentDnsProvider();
      if (!provider.ok) return fail(provider.error);
      const email = existing && existing.email ? existing.email : String(settings.acmeEmail || '');
      const sendProgress = (data) => {
        try { event.sender.send('cert:progress', data); } catch { /* 窗口销毁时忽略 */ }
      };
      sendProgress({ label: '开始续期…', percent: 0 });
      const result = await acmeManager.renew(domain, { email, dns: provider.dns, onProgress: sendProgress });
      if (!result.ok) return fail(withOutboundHint(result.error, '证书续期'));
      // 证书续期后，同样自动同步到 nginx。
      sendProgress({ label: '部署到服务器 nginx（上传证书 + 重载）…', percent: 95 });
      const nginx = await syncCertToServerNginx(result);
      sendProgress({ label: '完成', percent: 100 });
      pushState();
      return ok({ ...result, nginx });
    } catch (e) {
      return fail(withOutboundHint(String((e && e.message) || e), '证书续期'));
    }
  });

  /* 手动把某张已签发证书同步到服务器 nginx（用于「先签证书、后连服务器」的场景）。 */
  ipcMain.handle('cert:nginx-sync', async (event, payload = {}) => {
    try {
      const domain = String((payload && payload.domain) || '').trim();
      /* 必须点名是哪张证书：以前域名缺省时会拿 list()[0] 顶上，等于「随便挑一张部署到当前服务器」，
       * 传参走样（比如把字符串当对象）就会把别的域名传到这台机器上，界面上还显示成功。 */
      if (!domain) return fail('缺少域名：要部署哪一张证书');
      const cert = acmeManager.get(domain);
      if (!cert || !cert.exists) return fail(`本地没有 ${domain} 的证书`);
      const sync = await syncCertToServerNginx(cert);
      if (!sync.ok) return fail(sync.error);
      pushState();
      return ok(sync);
    } catch (e) {
      return fail(String((e && e.message) || e));
    }
  });

  ipcMain.handle('cert:remove', async (event, payload = {}) => {
    const domain = String((payload && payload.domain) || '').trim();
    if (!domain) return fail('缺少域名');
    /* 删本机证书前先看有没有代理在用它的文件：https2http/https2https 的 crtPath/keyPath
     * 指向就是这张证书，删了之后 frpc 会拒绝加载整份配置（所有代理一起起不来）。
     * 只提示+要求确认，不硬拦：用户可能就是要先删证书再改代理。 */
    const cert = acmeManager.get(domain);
    const certDirs = cert && cert.crtPath ? [path.dirname(cert.crtPath)] : [];
    const usedBy = [];
    for (const proxy of (model && model.proxies) || []) {
      const plugin = proxy && proxy.plugin;
      if (!plugin) continue;
      for (const value of [plugin.crtPath, plugin.keyPath]) {
        const p = String(value || '').trim();
        if (!p) continue;
        if (certDirs.includes(path.dirname(p))) { usedBy.push(proxy.name); break; }
      }
    }
    if (payload.dryRun) {
      /* 只查询「谁在用」，不删任何东西：确认框要在用户点删除之前就把风险摆出来。 */
      return ok({ dryRun: true, usedBy, exists: !!cert });
    }
    if (usedBy.length && !payload.force) {
      return fail(
        `还有 ${usedBy.length} 条代理在用这张证书（${usedBy.join('、')}）：删掉后 frpc 会拒绝加载配置、所有代理一起起不来。确认要先删的话，请再点一次「仍然删除」`,
        { usedBy },
      );
    }
    const result = acmeManager.removeLocal(domain);
    if (!result.ok) return fail(result.error);
    pushState();
    return ok({ removed: true, usedBy });
  });

  /* 把服务器上已有的证书（宝塔 / certbot）导入本机库，之后就能统一查看/续期/部署。 */
  ipcMain.handle('cert:import', async (event, payload = {}) => {
    try {
      if (!serverSession.connected) return fail('尚未连接服务器');
      const certPath = String((payload && payload.certPath) || '').trim();
      const keyPath = String((payload && payload.keyPath) || '').trim();
      const domain = String((payload && payload.domain) || '').trim();
      if (!certPath) return fail('缺少证书路径');
      const read = await serverSession.readRemoteCert({ certPath, keyPath });
      if (!read.ok) return fail(read.error);
      const res = acmeManager.importCertificate({
        domain,
        certPem: read.certPem,
        keyPem: read.keyPem,
        source: 'server',
        serverHost: serverSession.host,
        remoteCertPath: certPath,
        remoteKeyPath: keyPath,
      });
      if (!res.ok) return fail(res.error);
      pushState();
      return ok(res);
    } catch (e) {
      return fail(String((e && e.message) || e));
    }
  });

  /* 服务器上已有的证书盘点（只读）：nginx 引用的 + 宝塔 vhost/cert + letsencrypt/live + /etc/nginx/ssl。
   * 结果按 host 缓存 60 秒，force=true 可强刷。 */
  ipcMain.handle('cert:server-scan', async (event, payload = {}) => {
    try {
      if (!serverSession.connected) return fail('尚未连接服务器，无法读取服务器上的证书');
      const force = !!(payload && payload.force);
      const host = serverSession.host;
      const fresh = serverCertScanCache.host === host && Date.now() - serverCertScanCache.at < 60000;
      if (!force && fresh) {
        return ok({ ...serverCertScanCache, cached: true, scannedAt: serverCertScanCache.at });
      }
      const scan = await serverSession.scanCertificates();
      if (!scan.ok) return fail(scan.error || '扫描服务器证书失败');
      const now = Date.now();
      const certs = (scan.certs || []).map((c) => {
        const t = Date.parse(c.notAfterRaw || '');
        const notAfter = Number.isFinite(t) ? t : 0;
        return {
          ...c,
          notAfter,
          notAfterText: notAfter ? new Date(notAfter).toISOString().slice(0, 10) : '',
          daysLeft: notAfter ? Math.floor((notAfter - now) / 86400000) : null,
        };
      });
      serverCertScanCache = { at: now, host, certs, truncated: !!scan.truncated };
      return ok({ ...serverCertScanCache, cached: false, scannedAt: now });
    } catch (e) {
      return fail(String((e && e.message) || e));
    }
  });

  /* 从服务器删除一张证书：默认先查「还有没有站点在引用」，无引用才删，删完 reload nginx。
   * 服务器上的证书可能正被某个站点的 ssl_certificate 引用，删掉会直接让站点断连，
   * 所以默认必须拦；但服务器是用户自己的，force=true 时按用户意愿执行
   * （前端要先让他勾选「我知道后果」才带这个参数）。 */
  ipcMain.handle('cert:server-remove', async (event, payload = {}) => {
    try {
      if (!serverSession.connected) return fail('尚未连接服务器');
      const certPath = String((payload && payload.certPath) || '').trim();
      const keyPath = String((payload && payload.keyPath) || '').trim();
      const force = !!(payload && payload.force);
      const res = await serverSession.deleteRemoteCert({ certPath, keyPath, force });
      if (!res.ok) {
        if (res.blocked) return fail(res.error, { blocked: true, references: res.references || [], sites: res.sites || [] });
        return fail(res.error);
      }
      /* 删完让下一次扫描重新读盘，别拿缓存里的旧列表糊弄用户。 */
      serverCertScanCache = { at: 0, host: '', certs: [], truncated: false };
      pushState();
      return ok(res);
    } catch (e) {
      return fail(String((e && e.message) || e));
    }
  });

  /* 把引用某张证书的 nginx 配置改指到另一张证书（换证不换站点）。 */
  ipcMain.handle('cert:replace-refs', async (event, payload = {}) => {
    try {
      if (!serverSession.connected) return fail('尚未连接服务器');
      const res = await serverSession.replaceCertReference({
        fromCert: String((payload && payload.fromCert) || '').trim(),
        fromKey: String((payload && payload.fromKey) || '').trim(),
        toCert: String((payload && payload.toCert) || '').trim(),
        toKey: String((payload && payload.toKey) || '').trim(),
      });
      if (!res.ok) return fail(res.error, res.changed ? { changed: res.changed } : {});
      serverCertScanCache = { at: 0, host: '', certs: [], truncated: false };
      pushState();
      return ok(res);
    } catch (e) {
      return fail(String((e && e.message) || e));
    }
  });

  /* 停用引用某张证书的站点（配置文件改名成 .disabled-frpconsole-<时间戳>，随时可改回）。 */
  ipcMain.handle('cert:disable-refs', async (event, payload = {}) => {
    try {
      if (!serverSession.connected) return fail('尚未连接服务器');
      const files = Array.isArray(payload && payload.files) ? payload.files : [];
      const res = await serverSession.disableNginxSites({ files });
      if (!res.ok) return fail(res.error);
      serverCertScanCache = { at: 0, host: '', certs: [], truncated: false };
      pushState();
      return ok(res);
    } catch (e) {
      return fail(String((e && e.message) || e));
    }
  });

  ipcMain.handle('dns:state', async () => ok({
    dnsProvider: settings.dnsProvider || '',
    hasToken: settingsModule.hasCloudflareToken(),
    acmeEmail: settings.acmeEmail || '',
  }));

  /* 代理表单 / 健康检查共用的域名解析：只做软提示，不阻塞任何保存或判定。 */
  ipcMain.handle('dns:resolve', async (event, domain) => {
    return ok(await resolveDomainInfo(String(domain || '').trim()));
  });

  /* 证书页「DNS 记录」面板（v1.2.58）：
   * 一次拿全 —— Cloudflare 里的记录 + 四个 DNS 来源的实际解析结果 + 结论。
   * 面板与「检测」按钮共用同一份数据源（都在这里算），避免出现
   * 「面板显示已解析、检测却报未解析」的矛盾。 */
  ipcMain.handle('dns:inspect', async (_event, payload = {}) => {
    try {
      const name = String((payload && (payload.name || payload.domain)) || '').trim().toLowerCase();
      if (!name) return fail('请先输入域名');
      const [resolved, cf] = await Promise.all([
        dnsCheck.resolveName(name),
        (async () => {
          try {
            const provider = currentDnsProvider();
            if (!provider.ok || !provider.dns || typeof provider.dns.listRecords !== 'function') {
              return { configured: false, records: [], error: '' };
            }
            /* 再套一层总超时：DNS 解析必须能在几秒内给结果，
             * 不能因为 Cloudflare API 慢就把整个面板拖住。 */
            const r = await Promise.race([
              provider.dns.listRecords(name),
              new Promise((_, reject) => setTimeout(() => reject(new Error('Cloudflare API 超时（8 秒）')), 8000)),
            ]);
            return { configured: true, records: r.records || [], zenId: r.zoneId, error: '' };
          } catch (e) {
            return { configured: true, records: [], error: (e && e.message) || String(e) };
          }
        })(),
      ]);
      /* 橙云判断：找一条和这个域名同名（或通配符同名）的 A/AAAA/CNAME 记录 */
      const plain = name.replace(/^\*\./, '');
      const cfRecord = (cf.records || []).find((r) => ['A', 'AAAA', 'CNAME'].includes(r.type)
        && (r.name === name || r.name === plain)) || null;
      const server = String((model && model.serverAddr) || '').trim();
      const judge = dnsCheck.judgeResolution({ sources: resolved.sources, serverAddr: server, cfRecord, name });
      /* 通配符证书（*.x）没法直接查「*.x」判断生效，用一个随机子域探一下：
       * 如果它能解析到同一个 IP，说明通配 A 记录已经生效。 */
      let wildcardProbe = null;
      if (name.startsWith('*.')) {
        const apexName = name.slice(2);
        const probe = `probe-${Math.random().toString(36).slice(2, 8)}.${apexName}`;
        const r = await dnsCheck.dohQuery('cf', probe, 'A').catch(() => null);
        const addrs = ((r && r.records) || []).filter((x) => x.type === 'A').map((x) => x.value);
        wildcardProbe = { name: probe, ok: addrs.length > 0, addrs, error: (r && r.error) || '' };
      }
      /* A 记录查询不会带 SOA，拿不到负缓存上限；单独问一次 apex 的 SOA，
       * 面板上就能告诉用户「最多等多少分钟才全世界生效」。 */
      let soaMinTtl = resolved.soaMinTtl || 0;
      if (!soaMinTtl) {
        const apex = dnsCheck.apexOf(name);
        const soa = await dnsCheck.dohQuery('cf', apex, 'SOA').catch(() => null);
        soaMinTtl = (soa && soa.soaMinTtl) || 0;
      }
      return ok({
        name,
        apex: dnsCheck.apexOf(name),
        sources: resolved.sources,
        soaMinTtl,
        cf,
        cfRecord,
        judge,
        wildcardProbe,
        serverAddr: server,
        checkedAt: Date.now(),
      });
    } catch (e) {
      return fail((e && e.message) || String(e));
    }
  });

  ipcMain.handle('dns:add-record', async (_event, payload = {}) => {
    try {
      const provider = currentDnsProvider();
      if (!provider.ok || !provider.dns || typeof provider.dns.createRecord !== 'function') {
        return fail('尚未配置 DNS 验证渠道（需要 Cloudflare token）');
      }
      const domain = String((payload && (payload.domain || payload.name)) || '').trim();
      if (!domain) return fail('缺少域名');
      const type = String(payload.type || 'A').toUpperCase();
      if (!['A', 'AAAA', 'CNAME', 'TXT', 'MX'].includes(type)) return fail(`不支持的记录类型 ${type}`);
      const content = String(payload.content || '').trim();
      if (!content) return fail('请填写记录内容（A 记录填 IP，CNAME 填目标域名）');
      if (type === 'A' && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(content)) return fail('A 记录的内容必须是 IPv4 地址');
      const rec = await provider.dns.createRecord(domain, {
        type,
        name: String(payload.name || domain).trim(),
        content,
        ttl: Number(payload.ttl) || 120,
        proxied: payload.proxied === true,
      });
      return ok(rec);
    } catch (e) {
      return fail((e && e.message) || String(e));
    }
  });

  ipcMain.handle('dns:del-record', async (_event, payload = {}) => {
    try {
      const provider = currentDnsProvider();
      if (!provider.ok || !provider.dns || typeof provider.dns.deleteRecord !== 'function') {
        return fail('尚未配置 DNS 验证渠道（需要 Cloudflare token）');
      }
      const domain = String((payload && (payload.domain || payload.name)) || '').trim();
      const id = String((payload && payload.id) || '').trim();
      if (!domain || !id) return fail('缺少域名或记录 id');
      const r = await provider.dns.deleteRecord(domain, id);
      return ok(r);
    } catch (e) {
      return fail((e && e.message) || String(e));
    }
  });

  /* 验证已保存的 Cloudflare token 是否有效（不暴露 token 明文）。 */
  ipcMain.handle('dns:verify', async (event, payload = {}) => {
    try {
      const token = String((payload && payload.token) || '').trim();
      // 允许直接验一个刚填还没保存的 token；没传就用已保存的。
      const dns = token ? new CloudflareDns({ token }) : (currentDnsProvider().dns || null);
      if (!dns || typeof dns.verifyToken !== 'function') return fail('尚未配置 DNS 验证渠道（需要 Cloudflare token）');
      const r = await dns.verifyToken();
      return ok(r);
    } catch (e) {
      return fail((e && e.message) || String(e));
    }
  });

  /* 域名向导「一键建解析」：给域名建/改 A 记录，指向 frps 服务器 IP。 */
  ipcMain.handle('dns:set-a', async (event, payload = {}) => {
    try {
      const provider = currentDnsProvider();
      if (!provider.ok || !provider.dns || typeof provider.dns.setARecord !== 'function') return fail('尚未配置 DNS 验证渠道（需要 Cloudflare token）');
      const domain = String((payload && payload.domain) || '').trim();
      if (!domain) return fail('请先输入域名');
      // 目标 IP：显式传入优先；否则用活跃服务器档案的 host（SSH 公网 IP），再退回本机配置 serverAddr。
      const explicit = String((payload && payload.ip) || '').trim();
      const profile = activeServerProfile();
      const ip = explicit || (profile && /^\d+\.\d+\.\d+\.\d+$/.test(profile.host || '') ? profile.host : '') || (model && /^\d+\.\d+\.\d+\.\d+$/.test(model.serverAddr || '') ? model.serverAddr : '');
      if (!ip) return fail('无法确定 frps 服务器 IP：请先连接服务器，或手动填一个 IP');
      const record = await provider.dns.setARecord(domain, ip);
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

  ipcMain.handle('clipboard:read', async () => {
    try {
      return ok({ text: clipboard.readText() });
    } catch (e) {
      return ok({ text: '' });
    }
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
    else if (action === 'restore') {
      // 从最小化/隐藏里叫回来：两条路一起走，免得“点了没反应”
      if (win.isMinimized()) win.restore();
      showMainWindow();
    } else if (action === 'maximize') {
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
    /* 以前不认识的动作会一声不响地走完全程并返回 ok —— 调用方（或脚本）以为生效了，
     * 实际什么也没发生。明确拒绝比默默忽略好查。 */
    else return fail(`不认识的动作「${String(action || '')}」，可用：minimize / restore / maximize / hide / show / close`);
    refreshTray();
    return ok({ maximized: win.isMaximized(), visible: win.isVisible() });
  });

  ipcMain.handle('app:notification', async (event, payload) => {
    notify((payload && payload.kind) || 'info', (payload && payload.title) || 'FRP 控制台', (payload && payload.message) || '');
    return ok({ shown: true });
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

/* 启动后台同步：用户可能还没连服务器页，但服务器上已经配好了 nginx 反代
 * （frp-console.conf 存在）。这里用保存的密码自动连一次、只查这个事实、
 * 同步 nginxProxyEnabled 后立即断开，让新建代理时公网地址直接就是 https://域名。 */
async function syncNginxProxyStateInBackground() {
  try {
    if (serverSession.connected) return; // 已连服务器页，loadServerSnapshot 会处理
    const profile = activeServerProfile();
    if (!profile || !profile.host || !profile.username) return;
    const secret = settingsModule.readServerSecret(profile.id);
    if (!secret) return; // 没存密码，无法自动连
    const myEpoch = sessionEpoch;
    const conn = await serverSession.connect({
      host: profile.host,
      port: profile.port || 22,
      username: profile.username,
      password: secret,
      onHostKey: hostKeyGuard,
    });
    if (!conn.ok) return;
    try {
      if (sessionEpoch !== myEpoch) return; // 期间用户操作了服务器页，放弃
      const proxyConfigured = await serverSession.nginxProxyConfigured();
      // 状态属于「这台服务器」的档案；同步后立即断开。
      if (setProfileNginxProxy(profile.id, proxyConfigured)) pushState();
    } finally {
      serverSession.disconnect();
    }
  } catch { /* best-effort：失败不影响主流程 */ }
}

async function autoRenewExpiringCerts() {
  if (autoRenewRunning) return;
  autoRenewRunning = true;
  try {
    const provider = currentDnsProvider();
    if (!provider.ok) return; // 没配 DNS 渠道就跳过，静默。
    /* 续期之前先记住「这些域名当初部署到哪台服务器」——storeCertificate 会重写 metadata，
     * 续完再读就拿不到上一次的部署记录了。 */
    const beforeRenew = new Map(acmeManager.list().map((c) => [c.domain, c]));
    const result = await acmeManager.renewIfExpiring({ days: AUTO_RENEW_BEFORE_DAYS, dns: provider.dns });
    if (result.renewed.length) {
      const names = result.renewed.map((c) => `${c.domain}（${c.daysLeft} 天）`).join('、');
      notify('info', '证书已自动续期', names);

      /* 新证书只写在本机 certs/ 里；服务器 nginx 用的还是当初上传的那份副本。
       * 不重新部署的话，到期那天浏览器照样拿到过期证书 —— 续了等于没续。 */
      const nowHost = serverSession.connected ? String(serverSession.host || '') : '';
      const deployed = [];
      const skipped = [];
      for (const item of result.renewed) {
        const prev = beforeRenew.get(item.domain) || null;
        const decision = shouldRedeploy(prev && prev.nginx, nowHost);
        if (!decision.deploy) {
          if (decision.reason) skipped.push(`${item.domain}：${decision.reason}`);
          continue;
        }
        try {
          const fresh = acmeManager.get(item.domain) || prev;
          const r = await syncCertToServerNginx(fresh);
          if (r && r.ok) deployed.push(item.domain);
          else skipped.push(`${item.domain}：${(r && r.error) || '部署失败'}`);
        } catch (e) {
          skipped.push(`${item.domain}：${(e && e.message) || e}`);
        }
      }
      if (deployed.length) {
        notify('info', '新证书已重新部署到 nginx', `${deployed.join('、')}（已重载 nginx，浏览器再来就是新证书）`);
      }
      if (skipped.length) {
        notify('warn', '证书续了，但没部署到 nginx', `${skipped.join('；')}。服务器上仍是旧证书，到期后 https://域名 会打不开 —— 到「HTTPS 证书」页点「部署到 nginx」。`);
      }
      pushState(); // 刷新证书列表，让到期天数与部署徽标即时更新
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
  /* 多连接迁移只在第一次升级时写盘一次（load 本身是只读的）。
   * 落盘之后，settings.json 里才有 connections[]；界面与运行期行为都不变。 */
  try {
    if (settingsModule.persistMigration()) {
      settings = settingsModule.load();
      console.log('[connections] 已把单份配置迁移成一条连接（id=c-default）');
    }
  } catch (e) {
    console.warn('[connections] 迁移落盘失败，本次仍按内存结果运行：', e && e.message);
  }
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
  /* 老数据里同一个 IP 可能堆着十几条档案（连接表单每连一次就新建一条）。
   * 先合并再往下走：后面的 activeServerId 兜底、托盘菜单、下拉列表都按「一台机器一条」来。 */
  dedupeServerProfiles();
  /* 访问路径的历史脏数据：老版本不限字符、也不看代理类型，settings 里可能留着
   * 「udp 代理带访问路径」或带分号/换行的路径（那种值会写进 nginx 的 return 302）。
   * 启动时统一过一遍闸：类型不对或字符不合法的直接丢掉，免得以后改类型时突然生效。 */
  pruneOpenPaths();
  // 兜底：有档案但没有 activeServerId 时固定下来，避免每次启动都靠“取第一个”的隐式行为。
  if (!settings.activeServerId && settings.servers.length) {
    const fallback = findServerProfile(settings.clientServerId) || settings.servers[0];
    settings = settingsModule.save({ activeServerId: fallback.id });
  }
  follower.maxLines = Math.min(2000, Math.max(100, Number(settings.logBuffer) || 600));
  updateLogFile();
  /* 隧道守护：只决定“什么时候再试一次”，真正拉起的动作在 restart 回调里。
   * 依赖 manager（在下面创建），所以回调里用惰性引用。 */
  supervisor = new ReconnectSupervisor({
    restart: async () => {
      if (!manager) return { ok: false, error: '管理器还没准备好' };
      suppressExitUntil = Date.now() + 12000;
      /* force：同上，避免『apiOk 还是旧值 ⇒ already』把重连吞掉。 */
      const result = await manager.start({ runMode: settings.runMode, force: true });
      await manager.refresh().catch(() => {});
      if (result && result.ok) {
        /* 用当前配置起来的，记下指纹：否则界面会一直挂着“配置变了，重启隧道才生效”。 */
        startedFingerprint = configModule.connFingerprint(model);
      }
      healthCache.clear();
      scheduleHealth(1500);
      return result;
    },
    canRestart: () => {
      const why = supervisorBlockReason();
      if (why) {
        // 只在“本来想重连但被挡住”时说一句，便于现场排查（正常停止不会走到这里）。
        console.warn(`[reconnect] 跳过自动重连：${why}`);
        return false;
      }
      return true;
    },
    onChange: () => {
      pushState();
      refreshTray();
    },
    log: (message, level) => {
      const line = `${new Date().toISOString().slice(0, 19).replace('T', ' ')} ${level === 'error' ? 'ERR' : 'WRN'} ${message}`;
      try {
        follower.appendLines(line);
      } catch (e) {
        /* 日志失败不影响重连 */
      }
    },
  });
  manager = new FrpcManager({
    getSettings: () => settings,
    getPaths: () => paths,
    getConfig: () => model,
    ensureAdminConfig: async () => {
      /* 先用磁盘上的内容覆盖内存模型：否则「文件里没有 webServer」这种情况
       * 会被内存里的旧值挡住，什么也不写，frpc 就用默认 7400/admin 起来。 */
      syncModelFromDiskIfChanged();
      const changed = configModule.ensureAdmin(model, settings);
      if (changed) {
        const saved = persistModel(model, { reload: false });
        if (!saved.ok) {
          /* 校验失败时 persistModel 返回的是 {errors}，没有 error 字段——
           * 直接兜底成「无法写入管理 API 配置」会把真正原因（域名/端口冲突）吃掉。 */
          const first = (saved.errors || [])[0];
          const detail = first ? String(first.message || first) : (saved.error || '无法写入管理 API 配置');
          return { ok: false, error: `配置有问题，启动前先改掉：${detail}` };
        }
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
    /* 判“意外”看的是有没有错误文本，而不是退出码：
     * 用户主动停止时 frpc 可能返回 1（停止时代理还没登录上），那不是故障。 */
    /* 「意外」= 不是用户让停的。以前看 info.error，而 taskkill 掉的 frpc 可能以 0 退出、
     * error 为空 → 被当成正常停止，自动重连不触发（多连接阶段 3 的探针抓到的）。 */
    const unexpected = !!(info && info.intentional !== true);
    /* 自动重连不受 suppressExitUntil 影响 —— 那个窗口只是“别弹通知”的静音期
     *（用户刚点过停止/重启时不要把正常退出报成故障）。以前把重连也塞在窗口里，
     * 结果「停止后 12 秒内又启动、然后进程被杀」这类真实场景不会重连。 */
    if (unexpected && supervisor && tunnelDesired) {
      const why = String(info.error || '').slice(0, 120);
      console.warn(`[reconnect] frpc 意外退出，排队重连：${why}`);
      supervisor.arm(why || 'frpc 意外退出');
    }
    if (Date.now() > suppressExitUntil) {
      send('notify', {
        kind: unexpected ? 'error' : 'info',
        title: unexpected ? '隧道意外停止' : '隧道已停止',
        message: (info && info.error) || 'frpc 已退出',
      });
    }
  });
  /* frpc 自己的输出（stdout/stderr）：log.to = "console" 或用户把日志指到别处时，
   * 日志文件里什么都不会有，只跟随文件会让日志页看起来冻住了。进程输出按行补齐后
   * 塞进同一个缓冲（分块可能把一行切开，所以按流各留一个半行缓冲）。 */
  const outputPartial = { stdout: '', stderr: '' };
  manager.on('output', (chunk, stream) => {
    const key = stream === 'stderr' ? 'stderr' : 'stdout';
    const buf = (outputPartial[key] || '') + chunk;
    const parts = buf.split(/\r?\n/);
    outputPartial[key] = parts.pop() || '';
    const text = parts.join('\n');
    if (text.trim()) follower.appendLines(text);
  });
  follower.start();
  /* ===== 多连接运行期（阶段 2）=====
   * 一条连接 = 一个 FrpcManager。「当前选中」的那条继续用上面的 manager
   *（大量既有代码都通过它工作，包括 IPC、健康检查、托盘），其它连接用
   * extraManagers 惰性创建，互不干扰。
   *
   * 关键点：非当前连接没有全局 model，所以它们的 ctx 各自从自己的 frpc.toml
   * 读一份模型（只读缓存），绝不复用当前连接的 model —— 否则两条隧道会拿
   * 对方的代理列表和 token 去连（1.2.138 那类“配置与会话对不上”的翻版）。
   */
  const extraManagers = new Map();
  const parkedModels = new Map();
  const guards = new Map();
  /* 每条连接最后一次「用户要求停止」的时刻。frpc 的 stopping 标记在
   * stop→start 的边界上不可靠（探针里被外面杀掉的进程仍报 intentional:true），
   * 所以额外用时间窗兜一层：刚点过停止就别再当成意外退出。 */
  const stopRequests = new Map();
  multiConnection = { extraManagers, parkedModels, guards, stopRequests };
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
  // 启动 5 秒后后台同步一次 nginx 反代状态：用户可能没连服务器页就新建代理，
  // 提前把「公网地址要不要带端口」这个事实同步过来。
  const initialNginxSync = setTimeout(() => syncNginxProxyStateInBackground().catch(() => {}), 5000);
  if (initialNginxSync.unref) initialNginxSync.unref();
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
  /* 退出时把自动重连彻底关掉：否则守护的定时器可能在退出过程中把 frpc 又拉起来。 */
  tunnelDesired = false;
  if (supervisor) supervisor.cancel('退出应用');
  if (multiConnection) {
    for (const guard of multiConnection.guards.values()) guard.cancel('退出应用');
    multiConnection.stopRequests.clear();
  }

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
  /* 更新期间绝不能重连：安装器要覆盖安装目录，抢一个 frpc 会让升级失败。 */
  updatingNow = true;
  if (supervisor) supervisor.cancel('正在安装更新');
  if (multiConnection) {
    for (const guard of multiConnection.guards.values()) guard.cancel('正在安装更新');
  }
  // 记录更新前隧道是否由控制台托管（用于更新后自动接回）
  const wasManaged = !!(manager && manager.isChildAlive);
  // 1) 优雅停掉控制台托管的 frpc（如果还在跑）
  if (wasManaged) {
    try {
      await manager.stop({ runMode: settings.runMode });
    } catch {
      /* 停不掉也继续：下面 taskkill 兜底 */
    }
  }
  // 2) 兜底：更新时绝不能留任何 frpc.exe 进程在跑。它会锁住安装目录里的
  //    内置 frpc.exe（resources/frpc），导致 NSIS 卸载旧文件时 Rename 失败，
  //    报 "Failed to uninstall old application files"。taskkill 找不到进程
  //    会返回非 0，属正常，忽略即可。
  try {
    await execFileP('taskkill.exe', ['/F', '/IM', 'frpc.exe'], { timeout: 8000 });
  } catch {
    /* execFileP 不 reject，此处仅保险 */
  }
  // 2b) frpc 若由 Windows 服务托管（nssm 等），taskkill 后会立刻被拉活，
  //     还是锁着安装目录。尽力停一下常见服务（per-user 应用通常没有
  //     管理员权限，停不掉就交给安装器/用户处理），然后再确认一次。
  for (const svc of ['nssmfrpc', 'frpc']) {
    try {
      const q = await execFileP('sc.exe', ['query', svc], { timeout: 5000 });
      if (q && /RUNNING/.test(q.stdout || '')) {
        try {
          await execFileP('sc.exe', ['stop', svc], { timeout: 5000 });
          console.log(`[update] 已请求停止服务 ${svc}（frpc 由服务托管）`);
        } catch {
          console.log(`[update] 服务 ${svc} 在运行但停不掉（可能需要管理员权限）`);
        }
      }
    } catch {
      /* 服务不存在（退出码 1060）——正常，跳过 */
    }
  }
  // 2c) 最终确认：还有 frpc.exe 在跑就记日志提醒（不阻塞更新流程）
  try {
    const list = await execFileP('tasklist.exe', ['/FI', 'IMAGENAME eq frpc.exe'], { timeout: 5000 });
    if (list && /frpc\.exe/i.test(list.stdout || '')) {
      console.warn('[update] 警告：更新前 frpc.exe 仍在运行，可能锁住安装目录导致升级失败');
    }
  } catch {
    /* 查询失败不影响更新 */
  }
  // 3) 写便条：更新后凭它把隧道接回来
  if (wasManaged) {
    try {
      const file = updateFlagPath();
      if (file) fs.writeFileSync(file, JSON.stringify({ at: Date.now() }), 'utf8');
    } catch {
      /* 便条写不下去只影响“更新后自动拉起隧道”，不影响更新本身 */
    }
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
    syncLaunchAtLogin().catch(() => {});
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
        .then(() => {
          tunnelDesired = true;
          return manager.refresh();
        })
        .then(() => pushState())
        .catch(() => {});
    }
    /* 档 3：系统唤醒 / 解锁 / 换网之后，连接常常已经假死了（socket 还在，包发不出去）。
     * 这里先让 frpc 自己试 20 秒，没恢复就交给守护重启。 */
    const afterSystemResume = (why) => {
      if (!tunnelDesired || updatingNow) return;
      setTimeout(() => {
        if (!tunnelDesired || updatingNow) return;
        manager.refresh().catch(() => {});
        if (manager.snapshot().connected) return;
        if (supervisor && !supervisor.isWaiting()) supervisor.arm(why);
      }, 20000);
    };
    try {
      powerMonitor.on('resume', () => afterSystemResume('系统从睡眠中唤醒后没恢复'));
      powerMonitor.on('unlock-screen', () => afterSystemResume('解锁后没恢复'));
    } catch (e) {
      if (process.env.FRP_CONSOLE_DEBUG) console.warn('[reconnect] 监听电源事件失败', e && e.message);
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
  /* GUI 程序从终端启动时崩溃/退出不打字到控制台，这里显式写到 stderr，
   * 让「为什么窗口没出来」至少有一条线索（npm start 的开发模式能看到）。 */
  console.error('[frp-console] userData 被另一个实例占用（单实例锁获取失败），本进程退出。'
    + '若你想同时跑源码版和安装版，请用 npm start（自动使用独立数据目录）。');
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
    console.error('[frp-console] 检测到已有一个控制台实例在运行（端口 '
      + (Number(process.env.FRP_INSTANCE_PORT) || 47823) + '），已把它叫到前台，本进程退出。');
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
