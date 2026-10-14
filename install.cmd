@echo off
chcp 65001 >nul 2>nul
rem ============================================================================
rem  install.cmd - install workbuddy-wallpaper (just double-click me)
rem  flow: find node -> version check -> install as WorkBuddy skill -> autostart
rem        -> start the watchdog NOW (hidden, no need to wait for next login)
rem        -> check debug port 9222 -> offer one-click shortcut fix
rem
rem  Implementation note: this file deliberately avoids multi-line parenthesised
rem  IF blocks and uses GOTO flow instead. cmd.exe's handling of ")" inside such
rem  blocks is fragile (escaped parens inside echo text can abort the whole script
rem  with "was unexpected at this time"). GOTO flow has none of those failure
rem  modes. It is also ASCII-only on purpose - see the header of _find-node.cmd.
rem ============================================================================
setlocal
title workbuddy-wallpaper - install

call "%~dp0_find-node.cmd"
if not defined NODE_EXE goto :no_node

"%NODE_EXE%" -e "process.exit(process.versions.node.split('.')[0]>=22?0:1)" >nul 2>nul
if errorlevel 1 goto :old_node

echo.
echo   Node: %NODE_EXE%
echo.

"%NODE_EXE%" "%~dp0scripts\install.js" %*
set RC=%ERRORLEVEL%
if not "%RC%"=="0" goto :install_failed

rem --- start the watchdog RIGHT NOW, hidden, so it works without waiting for the
rem     next login. The startup-folder entry only fires at login, so without this
rem     the user installs, restarts WorkBuddy, and still sees nothing.
rem     Skipped when --no-autostart was passed (that means "don't run in background").
rem install.js 自己会在装完后于后台拉起看门狗（并遵守 --no-autostart），这里只负责回显。
set WDRUN=1
echo(%* | findstr /i "no-autostart" >nul 2>nul
if not errorlevel 1 set WDRUN=0

rem --- debug port check: offer the one-click shortcut fix when missing ---
"%NODE_EXE%" -e "const n=require('net');const s=n.connect(9222,'127.0.0.1');s.on('connect',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),1500)" >nul 2>nul
if not errorlevel 1 goto :port_ok

echo.
echo   ---------------------------------------------------------------
echo   WorkBuddy is NOT running with debug port 9222.
echo   Without it the wallpaper and panel cannot be injected at all -
echo   that is the classic "installed but nothing happens" case.
echo.
echo   I can patch your WorkBuddy shortcut to add the flag.
echo   shortcut file only; no running process is touched; backup is made.
echo   ---------------------------------------------------------------
echo.
set FIX=
set /p FIX="   Patch the shortcut now? [Y/n] "
if /i "%FIX%"=="n" goto :done
"%NODE_EXE%" "%~dp0scripts\fix-shortcut.js" --yes
echo.
echo   After patching: FULLY QUIT WorkBuddy (including the tray icon),
echo   then reopen it from that shortcut.
echo   Verify: node scripts\companion.js --status
echo           line 4 should read  CDP 9222: LISTENING
goto :done

:port_ok
echo.
echo   OK: debug port 9222 is listening - injection can work.
echo   The wallpaper should appear within a few seconds.
goto :done

:no_node
echo.
echo   [ERROR] No Node runtime found.
echo.
echo   This project needs Node 22 or newer. Two options:
echo     1) Open WorkBuddy once - it bundles Node, and this script looks there.
echo     2) Install Node yourself: https://nodejs.org/
echo.
echo   Chinese instructions: see README.md in this folder.
echo.
pause
exit /b 1

:old_node
echo.
echo   [ERROR] The Node found is too old - Node 22 or newer is required.
echo     path: %NODE_EXE%
echo   Open WorkBuddy once (it ships a new Node), or upgrade your Node install.
echo.
pause
exit /b 1

:install_failed
echo.
echo   [FAILED] install did not finish, exit code %RC%.
echo   Screenshot the output above - it says what went wrong.
echo.
pause
exit /b %RC%

:done
echo.
if "%WDRUN%"=="0" goto :done_norun
echo   Done. A background watchdog is now running - hidden window, nothing to keep open.
echo   It keeps the wallpaper service up while WorkBuddy is running, and comes back
echo   by itself after a reboot.
echo.
echo   Stop it  : panel - About - Close wallpaper
echo   Uninstall: double-click the uninstall .cmd in this folder
goto :done_end

:done_norun
echo   Done (autostart was skipped by --no-autostart, so nothing runs in the background).
echo   To start it by hand: double-click the "start" .cmd in this folder.
:done_end
echo.
pause
exit /b 0
