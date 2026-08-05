@echo off
setlocal
cd /d "%~dp0"
title Greenwave LAN

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-lan.ps1"
set "GREENWAVE_EXIT=%ERRORLEVEL%"

if not "%GREENWAVE_EXIT%"=="0" (
  echo.
  echo Greenwave could not start. Review the message above.
  pause
)

exit /b %GREENWAVE_EXIT%
