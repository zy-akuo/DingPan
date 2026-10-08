@echo off
REM ASCII alias - calls stop script directly
cd /d "%~dp0"
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