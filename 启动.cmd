@echo off
chcp 65001 >nul 2>nul
rem ============================================================================
rem  Portable entry point (this file has a Chinese file name).
rem  Extract the zip and double-click this file; nothing is installed into the
rem  system. On first run it asks ONCE whether to register autostart.
rem  (GOTO flow, no multi-line IF blocks - see install.cmd header for why.)
rem ============================================================================
setlocal
title workbuddy-wallpaper - start

call "%~dp0_find-node.cmd"
if not defined NODE_EXE goto :no_node

if not exist "%APPDATA%\workbuddy-wallpaper" mkdir "%APPDATA%\workbuddy-wallpaper" >nul 2>nul
if exist "%APPDATA%\workbuddy-wallpaper\.asked-autostart" goto :launch

echo.
echo   Register autostart? Then the wallpaper appears by itself whenever
echo   WorkBuddy starts.
set AUTO=
set /p AUTO="   Register? [Y/n] "
if /i "%AUTO%"=="n" goto :mark_asked
"%NODE_EXE%" "%~dp0scripts\companion.js" --install-autostart

:mark_asked
>"%APPDATA%\workbuddy-wallpaper\.asked-autostart" echo asked

:launch
rem Already up? Then say so instead of printing "Starting" and popping a console.
netstat -ano | findstr "127.0.0.1:47851" | findstr LISTENING >nul 2>nul
if not errorlevel 1 goto :already_up

echo.
echo   ---------------------------------------------------------------
echo   Starting in the background (hidden window, nothing to keep open).
echo   Panel : click the rope mascot at the top of the WorkBuddy window
echo   Stop  : panel - About - Close wallpaper
echo   ---------------------------------------------------------------
echo.

"%NODE_EXE%" "%~dp0scripts\companion.js" --start-detached
echo.
echo   If the wallpaper does not show up: WorkBuddy is probably not running with
echo   the debug port. Check with  node scripts\companion.js --status
echo   line 4 should read  CDP 9222: LISTENING
goto :launch_end

:already_up
echo.
echo   Already running (port 47851 is listening) - nothing to do.
echo   Panel : click the rope mascot at the top of the WorkBuddy window
echo   Stop  : panel - About - Close wallpaper
:launch_end
echo.
pause
exit /b 0

:no_node
echo.
echo   [ERROR] No Node runtime found.
echo     Open WorkBuddy once (it bundles Node), or install Node: https://nodejs.org/
echo.
pause
exit /b 1
