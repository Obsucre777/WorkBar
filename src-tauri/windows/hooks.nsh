; Capture this before hook macros are expanded in Tauri's generated script.
!define WORKBAR_HOOK_DIR "${__FILEDIR__}"
Var WorkbarPreviousInstallDir

!macro WorkbarUpdateUserPath Action
  Push $0
  Push $1
  InitPluginsDir
  ; Embed the helpers in both installer and uninstaller. They remain available
  ; after uninstalling the application and are cleaned up with $PLUGINSDIR.
  File "/oname=$PLUGINSDIR\workbar-path.ps1" "${WORKBAR_HOOK_DIR}\..\..\scripts\windows\manage-path.ps1"
  File "/oname=$PLUGINSDIR\path-helpers.ps1" "${WORKBAR_HOOK_DIR}\..\..\scripts\portable\path-helpers.ps1"
  nsExec::ExecToStack /TIMEOUT=30000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "$PLUGINSDIR\workbar-path.ps1" -Action ${Action} -InstallDirectory "$INSTDIR\." -PreviousInstallDirectory "$WorkbarPreviousInstallDir"'
  Pop $0
  Pop $1
  DetailPrint "$1"
  ${If} $0 != "0"
    DetailPrint "WorkBar PATH update failed: $0"
    MessageBox MB_ICONEXCLAMATION|MB_OK "WorkBar could not update your user PATH. Restart the installer to retry. Details: $1" /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
  Pop $1
  Pop $0
!macroend

!macro NSIS_HOOK_PREINSTALL
  ReadRegStr $WorkbarPreviousInstallDir SHCTX "${MANUPRODUCTKEY}" ""
  !insertmacro CheckIfAppIsRunning "$INSTDIR\workbar-mcp.exe" "WorkBar MCP"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro WorkbarUpdateUserPath Add
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro CheckIfAppIsRunning "$INSTDIR\workbar-mcp.exe" "WorkBar MCP"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Run only after uninstall actually completed, so cancelling leaves PATH intact.
  StrCpy $WorkbarPreviousInstallDir ""
  !insertmacro WorkbarUpdateUserPath Remove
!macroend
