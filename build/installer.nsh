; FRP 控制台 · NSIS 自定义安装脚本
;
; 变量说明：
;   ${APP_EXECUTABLE_FILENAME} 由 electron-builder 注入（= FRP-Console.exe）
;   ${SHORTCUT_NAME}           由 electron-builder 注入（= shortcutName 配置）
;
; 快捷方式保留 electron-builder 的默认行为（不带任何命令行参数）。
; 只有在受限桌面（管理员账户 + 沙箱初始化失败的会话）里双击 exe 才会
; 没有任何反应——那是环境问题，需要给快捷方式手动补 --no-sandbox，
; 不应该默认给所有用户关掉 Chromium 沙箱。

; 覆盖 electron-builder 默认的“检测应用是否在运行”。
;
; 默认实现会向窗口发 WM_CLOSE 然后等进程退出。但本应用默认“关闭到托盘”
; （settings.closeToTray = true），收到 WM_CLOSE 只是隐藏窗口、进程不退，
; 于是安装器一直等到超时，报“FRP控制台无法关闭，请手动关闭”。
;
; 这里直接按进程名结束，并带 /T 一并结束它派生的 frpc 子进程，
; 避免留下孤儿隧道进程。
!macro customCheckAppRunning
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /T /IM "${APP_EXECUTABLE_FILENAME}"'
  Pop $0
  Sleep 700
!macroend
