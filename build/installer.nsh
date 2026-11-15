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
; 这里直接按进程名结束。
;
; ⚠ 绝对不能用 /T（结束子进程树）：应用内更新时，安装器本身是
;   electron-updater 用 spawn(detached) 从正在运行的应用里拉起来的**子进程**，
;   /T 会把安装器自己一起杀掉 —— 表现为「点重启并安装，窗口没了，版本没变，
;   没有任何提示」（退出码 1，安装目录一个字节都没动）。
;   隧道进程由应用自己在 prepareUpdateInstall / quitApp 里先停掉，
;   不需要安装器代劳；这里只负责结束控制台本体。
!macro customCheckAppRunning
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM "${APP_EXECUTABLE_FILENAME}"'
  Pop $0
  ; 双保险：隧道进程虽然应由应用在 prepareUpdateInstall / quitApp 里先停掉，
  ; 但如果停晚了或没停干净，它会锁住安装目录里的内置 frpc.exe，导致卸载旧
  ; 文件 Rename 失败、报 "Failed to uninstall old application files"。
  ; 这里再补一刀（同样不带 /T，frpc.exe 也不是安装器，不会误杀自己）。
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM "frpc.exe"'
  Pop $0
  Sleep 700
!macroend

; ---------------------------------------------------------------------------
; 升级前抢救用户放在安装目录里的文件
;
; electron-builder 的卸载旧版本流程是「把 $INSTDIR 整体改名搬走 → RMDir /r
; $INSTDIR → 解压新文件」（uninstaller.nsh 的 isUpdated 分支），所以安装目录里
; 的任何东西在升级时都会消失。而 README 长期建议「frpc.exe 放在控制台同目录」，
; 不少用户就这么干，一升级连 frpc.toml 和 frp-console-backups/ 一起没了。
;
; 做法：在 .onInit（早于卸载旧版）把这几样搬到 %LOCALAPPDATA%\frp-console\
; upgrade-rescue，装完再搬回去，路径不变、配置继续有效。优先用 Rename（同卷
; 秒完成），跨卷或被占用时退回 CopyFiles。
; ---------------------------------------------------------------------------
; 这两个变量只在安装器（非卸载器）里用到。卸载器那一趟是同一份脚本用
; BUILD_UNINSTALLER 编译的，不加这层判断会报 warning 6001（声明了没用），
; 而 electron-builder 把 NSIS 的 warning 当 error。
!ifndef BUILD_UNINSTALLER
Var /GLOBAL FrpRescueDir
Var /GLOBAL FrpRescueDone
Var /GLOBAL FrpRescueOk
!endif

!macro customInit
  StrCpy $FrpRescueDone "0"
  StrCpy $FrpRescueDir "$LOCALAPPDATA\frp-console\upgrade-rescue"

  ; 没装过旧版就没什么可抢救的
  IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 frp_rescue_end

  ; 先把控制台结束掉，否则它拉着 frpc.exe，改名/复制都会失败。
  ; 同样不能带 /T —— 应用内更新时这个安装器就是控制台的子进程，/T 会连自己一起杀。
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM "${APP_EXECUTABLE_FILENAME}"'
  Pop $0
  Sleep 500

  ; 上一次升级如果半路失败（解压中断、被杀、断电），用户文件还留在 upgrade-rescue
  ; 里、而安装目录是空的。这种时候先放回去，否则下面那句 RMDir 会把它删干净。
  IfFileExists "$FrpRescueDir\frpc.exe" 0 frp_rescue_prev_toml
    IfFileExists "$INSTDIR\frpc.exe" frp_rescue_prev_toml
      CopyFiles /SILENT "$FrpRescueDir\frpc.exe" "$INSTDIR"
  frp_rescue_prev_toml:
  IfFileExists "$FrpRescueDir\frpc.toml" 0 frp_rescue_wipe
    IfFileExists "$INSTDIR\frpc.toml" frp_rescue_wipe
      CopyFiles /SILENT "$FrpRescueDir\frpc.toml" "$INSTDIR"

  frp_rescue_wipe:
  RMDir /r "$FrpRescueDir"
  CreateDirectory "$FrpRescueDir"

  IfFileExists "$INSTDIR\frpc.exe" 0 frp_rescue_toml
    StrCpy $FrpRescueDone "1"
    ClearErrors
    Rename "$INSTDIR\frpc.exe" "$FrpRescueDir\frpc.exe"
    IfErrors 0 frp_rescue_toml
      CopyFiles /SILENT "$INSTDIR\frpc.exe" "$FrpRescueDir"

  frp_rescue_toml:
  IfFileExists "$INSTDIR\frpc.toml" 0 frp_rescue_bak
    StrCpy $FrpRescueDone "1"
    ClearErrors
    Rename "$INSTDIR\frpc.toml" "$FrpRescueDir\frpc.toml"
    IfErrors 0 frp_rescue_bak
      CopyFiles /SILENT "$INSTDIR\frpc.toml" "$FrpRescueDir"

  frp_rescue_bak:
  IfFileExists "$INSTDIR\frp-console-backups\*.*" 0 frp_rescue_data
    StrCpy $FrpRescueDone "1"
    ClearErrors
    Rename "$INSTDIR\frp-console-backups" "$FrpRescueDir\frp-console-backups"
    IfErrors 0 frp_rescue_data
      CreateDirectory "$FrpRescueDir\frp-console-backups"
      CopyFiles /SILENT "$INSTDIR\frp-console-backups\*.*" "$FrpRescueDir\frp-console-backups"

  frp_rescue_data:
  IfFileExists "$INSTDIR\frp-console-data\*.*" 0 frp_rescue_end
    StrCpy $FrpRescueDone "1"
    ClearErrors
    Rename "$INSTDIR\frp-console-data" "$FrpRescueDir\frp-console-data"

  frp_rescue_end:
