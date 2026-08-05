@echo off
setlocal
cd /d "%~dp0"
title Greenwave LAN setup

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\configure-lan-firewall.ps1" -Action Install
set "GREENWAVE_EXIT=%ERRORLEVEL%"

echo.
if "%GREENWAVE_EXIT%"=="0" (
  echo LAN access is configured. You can now use Start Greenwave.cmd.
) else (
  echo LAN setup failed. Review the message above.
)
pause

exit /b %GREENWAVE_EXIT%
