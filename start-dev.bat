@echo off
setlocal EnableExtensions
set "ROOT=%~dp0"
set "PATH=C:\nvm4w\nodejs;%PATH%"
set "WEB_URL=http://127.0.0.1:5173/"
set "API_URL=http://127.0.0.1:17831/api/health"

echo [DingPan] Starting backend on 127.0.0.1:17831 ...
start "DingPan-Server" cmd /k "cd /d "%ROOT%apps\server" && "%ROOT%.venv\Scripts\python.exe" -m uvicorn app.main:app --host 127.0.0.1 --port 17831 --reload"

echo [DingPan] Waiting for backend...
set /a TRIES=0
:wait_api
set /a TRIES+=1
if %TRIES% GTR 40 (
  echo [FAIL] backend not ready: %API_URL%
  echo Check the DingPan-Server window for Python/uvicorn errors.
  pause
  exit /b 1
)
powershell -NoProfile -Command "try { $r=Invoke-WebRequest -UseBasicParsing -Uri '%API_URL%' -TimeoutSec 1; if ($r.StatusCode -ge 200) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
if errorlevel 1 (
  timeout /t 1 /nobreak >nul
  goto wait_api
)
echo [DingPan] Backend ready.

echo [DingPan] Starting frontend on 127.0.0.1:5173 ...
start "DingPan-Web" cmd /k "cd /d "%ROOT%apps\web" && npm run dev"

echo [DingPan] Waiting for frontend...
set /a TRIES=0
:wait_web
set /a TRIES+=1
if %TRIES% GTR 40 (
  echo [FAIL] frontend not ready: %WEB_URL%
  echo Check the DingPan-Web window for npm/vite errors.
  pause
  exit /b 1
)
powershell -NoProfile -Command "try { $r=Invoke-WebRequest -UseBasicParsing -Uri '%WEB_URL%' -TimeoutSec 1; if ($r.StatusCode -ge 200) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
if errorlevel 1 (
  timeout /t 1 /nobreak >nul
  goto wait_web
)

echo [DingPan] Frontend ready. Opening browser...
start "" "%WEB_URL%"
echo.
echo Browser opened: %WEB_URL%
echo Backend health: %API_URL%
echo Close the DingPan-Server / DingPan-Web windows to stop.
pause
endlocal
