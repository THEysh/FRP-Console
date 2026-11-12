'use strict';
/* 托盘面板专用的最小桥：只给这几个通道，不把主窗口那套 API 暴露给它。 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('trayAPI', {
  invoke: (id) => ipcRenderer.send('tray:invoke', String(id)),
  hide: () => ipcRenderer.send('tray:hide'),
});