!macroend

!macro customInstall
  StrCmp $FrpRescueDone "1" 0 frp_restore_end

  IfFileExists "$FrpRescueDir\frpc.exe" 0 frp_restore_toml
    CopyFiles /SILENT "$FrpRescueDir\frpc.exe" "$INSTDIR"

  frp_restore_toml:
  IfFileExists "$FrpRescueDir\frpc.toml" 0 frp_restore_bak
    CopyFiles /SILENT "$FrpRescueDir\frpc.toml" "$INSTDIR"

  frp_restore_bak:
  IfFileExists "$FrpRescueDir\frp-console-backups" 0 frp_restore_data
    ClearErrors
    Rename "$FrpRescueDir\frp-console-backups" "$INSTDIR\frp-console-backups"
    IfErrors 0 frp_restore_data
      CreateDirectory "$INSTDIR\frp-console-backups"
      CopyFiles /SILENT "$FrpRescueDir\frp-console-backups\*.*" "$INSTDIR\frp-console-backups"

  frp_restore_data:
  IfFileExists "$FrpRescueDir\frp-console-data" 0 frp_restore_clean
    ClearErrors
    Rename "$FrpRescueDir\frp-console-data" "$INSTDIR\frp-console-data"

  frp_restore_clean:
  ; 放回去了才清抢救目录。复制失败（被占用、磁盘满）时留着，
  ; 那是用户 frpc.exe / frpc.toml 唯一的一份，宁可留个目录也不能删。
  StrCpy $FrpRescueOk "1"

  IfFileExists "$FrpRescueDir\frpc.exe" 0 frp_rescue_ok_toml
    IfFileExists "$INSTDIR\frpc.exe" frp_rescue_ok_toml
      StrCpy $FrpRescueOk "0"
  frp_rescue_ok_toml:

  IfFileExists "$FrpRescueDir\frpc.toml" 0 frp_rescue_ok_data
    IfFileExists "$INSTDIR\frpc.toml" frp_rescue_ok_data
      StrCpy $FrpRescueOk "0"
  frp_rescue_ok_data:

  IfFileExists "$FrpRescueDir\frp-console-backups\*.*" 0 frp_rescue_ok_bak
    IfFileExists "$INSTDIR\frp-console-backups\*.*" frp_rescue_ok_bak
      StrCpy $FrpRescueOk "0"
  frp_rescue_ok_bak:

  IfFileExists "$FrpRescueDir\frp-console-data\*.*" 0 frp_rescue_ok_decide
    IfFileExists "$INSTDIR\frp-console-data\*.*" frp_rescue_ok_decide
      StrCpy $FrpRescueOk "0"
  frp_rescue_ok_decide:

  StrCmp $FrpRescueOk "1" 0 frp_restore_keep
    RMDir /r "$FrpRescueDir"
  frp_restore_keep:
  StrCpy $FrpRescueDone "0"

  frp_restore_end:
!macroend
