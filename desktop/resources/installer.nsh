; In-app updates wait for the original process to finish its normal shutdown.
; Otherwise NSIS's --updated path may force-close it while progress is saving.
!macro customInit
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "--brclio-update-parent=" $R1
  ${IfNot} ${Errors}
    System::Call 'kernel32::OpenProcess(i 0x00100000, i 0, i R1) p.R2 ?e'
    Pop $R3
    ${If} $R2 P<> 0
      System::Call 'kernel32::WaitForSingleObject(p R2, i 300000) i.R3'
      System::Call 'kernel32::CloseHandle(p R2)'
      ${If} $R3 != 0
        SetErrorLevel 2
        Abort
      ${EndIf}
    ${Else}
      ; ERROR_INVALID_PARAMETER means the original process already exited.
      ${If} $R3 != 87
        SetErrorLevel 2
        Abort
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ClearErrors
!macroend

; An update already received confirmation inside the app. Reuse its registered
; installation mode and show file-copy progress directly; fresh manual setup
; retains the normal destination and installation-mode choices.
!macro customInstallMode
  ${If} ${isUpdated}
    ${If} $hasPerMachineInstallation == "1"
    ${AndIf} $hasPerUserInstallation == "0"
      StrCpy $isForceMachineInstall "1"
    ${ElseIf} $hasPerMachineInstallation == "0"
      StrCpy $isForceCurrentInstall "1"
    ${EndIf}
  ${EndIf}
!macroend

; The finish page can also be shown after an aborted install. Record success
; only after NSIS has installed files, registration and shortcuts completely.
!macro customInstall
  StrCpy $BrclioInstallSucceeded "1"
!macroend

; Manual overwrite installs reopen immediately upon success, before the user
; presses Finish. In-app updates display NSIS's normal installation progress.
; Explicit silent invocations use NSIS's built-in --force-run path instead.
!macro customFinishPage
  Var /GLOBAL BrclioInstallSucceeded
  Function BrclioFinishPagePre
    IfAbort brclio_finish_done
    ${If} $BrclioInstallSucceeded == "1"
      StrCpy $BrclioInstallSucceeded "0"
      ${If} ${isUpdated}
        StrCpy $1 "--updated"
      ${Else}
        StrCpy $1 ""
      ${EndIf}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    ${EndIf}
    brclio_finish_done:
  FunctionEnd
  !define MUI_PAGE_CUSTOMFUNCTION_PRE BrclioFinishPagePre
  !insertmacro MUI_PAGE_FINISH
!macroend
