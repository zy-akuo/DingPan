@echo off
cd /d "%~dp0"
title DingPan Package Builder

echo.
echo ========================================
echo  DingPan one-click package
echo ========================================
echo  Output: packaging\out\
echo.
echo  Optional args:
echo    --skip-frontend   skip npm build
echo    --with-setup      also build Inno Setup exe
echo    --no-zip          skip zip, folder only
echo.
echo ========================================
echo.

set "EXTRA="
:parse
if "%~1"=="" goto run
if /I "%~1"=="--skip-frontend" set "EXTRA=%EXTRA% -SkipFrontend"
if /I "%~1"=="-SkipFrontend" set "EXTRA=%EXTRA% -SkipFrontend"
if /I "%~1"=="--with-setup" set "EXTRA=%EXTRA% -WithSetup"
if /I "%~1"=="-WithSetup" set "EXTRA=%EXTRA% -WithSetup"
if /I "%~1"=="--no-zip" set "EXTRA=%EXTRA% -NoZip"
if /I "%~1"=="-NoZip" set "EXTRA=%EXTRA% -NoZip"
shift
goto parse

:run
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0packaging\prepare-resources.ps1" -OpenFolder %EXTRA%
set ERR=%ERRORLEVEL%

echo.
if not "%ERR%"=="0" (
  echo [FAIL] package failed, exit code %ERR%
  pause
  exit /b %ERR%
)

echo [OK] send this zip to users:
echo      packaging\out\DingPan-portable.zip
echo.
pause
exit /b 0
