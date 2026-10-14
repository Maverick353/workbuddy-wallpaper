@echo off
chcp 65001 >nul 2>nul
rem Alias for uninstall.cmd (this file has a friendlier Chinese file name).
rem Keep the real logic in uninstall.cmd so there is only one place to maintain.
call "%~dp0uninstall.cmd" %*
