'use strict';
/*
 * 托盘自检工具：创建一个真实托盘图标并驻留 20 秒，连续打印 getBounds()。
 *
 * getBounds() 全 0 = 系统没有给图标分配屏幕位置，也就是“假托盘”：
 * Tray 对象创建成功，但 Shell_NotifyIcon 失败（--enable-logging 可见
 * notify_icon.cc: Unable to create status tray icon）。应用里的 probeTray()
 * 就是用这个判据决定「关闭窗口是收进托盘还是直接退出」。
 *
 * 排障时可以和 tools/tray_native_probe.py（原生 Shell_NotifyIconW）对照：
 * 原生成功而本工具失败，说明问题不在 Windows 通知区本身。
 *
 * 用法：npx electron tools/tray-hold.cjs --no-sandbox [--enable-logging]
 */
const path = require('node:path');
const { app, Tray } = require('electron');

app.whenReady().then(() => {
  const tray = new Tray(path.join(__dirname, '..', 'assets', 'tray-online.png'));
  tray.setToolTip('FRP 控制台 · 托盘自检');
  const probe = () => {
    try {
      console.log(`getBounds -> ${JSON.stringify(tray.getBounds())} destroyed=${tray.isDestroyed()}`);
    } catch (e) {
      console.log(`getBounds ERROR ${e.message}`);
    }
  };
  probe();
  setTimeout(probe, 2000);
  setTimeout(probe, 5000);
  setTimeout(() => {
    tray.destroy();
    app.exit(0);
  }, 20000);
});
