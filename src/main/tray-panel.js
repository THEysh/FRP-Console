'use strict';
/* 托盘右键面板：原生 Menu 的样式由系统控制，和深色界面完全不搭。这里用一个
 * 无边框透明的小窗口自绘菜单，配色、圆角、行高都跟主界面同一套。
 *
 * 用法：
 *   const panel = new TrayPanel({ preloadPath, rendererPath, onInvoke });
 *   panel.open(model, tray.getBounds());   // 已在显示则收起（模拟右键切换）
 */

const path = require('node:path');
const { BrowserWindow, ipcMain, screen } = require('electron');

const WIDTH = 244;
const MARGIN = 8; // 窗口四周留白，给阴影一点空间（透明窗口会裁掉外溢部分）

class TrayPanel {
  constructor({ preloadPath, rendererPath, onInvoke }) {
    this.preloadPath = preloadPath;
    this.rendererPath = rendererPath;
    this.onInvoke = onInvoke;
    this.win = null;
    this.shownAt = 0;
    this.opening = null;
    this.registerIpc();
  }

  /* 只接受自己那个窗口发来的消息：主窗口也有 ipcRenderer，不能让它顺手调这些。 */
  owns(event) {
    return !!(this.win && !this.win.isDestroyed() && event.sender === this.win.webContents);
  }

  registerIpc() {
    ipcMain.on('tray:invoke', (event, id) => {
      if (process.env.FRP_CONSOLE_DEBUG) console.log('[tray] invoke', id, 'owns=', this.owns(event));
      if (!this.owns(event) || typeof id !== 'string') return;
      this.hide();
      try {
        this.onInvoke(id);
      } catch (e) {
        console.warn('[tray] 菜单动作执行失败', id, e && e.message);
      }
    });
    ipcMain.on('tray:hide', (event) => {
      if (this.owns(event)) this.hide();
    });
  }

  isOpen() {
    return !!(this.win && !this.win.isDestroyed() && this.win.isVisible());
  }

  ensureWindow() {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const win = new BrowserWindow({
      width: WIDTH,
      height: 360,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false, // 阴影由页面自己画，避免和透明背景叠成双层
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        spellcheck: false,
      },
    });
    win.setAlwaysOnTop(true, 'pop-up-menu');
    win.setMenuBarVisibility(false);
    win.loadFile(this.rendererPath);
    // 点面板外面就收起。刚显示时的一次 blur 是抢焦点引起的，忽略掉。
    win.on('blur', () => {
      if (Date.now() - this.shownAt < 220) return;
      this.hide();
    });
    win.on('closed', () => {
      this.win = null;
    });
    this.win = win;
    return win;
  }

  async open(model, anchor) {
    if (this.isOpen()) {
      this.hide();
      return true;
    }
    const win = this.ensureWindow();
    if (win.webContents.isLoading()) {
      await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
    }
    let height = 0;
    try {
      height = await win.webContents.executeJavaScript(`window.__trayRender(${JSON.stringify(model)})`);
    } catch (e) {
      console.warn('[tray] 面板渲染失败', e && e.message);
    }
    const h = Math.max(140, Math.min(760, Math.round(Number(height) || 360)));
    const { x, y } = place(anchor, WIDTH, h);
    win.setBounds({ x, y, width: WIDTH, height: h });
    this.shownAt = Date.now();
    win.show();
    win.focus();
    return true;
  }

  /* 面板开着时定时器会把新状态推过来（隧道状态、在线数会变），不用关掉重开。 */
  async refresh(model) {
    if (!this.isOpen()) return;
    try {
      await this.win.webContents.executeJavaScript(`window.__trayRender(${JSON.stringify(model)}, true)`);
    } catch {
      /* 面板已销毁 */
    }
  }

  hide() {
    if (!this.win || this.win.isDestroyed()) return;
    if (this.win.isVisible()) this.win.hide();
  }

  destroy() {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}

/* 贴着托盘图标弹：图标在屏幕下半部分就往上弹，否则往下弹，并夹在工作区内。 */
function place(anchor, width, height) {
  const point = anchor && anchor.width
    ? { x: Math.round(anchor.x + anchor.width / 2), y: Math.round(anchor.y) }
    : screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(point).workArea;

  let x = Math.round(point.x - width / 2);
  x = Math.min(Math.max(x, area.x + MARGIN), area.x + area.width - width - MARGIN);

  const below = !(anchor && anchor.height) || anchor.y > area.y + area.height / 2;
  let y = below
    ? Math.round((anchor && anchor.height ? anchor.y + anchor.height : point.y) + MARGIN)
    : Math.round(anchor.y - height - MARGIN);
  if (below && y + height > area.y + area.height - MARGIN) y = Math.round(area.y + area.height - height - MARGIN);
  y = Math.min(Math.max(y, area.y + MARGIN), Math.max(area.y + MARGIN, area.y + area.height - height - MARGIN));

  return { x, y };
}

module.exports = { TrayPanel, TRAY_PANEL_WIDTH: WIDTH, TRAY_PANEL_FILE: path.join('..', 'renderer', 'tray.html') };
