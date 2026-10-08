@echo off
REM Build frontend + sync web_dist + update pip + start desktop
REM Usage:
REM   start-desktop.bat
REM   start-desktop.bat --skip-build
REM   start-desktop.bat --skip-pip
REM   start-desktop.bat --skip-build --skip-pip
cd /d "%~dp0"
title DingPan Desktop

set "EXTRA="
:parse
if "%~1"=="" goto run
if /I "%~1"=="--skip-build" set "EXTRA=%EXTRA% -SkipBuild"
if /I "%~1"=="-SkipBuild" set "EXTRA=%EXTRA% -SkipBuild"
if /I "%~1"=="--skip-pip" set "EXTRA=%EXTRA% -SkipPip"
if /I "%~1"=="-SkipPip" set "EXTRA=%EXTRA% -SkipPip"
shift
goto parse

:run
echo.
echo ========================================
echo   DingPan - update and start desktop
echo ========================================
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\update-and-start-desktop.ps1" %EXTRA%
set ERR=%ERRORLEVEL%

echo.
if not "%ERR%"=="0" (
  echo [FAIL] exit code %ERR%
  pause
  exit /b %ERR%
)
exit /b 0