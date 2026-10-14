@echo off
chcp 65001 >nul 2>nul
rem Alias for install.cmd (this file has a friendlier Chinese file name).
rem Keep the real logic in install.cmd so there is only one place to maintain.
call "%~dp0install.cmd" %*
