@echo off
REM One-click install and start (ASCII-only bat for GBK CMD compatibility)
cd /d "%~dp0"
title DingPan Install and Start

echo.
echo ========================================
echo   DingPan - Install env and start
echo ========================================
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-and-run.ps1"
set ERR=%ERRORLEVEL%

echo.
if %ERR% neq 0 (
  echo [FAIL] Exit code %ERR%. Scroll up for details.
  echo Tips: check network, run as Admin once, or install Python 3.12 / Node 20 manually.
) else (
  echo [DONE] Browser should be open. You can close this window.
  echo        Backend/frontend keep running in minimized windows.
)
echo.
pause
exit /b %ERR%