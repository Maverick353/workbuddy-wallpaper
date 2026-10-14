@echo off
chcp 65001 >nul 2>nul
rem ============================================================================
rem  installer\build-installer.cmd - compile setup.iss into a .exe installer
rem
rem  Requires Inno Setup 6 on this machine. It is usually NOT on PATH; the
rem  default install location is %LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe.
rem  Get it from https://jrsoftware.org/isdl.php
rem  (GOTO flow + ASCII-only, same reasons as the .cmd files in the repo root.)
rem ============================================================================
setlocal
set "ISCC="

if exist "%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe" set "ISCC=%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe"
if not defined ISCC if exist "%ProgramFiles%\Inno Setup 6\ISCC.exe" set "ISCC=%ProgramFiles%\Inno Setup 6\ISCC.exe"
if not defined ISCC if exist "%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe" set "ISCC=%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe"
if not defined ISCC goto :no_iscc

echo   ISCC: %ISCC%
echo   Compiling setup.iss ...
"%ISCC%" "%~dp0setup.iss"
if errorlevel 1 goto :failed

echo.
echo   Done. The installer is in the repo's dist\ folder.
echo.
pause
exit /b 0

:no_iscc
echo.
echo   [ERROR] Inno Setup 6 (ISCC.exe) not found.
echo.
echo   The installer is plain-text (setup.iss) and needs the Inno Setup compiler:
echo     1) download: https://jrsoftware.org/isdl.php
echo     2) install it (default location is fine)
echo     3) run this script again
echo.
echo   Note: the .exe is only a nicer wrapper around the same files.
echo   The .cmd entry points (install.cmd / the start script) work without it.
echo.
pause
exit /b 1

:failed
echo.
echo   [ERROR] Compile failed - read the ISCC output above.
echo.
pause
exit /b 1
