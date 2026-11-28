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

; ---------------------------------------------------------------------------
; 跳过「为所有用户 / 仅为当前用户安装」选择页
;
; 本应用固定 perMachine=false + allowElevation=false（不需要 UAC 提权），
; 保留该向导页只会多出一步且「所有用户」单选框处于禁用状态，直接跳过即可。
; ---------------------------------------------------------------------------
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; ---------------------------------------------------------------------------
; 安装进度条与完成页交互优化（仅安装器，卸载器不编译这一段）
;
; 问题根因：
;   electron-builder 的安装节里，NSIS 先用内置 File 指令把 app-64.7z 释放到
;   $PLUGINSDIR（进度条走到 ~60%），随后调用 Nsis7z::Extract 解压 7z（插件直接把
;   同一个进度条重置回 0%→100%），解压完回到 NSIS 执行 CopyFiles/快捷方式时，
;   NSIS 又按自己的指令计数把进度条拉回 ~70%→100% —— 表现为「进度条反复往回退」。
;
; 修复方式：
;   1) 安装页（MUI_PAGE_INSTFILES）显示时把进度条切换为 Windows 原生平滑滚动条
;      （PBS_MARQUEE），并在各阶段更新上方的中文状态文案，进度条永不倒退；
;   2) 安装收尾（customInstall）停止滚动并切回 100%，随后自动进入完成页
;      （MUI_PAGE_FINISH），明确提示安装完成并默认勾选「立即启动 FRP 控制台」。
;   3) 应用内静默更新（/S --updated --force-run）完全走无界面静默通道并自动重启。
; ---------------------------------------------------------------------------
!ifndef BUILD_UNINSTALLER
Var /GLOBAL FrpRescueDir
Var /GLOBAL FrpRescueDone
Var /GLOBAL FrpRescueOk
Var /GLOBAL FrpOldInstDir

!macro FrpSetStatus TEXT
  ${IfNot} ${Silent}
    Push $R8
    Push $R9
    FindWindow $R8 "#32770" "" $HWNDPARENT
    GetDlgItem $R9 $R8 1006
    SendMessage $R9 ${WM_SETTEXT} 0 "STR:${TEXT}"
    Pop $R9
    Pop $R8
  ${EndIf}
!macroend

!macro customPageAfterChangeDir
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW FrpInstFilesShow
  !define MUI_INSTFILESPAGE_FINISHHEADER_TEXT "安装完成"
  !define MUI_INSTFILESPAGE_FINISHHEADER_SUBTEXT "FRP 控制台 ${VERSION} 已准备就绪。"
  !define MUI_FINISHPAGE_TITLE "FRP 控制台安装完成"
  !define MUI_FINISHPAGE_TEXT "FRP 控制台 ${VERSION} 已成功安装到您的计算机。$\r$\n$\r$\n点击「完成」关闭安装向导。"
  !define MUI_FINISHPAGE_RUN_TEXT "立即启动 FRP 控制台"

  Function FrpInstFilesShow
    ${IfNot} ${Silent}
      Push $R8
      Push $R9
      Push $R7
      FindWindow $R8 "#32770" "" $HWNDPARENT
      GetDlgItem $R9 $R8 1004 ; msctls_progress32
      ${If} $R9 != 0
        ; 开启 PBS_MARQUEE (0x08)：Windows 原生连续滚动进度条，不会被 Nsis7z / NSIS 的 PBM_SETPOS 拉回倒退
        System::Call 'user32::GetWindowLong(p R9, i -16) i .R7'
        IntOp $R7 $R7 | 0x00000008
        System::Call 'user32::SetWindowLong(p R9, i -16, i R7)'
        SendMessage $R9 0x040A 1 35 ; PBM_SETMARQUEE: start, 35ms
      ${EndIf}
      GetDlgItem $R9 $R8 1006 ; 状态文案控件
      ${If} $R9 != 0
        SendMessage $R9 ${WM_SETTEXT} 0 "STR:正在准备安装 FRP 控制台，请稍候…"
      ${EndIf}
      Pop $R7
      Pop $R9
      Pop $R8
    ${EndIf}
  FunctionEnd
!macroend
!endif

