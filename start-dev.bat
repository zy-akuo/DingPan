@echo off
set ROOT=%~dp0
set PATH=C:\nvm4w\nodejs;%PATH%

echo [DingPan] Starting backend...
start "DingPan-Server" cmd /c "cd /d "%ROOT%apps\server" && "%ROOT%.venv\Scripts\python.exe" -m uvicorn app.main:app --host 127.0.0.1 --port 17831 --reload"

timeout /t 2 /nobreak >nul

echo [DingPan] Starting frontend...
start "DingPan-Web" cmd /c "cd /d "%ROOT%apps\web" && npm run dev"

timeout /t 3 /nobreak >nul
start "" http://127.0.0.1:5173/

echo Browser opened. Close the DingPan-* windows to stop.
pause