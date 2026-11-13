'use strict';

const { app } = require('electron');

/*
 * 自动更新（electron-updater + NSIS 安装包）
 *
 * 边界：
 *  - 只有「安装版」能自动更新。便携版更新不了自己正在运行的 exe，
 *    开发模式没有 app-update.yml，两者都只回报原因，不发起网络请求。
 *  - 不做启动时自动检查：这个程序对外承诺过「不主动往外发包」，
 *    检查更新由用户点按钮触发（README「安全说明」一节）。
 *  - 下载完不立即安装：等用户点「重启并安装」，避免把正在用的隧道掐掉。
 *
 * 更新源来自 electron-builder 打包时生成的 resources/app-update.yml
 * （package.json 的 build.publish），不需要在这里写 owner/repo。
 */

const RELEASE_PAGE = 'https://github.com/THEysh/FRP-Console/releases/latest';
/* 检查更新的超时上限：超过就按网络失败处理，别让界面一直转圈 */
const CHECK_TIMEOUT_MS = 20000;

let autoUpdater = null;
let initialized = false;
let onStatus = () => {};
let beforeInstall = async () => {};
/* 已确认存在的新版本号。download() 只认这个，而不是 status.state——
 * 否则一次“检查失败”的 error 也会让界面放行下载，downloadUpdate() 拿不到
 * updateInfo 只会抛更难懂的错误。 */
let availableVersion = '';

let status = {
  state: 'idle',
  supported: false,
  reason: '',
  currentVersion: '',
  version: '',
  percent: 0,
  transferred: 0,
  total: 0,
  bytesPerSecond: 0,
  message: '',
  checkedAt: 0,
  releaseUrl: RELEASE_PAGE,
};

function snapshot() {
  return { ...status, currentVersion: app.getVersion() };
}

function emit(patch) {
  status = { ...status, ...patch };
  try {
    onStatus(snapshot());
  } catch {
    /* 界面没起来时不能把更新流程带崩 */
  }
  return snapshot();
}

/* 为什么这台机器不能自动更新。返回空串表示支持。 */
function unsupportedReason() {
  // 便携版启动时 electron-builder 会注入这两个环境变量
  if (process.env.PORTABLE_EXECUTABLE_DIR || process.env.PORTABLE_EXECUTABLE_FILE) return 'portable';
  if (!app.isPackaged) return 'dev';
  return '';
}

function reasonText(reason) {
  if (reason === 'portable') return '便携版不支持自动更新，请到 Release 页下载新版本';
  if (reason === 'dev') return '开发模式（未打包）不检查更新';
  return '';
}

/* 把底层的异常翻译成用户能照着做的说法。
 * 顺序有讲究：403 的报错里也可能带着 github.com/.../latest.yml 之类的 URL，
 * 限流判断必须排在“缺少 latest.yml”前面，否则会给出错误的处置建议。 */
function explain(error) {
  const text = (error && (error.message || String(error))) || '未知错误';
  if (/403|rate limit|API rate/i.test(text)) {
    return 'GitHub 接口限流了（未登录请求每小时有限额），过一会儿再试';
  }
  if (/latest\.yml|is not found|404/i.test(text)) {
    return '更新源缺少 latest.yml：发布时要把 latest.yml 和 .blockmap 一起挂到 Release';
  }
  if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EAI_AGAIN|socket hang up|net::/i.test(text)) {
    return '连不上更新服务器（GitHub），检查网络或代理后重试';
  }
  if (/sha512|checksum|integrity/i.test(text)) {
    return '更新包校验失败：下载被中断或文件被替换，请重新下载';
  }
  return text;
}

function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

