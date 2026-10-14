@echo off
chcp 65001 >nul 2>nul
rem ============================================================================
rem  uninstall.cmd - remove workbuddy-wallpaper (double-click me)
rem  order matters: gracefully strip the page injection -> stop service ->
rem  stop watchdog -> remove autostart -> delete install dir -> ask about data
rem  (GOTO flow, no multi-line IF blocks - see install.cmd header for why.)
rem ============================================================================
setlocal
title workbuddy-wallpaper - uninstall

call "%~dp0_find-node.cmd"
if not defined NODE_EXE goto :no_node

"%NODE_EXE%" "%~dp0scripts\install.js" --uninstall
echo.
pause
exit /b 0

:no_node
echo.
echo   [ERROR] No Node runtime found, cannot uninstall automatically.
echo.
echo   Manual cleanup is only two steps:
echo     1) delete the folder  %%USERPROFILE%%\.workbuddy\skills\workbuddy-wallpaper
echo     2) delete  wallpaper-companion.vbs  from the Startup folder
echo        %%APPDATA%%\Microsoft\Windows\Start Menu\Programs\Startup
echo     3) optional, to wipe data too:  %%APPDATA%%\workbuddy-wallpaper
echo.
pause
exit /b 1
