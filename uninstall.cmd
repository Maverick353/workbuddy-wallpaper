@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 node，请先安装 Node.js 并确保已加入 PATH。
  pause
  exit /b 1
)
node "%~dp0scripts\install.js" --uninstall
echo.
pause
