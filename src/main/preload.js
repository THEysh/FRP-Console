'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

/*
 * 每个频道可以有多个订阅者。
 * 早先的实现用 Map 只记住“第一个”回调，第二个订阅同一频道会静默失效；
 * 这里改成按频道挂一个转发器 + 回调集合，退订只摘掉自己那一个。
 */
const bridges = new Map();

function on(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  let bridge = bridges.get(channel);
  if (!bridge) {
    bridge = { callbacks: new Set(), handler: null };
    bridge.handler = (event, payload) => {
      for (const cb of [...bridge.callbacks]) {
        try {
          cb(payload);
        } catch (e) {
          // 单个订阅者出错不能拖垮其它订阅者 / IPC 事件循环
          console.error(`[preload] ${channel} 回调异常`, e);
        }
      }
    };
    ipcRenderer.on(channel, bridge.handler);
    bridges.set(channel, bridge);
  }
  bridge.callbacks.add(callback);
  return () => {
    const current = bridges.get(channel);
    if (!current) return;
    current.callbacks.delete(callback);
    if (!current.callbacks.size) {
      ipcRenderer.removeListener(channel, current.handler);
      bridges.delete(channel);
    }
  };
}

contextBridge.exposeInMainWorld('FRP', {
  init: () => invoke('app:init'),
  refresh: () => invoke('state:refresh'),
  saveSettings: (patch) => invoke('settings:save', patch),
  pickPath: (kind) => invoke('paths:pick', kind),
  revealPath: (which) => invoke('paths:reveal', which),
  saveConfig: (config) => invoke('config:save', config),
  configBackups: () => invoke('config:backups'),
  configRestoreBackup: (file) => invoke('config:restore-backup', { file }),
  saveProxy: (mode, originalName, proxy) => invoke('proxy:save', { mode, originalName, proxy }),
  deleteProxy: (name) => invoke('proxy:delete', name),
  suggestPort: (type) => invoke('proxy:suggest-port', type),
  randomPort: (type) => invoke('proxy:random-port', type),
  checkPort: (port) => invoke('proxy:check-port', port),
  startTunnel: () => invoke('tunnel:start'),
  stopTunnel: () => invoke('tunnel:stop'),
  restartTunnel: () => invoke('tunnel:restart'),
  reloadTunnel: () => invoke('tunnel:reload'),
  serviceControl: (action, value) => invoke('service:control', { action, value }),
  enableAdmin: () => invoke('admin:enable'),
  scanListeners: () => invoke('listen:scan'),
  certList: () => invoke('cert:list'),
  certIssue: (payload) => invoke('cert:issue', payload),
  certRenew: (domain) => invoke('cert:renew', { domain }),
  certRemove: (domain) => invoke('cert:remove', { domain }),
  certNginxSync: (payload) => invoke('cert:nginx-sync', payload),
  dnsState: () => invoke('dns:state'),
  dnsSave: (payload) => invoke('dns:save', payload),
  dnsResolve: (domain) => invoke('dns:resolve', domain),
  dnsSetA: (payload) => invoke('dns:set-a', payload),
  dnsVerify: (payload) => invoke('dns:verify', payload),
  serverState: () => invoke('server:state'),
  serverSelect: (id) => invoke('server:select', { id }),
  serverProfileSave: (payload) => invoke('server:profile-save', payload),
  serverProfileDelete: (id, force) => invoke('server:profile-delete', { id, force }),
  serverProfileClearPassword: (id) => invoke('server:profile-clear-password', { id }),
  serverApply: (id, force) => invoke('server:apply', { id, force }),
  serverBindClient: (payload) => invoke('server:bind-client', payload),
  serverConnect: (payload) => invoke('server:connect', payload),
  serverDisconnect: () => invoke('server:disconnect'),
  serverRefresh: () => invoke('server:refresh'),
  serverReadConfig: () => invoke('server:read-config'),
  serverPreview: (fields) => invoke('server:preview', { fields }),
  serverBootstrap: (fields, options = {}) => invoke('server:bootstrap', { fields, ...options }),
  serverBootstrapCancel: () => invoke('server:bootstrap-cancel'),
  serverUninstall: (payload) => invoke('server:uninstall', payload),
  serverSelfTest: (layer) => invoke('server:selftest', { layer }),
  serverNginxState: () => invoke('server:nginx-state'),
  serverNginxSetup: (payload) => invoke('server:nginx-setup', payload),
  serverNginxFree: () => invoke('server:nginx-free'),
  serverFirewallState: () => invoke('server:firewall-state'),
  serverFirewallOpen: () => invoke('server:firewall-open'),
  serverFirewallInstall: () => invoke('server:firewall-install'),
  serverFirewallOpenPorts: (payload) => invoke('server:firewall-open-ports', payload),
  serverKillPorts: (ports) => invoke('server:kill-ports', { ports }),
  serverControl: (action) => invoke('server:control', { action }),
  serverSaveConfig: (content, restart, resolve) => invoke('server:save-config', { content, restart, resolve }),
  serverLogs: (lines) => invoke('server:logs', { lines }),
  probeTcp: (host, port, timeout) => invoke('probe:tcp', { host, port, timeout }),
  getLogs: (limit, since) => invoke('logs:get', { limit, since }),
  clearLogs: () => invoke('logs:clear'),
  exportLogs: () => invoke('logs:export'),
  copy: (text) => invoke('clipboard:write', text),
  openUrl: (url) => invoke('shell:open', url),
  windowControl: (action) => invoke('window:control', action),
  quit: () => invoke('app:quit'),
  trayState: () => invoke('app:tray-state'),
  notify: (kind, title, message) => invoke('app:notification', { kind, title, message }),
  createShortcut: () => invoke('app:create-shortcut'),
  // 自动更新：状态在主进程，渲染层只做展示与触发
  updateState: () => invoke('update:state'),
  checkUpdate: () => invoke('update:check'),
  downloadUpdate: () => invoke('update:download'),
  installUpdate: () => invoke('update:install'),
  on,
});
