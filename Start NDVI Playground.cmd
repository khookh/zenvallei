@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-ndvi-playground.ps1"
if errorlevel 1 (
  echo.
  echo The NDVI playground could not be started. Review the message above.
  pause
)
endlocal