function init({ onStatus: statusCallback, beforeInstall: hook } = {}) {
  if (typeof statusCallback === 'function') onStatus = statusCallback;
  if (typeof hook === 'function') beforeInstall = hook;
  if (initialized) return snapshot();
  initialized = true;

  const reason = unsupportedReason();
  if (reason) {
    return emit({ state: 'unsupported', supported: false, reason, message: reasonText(reason) });
  }

  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (e) {
    return emit({ state: 'error', supported: false, reason: 'module', message: `加载更新模块失败：${explain(e)}` });
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.autoRunAppAfterInstall = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  // 交给统一日志，别让 electron-updater 往控制台刷一堆没人看的东西
  autoUpdater.logger = {
    info: (m) => console.log(`[update] ${m}`),
    warn: (m) => console.log(`[update] ${m}`),
    error: (m) => console.log(`[update] ${m}`),
    debug: () => {},
  };

  autoUpdater.on('checking-for-update', () => {
    emit({ state: 'checking', message: '正在检查更新…', percent: 0 });
  });
  autoUpdater.on('update-available', (info) => {
    availableVersion = (info && info.version) || '';
    emit({
      state: 'available',
      supported: true,
      reason: '',
      version: availableVersion,
      percent: 0,
      checkedAt: Date.now(),
      message: `发现新版本 v${availableVersion}`,
    });
  });
  autoUpdater.on('update-not-available', (info) => {
    availableVersion = '';
    emit({
      state: 'uptodate',
      supported: true,
      reason: '',
      version: (info && info.version) || app.getVersion(),
      checkedAt: Date.now(),
      message: '已是最新版本',
    });
  });
  autoUpdater.on('download-progress', (p) => {
    const percent = Math.max(0, Math.min(100, Math.round((p && p.percent) || 0)));
    emit({
      state: 'downloading',
      percent,
      transferred: (p && p.transferred) || 0,
      total: (p && p.total) || 0,
      bytesPerSecond: (p && p.bytesPerSecond) || 0,
      message: `正在下载 ${percent}%（${humanSize(p && p.transferred)} / ${humanSize(p && p.total)}）`,
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    emit({
      state: 'ready',
      version: (info && info.version) || status.version,
      percent: 100,
      message: `v${(info && info.version) || status.version} 已下载完成，重启后安装`,
    });
  });
  autoUpdater.on('error', (e) => {
    emit({ state: 'error', message: explain(e) });
  });

  return emit({ state: 'idle', supported: true, reason: '', message: '尚未检查更新' });
}

async function check() {
  if (!initialized) init();
  if (!status.supported) return snapshot();
  if (status.state === 'checking' || status.state === 'downloading') return snapshot();
  emit({ state: 'checking', message: '正在检查更新…', percent: 0 });
  /* 网络卡住时 checkForUpdates() 可能挂很久，界面会一直停在“检查中…”且无法重试。
   * 加一层 20 秒超时，超时按网络错误处理。 */
  let timer = null;
  try {
    await Promise.race([
      autoUpdater.checkForUpdates(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('ETIMEDOUT')), CHECK_TIMEOUT_MS);
        if (timer.unref) timer.unref();
      }),
    ]);
  } catch (e) {
    emit({ state: 'error', message: explain(e) });
  } finally {
    if (timer) clearTimeout(timer);
  }
  // 事件回调已经把最终状态写进去了，这里只等它落定
  return snapshot();
}

async function download() {
  if (!initialized) init();
  if (!status.supported) return snapshot();
  // 只认“确认过的新版本”：检查失败留下的 error 不该放行下载
  if (!availableVersion || status.state === 'downloading') return snapshot();
  try {
    await autoUpdater.downloadUpdate();
  } catch (e) {
    emit({ state: 'error', message: explain(e) });
  }
  return snapshot();
}

async function install() {
  if (!initialized) init();
  if (!status.supported) return { ok: false, error: reasonText(status.reason) || '当前版本不支持自动更新' };
  if (status.state !== 'ready') return { ok: false, error: '更新包还没下载完成' };
  try {
    await beforeInstall();
  } catch {
    /* 收尾失败也要继续装：安装器自己会 taskkill 掉本进程 */
  }
  // 先让 IPC 把响应发回渲染层，再退出——否则界面只会看到“连接中断”
  setImmediate(() => {
    try {
      autoUpdater.quitAndInstall(true, true);
    } catch (e) {
      emit({ state: 'error', message: explain(e) });
    }
  });
  return { ok: true };
}

module.exports = { init, check, download, install, snapshot };
