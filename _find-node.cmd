@echo off
chcp 65001 >nul 2>nul
rem ============================================================================
rem  _find-node.cmd - locate a usable node.exe (called by the other .cmd files)
rem ----------------------------------------------------------------------------
rem  WHY THIS EXISTS: WorkBuddy does NOT put its bundled Node on PATH - it exposes
rem  it via env vars (CODEBUDDY_NODE_BIN / WORKBUDDY_EXTRA_PATHS). So "where node"
rem  FAILS when this .cmd is double-clicked from Explorer on a clean machine.
rem  The backend also needs Node >= 22 (it uses the global WebSocket).
rem
rem  Probe order:
rem    1) CODEBUDDY_NODE_BIN            host-resolved absolute path
rem    2) WORKBUDDY_EXTRA_PATHS         ';'-separated dirs containing node.exe
rem    3) PATH
rem    4) %USERPROFILE%\.workbuddy\binaries\node\versions\current -> <ver>\node.exe
rem    5) any node.exe under versions\*
rem  Result is returned in NODE_EXE (empty = not found).
rem
rem  NOTE: this file is deliberately ASCII-only. cmd.exe parses a .cmd line by
rem  line using the active code page; non-ASCII text breaks that parsing and makes
rem  rem-comments get executed as commands ("not recognized as a command").
rem  All Chinese user-facing output comes from the Node scripts instead, which
rem  print UTF-8 correctly once the console code page is 65001 (set above).
rem ============================================================================
setlocal enabledelayedexpansion
set "NODE_EXE="

rem 1) host-resolved absolute path
if defined CODEBUDDY_NODE_BIN if exist "%CODEBUDDY_NODE_BIN%" set "NODE_EXE=%CODEBUDDY_NODE_BIN%"

rem 2) host-provided dir list (';'-separated)
if not defined NODE_EXE if defined WORKBUDDY_EXTRA_PATHS (
  for %%D in ("%WORKBUDDY_EXTRA_PATHS:;=" "%") do (
    if not defined NODE_EXE if exist "%%~D\node.exe" set "NODE_EXE=%%~D\node.exe"
  )
)

rem 3) PATH
if not defined NODE_EXE (
  for %%P in (node.exe) do if not "%%~$PATH:P"=="" set "NODE_EXE=%%~$PATH:P"
)

rem 4) WorkBuddy bundled-node version index (the only clue when double-clicked)
set "VROOT=%USERPROFILE%\.workbuddy\binaries\node\versions"
if not defined NODE_EXE if exist "%VROOT%\current" (
  set /p NV=<"%VROOT%\current"
  if exist "%VROOT%\!NV!\node.exe" set "NODE_EXE=%VROOT%\!NV!\node.exe"
)

rem 5) scan version dirs as a last resort
if not defined NODE_EXE if exist "%VROOT%" (
  for /d %%V in ("%VROOT%\*") do (
    if not defined NODE_EXE if exist "%%~V\node.exe" set "NODE_EXE=%%~V\node.exe"
  )
)

endlocal & set "NODE_EXE=%NODE_EXE%"
exit /b 0
