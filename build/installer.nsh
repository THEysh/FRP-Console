; FRP 控制台 · NSIS 自定义安装脚本
;
; 为什么需要这个文件：
;   本机（管理员账户 + 受限桌面）里 Chromium 沙箱初始化会失败，进程在进入 main 进程
;   代码之前就以退出码 3 结束，界面完全没有提示；`app.commandLine.appendSwitch` 此时
;   还没执行，所以只能由命令行参数传入 --no-sandbox。
;   electron-builder 默认生成的快捷方式不带参数，导致“装完双击没反应”。
;   这里把桌面与开始菜单的快捷方式覆盖成带 --no-sandbox 的版本。
;
; 变量说明：
;   ${APP_EXECUTABLE_FILENAME} 由 electron-builder 注入（= FRP控制台.exe）
;   ${SHORTCUT_NAME}           由 electron-builder 注入（= shortcutName 配置）

!macro customInstall
  CreateShortCut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--no-sandbox" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
  CreateShortCut "$SMPROGRAMS\${SHORTCUT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--no-sandbox" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
!macroend

!macro customUnInstall
  Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
  Delete "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
!macroend

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
