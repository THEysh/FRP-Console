'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

const listeners = new Map();
function on(channel, callback) {
  if (!listeners.has(channel)) {
    const handler = (event, payload) => callback(payload);
    ipcRenderer.on(channel, handler);
    listeners.set(channel, handler);
  }
  return () => {
    const handler = listeners.get(channel);
    if (handler) {
      ipcRenderer.removeListener(channel, handler);
      listeners.delete(channel);
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
  saveProxy: (mode, originalName, proxy) => invoke('proxy:save', { mode, originalName, proxy }),
  deleteProxy: (name) => invoke('proxy:delete', name),
  suggestPort: (type) => invoke('proxy:suggest-port', type),
  startTunnel: () => invoke('tunnel:start'),
  stopTunnel: () => invoke('tunnel:stop'),
  restartTunnel: () => invoke('tunnel:restart'),
  reloadTunnel: () => invoke('tunnel:reload'),
  serviceControl: (action, value) => invoke('service:control', { action, value }),
  enableAdmin: () => invoke('admin:enable'),
  scanListeners: () => invoke('listen:scan'),
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
  serverSelfTest: (layer) => invoke('server:selftest', { layer }),
  serverControl: (action) => invoke('server:control', { action }),
  serverSaveConfig: (content, restart) => invoke('server:save-config', { content, restart }),
  serverLogs: (lines) => invoke('server:logs', { lines }),
  probeTcp: (host, port, timeout) => invoke('probe:tcp', { host, port, timeout }),
  getLogs: (limit, since) => invoke('logs:get', { limit, since }),
  clearLogs: () => invoke('logs:clear'),
  exportLogs: () => invoke('logs:export'),
  copy: (text) => invoke('clipboard:write', text),
  openUrl: (url) => invoke('shell:open', url),
  windowControl: (action) => invoke('window:control', action),
  quit: () => invoke('app:quit'),
  notify: (kind, title, message) => invoke('app:notification', { kind, title, message }),
  createShortcut: () => invoke('app:create-shortcut'),
  on,
});