; ---------------------------------------------------------------------------
; 覆盖 electron-builder 默认的“检测应用是否在运行”。
;
; 默认实现会向窗口发 WM_CLOSE 然后等进程退出。但本应用默认“关闭到托盘”
; （settings.closeToTray = true），收到 WM_CLOSE 只是隐藏窗口、进程不退，
; 于是安装器一直等到超时，报“FRP控制台无法关闭，请手动关闭”。
;
; 这里直接按进程名结束，并在安装器路径里顺带完成「升级前用户文件抢救 + 文件锁探测」
; （放在安装节执行而不是 .onInit，确保用户在安装目录页点「取消」时不会误杀正在运行的程序
; 或搬走任何文件）。
;
; ⚠ 绝对不能用 /T（结束子进程树）：应用内更新时，安装器本身是
;   electron-updater 用 spawn(detached) 从正在运行的应用里拉起来的**子进程**，
;   /T 会把安装器自己一起杀掉 —— 表现为「点重启并安装，窗口没了，版本没变，
;   没有任何提示」（退出码 1，安装目录一个字节都没动）。
;   隧道进程由应用自己在 prepareUpdateInstall / quitApp 里先停掉，
;   不需要安装器代劳；这里只负责结束控制台本体。
; ---------------------------------------------------------------------------
!macro customCheckAppRunning
  !ifndef BUILD_UNINSTALLER
    !insertmacro FrpSetStatus "正在关闭运行中的 FRP 控制台…"
  !endif

  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM "${APP_EXECUTABLE_FILENAME}"'
  Pop $0
  ; 双保险：隧道进程虽然应由应用在 prepareUpdateInstall / quitApp 里先停掉，
  ; 但如果停晚了或没停干净，它会锁住安装目录里的内置 frpc.exe，导致卸载旧
  ; 文件 Rename 失败、报 "Failed to uninstall old application files"。
  ; 这里再补一刀（同样不带 /T，frpc.exe 也不是安装器，不会误杀自己）。
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM "frpc.exe"'
  Pop $0
  Sleep 700

  ; ---- frpc.exe 可能被 Windows 服务（nssm 等）托管：taskkill 后秒级被拉活，
  ;      旧卸载器搬文件时它又锁着目录。taskkill 的退出码正好当探针用：
  ;      0 = 刚杀掉了 frpc（说明刚才还活着，服务可能会拉活它，再等一轮确认），
  ;      非 0 = 找不到 frpc 进程（已经死透了）。
  ;      循环里先请求停止常见托管服务再杀，最多 3 轮 × 1s。----
  StrCpy $R0 0
  frp_frpc_check_loop:
    IntOp $R0 $R0 + 1
    StrCmp $R0 4 frp_frpc_done 0
    nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM "frpc.exe"'
    Pop $0
    StrCmp $0 "0" 0 frp_frpc_done
    ; 刚才还有活的 frpc：停掉托管它的服务（不存在/没权限都会失败，忽略），再杀一刀
    nsExec::Exec '"$SYSDIR\sc.exe" stop nssmfrpc'
    Pop $0
    nsExec::Exec '"$SYSDIR\sc.exe" stop frpc'
    Pop $0
    Sleep 1000
    Goto frp_frpc_check_loop
  frp_frpc_done:

  ; -------------------------------------------------------------------------
  ; 升级前抢救用户放在旧安装目录里的文件 + 文件锁探测（仅安装器执行）
  ;
  ; electron-builder 的卸载旧版本流程是「把旧安装目录整体改名搬走 → RMDir /r
  ; → 解压新文件」（uninstaller.nsh 的 isUpdated 分支），所以安装目录里的任何
  ; 用户文件在升级时都会消失。这里在 uninstallOldVersion 之前把它们暂存到
  ; %LOCALAPPDATA%\frp-console\upgrade-rescue，装完后在 customInstall 里搬回 $INSTDIR。
  ; -------------------------------------------------------------------------
  !ifndef BUILD_UNINSTALLER
    StrCpy $FrpRescueDone "0"
    StrCpy $FrpRescueDir "$LOCALAPPDATA\frp-console\upgrade-rescue"

    ReadRegStr $FrpOldInstDir SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
    StrCmp $FrpOldInstDir "" 0 frp_old_dir_ready
      StrCpy $FrpOldInstDir "$INSTDIR"
    frp_old_dir_ready:

    ; 没装过旧版就跳过抢救与锁探测（全新安装无需等待重试）
    IfFileExists "$FrpOldInstDir\${APP_EXECUTABLE_FILENAME}" 0 frp_lock_end

    !insertmacro FrpSetStatus "正在备份已有配置与文件…"

    ; 上一次升级如果半路失败（解压中断、被杀、断电），用户文件还留在 upgrade-rescue
    ; 里、而旧安装目录是空的。这种时候先放回去，否则下面那句 RMDir 会把它删干净。
    IfFileExists "$FrpRescueDir\frpc.exe" 0 frp_rescue_prev_toml
      IfFileExists "$FrpOldInstDir\frpc.exe" frp_rescue_prev_toml
        CopyFiles /SILENT "$FrpRescueDir\frpc.exe" "$FrpOldInstDir"
    frp_rescue_prev_toml:
    IfFileExists "$FrpRescueDir\frpc.toml" 0 frp_rescue_wipe
      IfFileExists "$FrpOldInstDir\frpc.toml" frp_rescue_wipe
        CopyFiles /SILENT "$FrpRescueDir\frpc.toml" "$FrpOldInstDir"

    frp_rescue_wipe:
    RMDir /r "$FrpRescueDir"
    CreateDirectory "$FrpRescueDir"

    IfFileExists "$FrpOldInstDir\frpc.exe" 0 frp_rescue_toml
      StrCpy $FrpRescueDone "1"
      ClearErrors
      Rename "$FrpOldInstDir\frpc.exe" "$FrpRescueDir\frpc.exe"
      IfErrors 0 frp_rescue_toml
        CopyFiles /SILENT "$FrpOldInstDir\frpc.exe" "$FrpRescueDir"

    frp_rescue_toml:
    IfFileExists "$FrpOldInstDir\frpc.toml" 0 frp_rescue_bak
      StrCpy $FrpRescueDone "1"
      ClearErrors
      Rename "$FrpOldInstDir\frpc.toml" "$FrpRescueDir\frpc.toml"
      IfErrors 0 frp_rescue_bak
        CopyFiles /SILENT "$FrpOldInstDir\frpc.toml" "$FrpRescueDir"

    frp_rescue_bak:
    IfFileExists "$FrpOldInstDir\frp-console-backups\*.*" 0 frp_rescue_data
      StrCpy $FrpRescueDone "1"
      ClearErrors
      Rename "$FrpOldInstDir\frp-console-backups" "$FrpRescueDir\frp-console-backups"
      IfErrors 0 frp_rescue_data
        CreateDirectory "$FrpRescueDir\frp-console-backups"
        CopyFiles /SILENT "$FrpOldInstDir\frp-console-backups\*.*" "$FrpRescueDir\frp-console-backups"

    frp_rescue_data:
    IfFileExists "$FrpOldInstDir\frp-console-data\*.*" 0 frp_rescue_end
      StrCpy $FrpRescueDone "1"
      ClearErrors
      Rename "$FrpOldInstDir\frp-console-data" "$FrpRescueDir\frp-console-data"

    frp_rescue_end:

    ; 旧安装目录整个改一次名：任何一个文件被别的进程锁住（反作弊、杀软、
    ; 资源管理器的预览句柄都会锁 DLL），这次 Rename 都会失败——正好当探针。
    ; 3 次重试只是给正在退出的应用一点时间，避免误判。
    StrCpy $R1 "0"
    frp_lock_try:
      IntOp $R1 $R1 + 1
      StrCmp $R1 "4" frp_lock_locked 0
      ClearErrors
      Rename "$FrpOldInstDir" "$FrpOldInstDir.frp-lock-probe"
      IfErrors 0 frp_lock_free
        Sleep 600
        Goto frp_lock_try
    frp_lock_free:
      ClearErrors
      Rename "$FrpOldInstDir.frp-lock-probe" "$FrpOldInstDir"
      IfErrors 0 frp_lock_end
        ; 改不回去基本不可能（刚才能改名），但别卡死流程
        Goto frp_lock_end
    frp_lock_locked:
      DetailPrint "安装目录里有文件被其它程序占用，跳过旧版卸载，改为原地覆盖安装"
      ; 旧卸载器（1.2.162 及之前）搬文件用的是逐个 Rename，遇到被锁文件直接
      ; Abort，安装器随即报 “Failed to uninstall old application files.: 2”，
      ; 而且此时未锁的文件已经被搬走、安装目录等于被剥空。
      ; 摘掉旧卸载注册表键，让本次安装走「原地覆盖」：能写的文件全部换成新版，
      ; 被锁的那几个（几乎总是逐版不变的 Electron 运行时 DLL）保持原样。
      ; 新的卸载键在安装收尾时由安装器自己写回，不会丢。
      DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}"
      !ifdef UNINSTALL_REGISTRY_KEY_2
        DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY_2}"
      !endif
    frp_lock_end:

    !insertmacro FrpSetStatus "正在解压并安装程序文件，请稍候…"
  !endif
