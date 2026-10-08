@echo off
REM Stop DingPan services (ASCII-only bat for GBK CMD compatibility)
cd /d "%~dp0"
title DingPan Stop

echo.
echo ========================================
echo   DingPan - Stop running services
echo ========================================
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-dingpan.ps1"
set ERR=%ERRORLEVEL%

echo.
if %ERR% neq 0 (
  echo [DONE] Stop attempted, exit code %ERR%
) else (
  echo [DONE] DingPan-related processes stopped.
)
echo.
pause
exit /b %ERR%