!macroend

; ---------------------------------------------------------------------------
; 卸载器自己的「删文件」也要能容忍被占用的文件（1.2.163 起新装的卸载器生效）。
;
; 模板默认行为（uninstaller.nsh）：
;   isUpdated（被新安装器调起来升级）时逐文件 Rename 到 $PLUGINSDIR\old-install，
;   任何一个文件被锁 → Abort → 升级整次失败，且未锁文件已经被搬走（剥空）。
;   正常卸载时 RMDir /r $INSTDIR，被锁文件删不掉就留着（“卸载不干净”）。
;
; 这里整体替换成：
;   isUpdated：搬不动的（被锁）就留在原地，让新安装器直接覆盖——升级不再失败；
;   正常卸载：RMDir 加 /REBOOTOK，被锁文件挂起到下次重启删除，不再留尾巴。
; ---------------------------------------------------------------------------
!macro customRemoveFiles
  ${if} ${isUpdated}
    CreateDirectory "$PLUGINSDIR\old-install"

    Push ""
    Call un.atomicRMDir
    Pop $R0

    ${if} $R0 != 0
      DetailPrint "有文件被其它程序占用（$R0），留在原地，安装器将直接覆盖"
      # 把刚才已经搬走的文件放回去，避免安装目录被剥空
      Push ""
      Call un.restoreFiles
      Pop $R0
    ${endif}
  ${endif}

  # Move out of $INSTDIR so it can be removed
  SetOutPath $TEMP
  # Remove all files (or remaining shallow directories from the block above)
  ${if} ${isUpdated}
    # 升级路径不能用 /REBOOTOK：重启时挂起的删除会把刚装进去的新文件删掉
    RMDir /r $INSTDIR
  ${else}
    # 正常卸载：被锁的文件挂起到重启删除，卸载本身不再“不干净”
    RMDir /r /REBOOTOK $INSTDIR
  ${endif}
!macroend

!macro customInstall
  !insertmacro FrpSetStatus "正在恢复配置并完成安装…"

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

  ; 停止滚动动画并把进度条置满 100%，随后自动进入「安装完成」页
  ${IfNot} ${Silent}
    Push $R8
    Push $R9
    Push $R7
    FindWindow $R8 "#32770" "" $HWNDPARENT
    GetDlgItem $R9 $R8 1004
    ${If} $R9 != 0
      SendMessage $R9 0x040A 0 0 ; PBM_SETMARQUEE: stop
      System::Call 'user32::GetWindowLong(p R9, i -16) i .R7'
      IntOp $R7 $R7 & 0xFFFFFFF7 ; 清除 PBS_MARQUEE
      System::Call 'user32::SetWindowLong(p R9, i -16, i R7)'
      SendMessage $R9 0x0406 0 100 ; PBM_SETRANGE32 (0..100)
      SendMessage $R9 0x0402 100 0 ; PBM_SETPOS (100)
    ${EndIf}
    Pop $R7
    Pop $R9
    Pop $R8
  ${EndIf}
  !insertmacro FrpSetStatus "安装完成。"
!macroend
