# Assemble portable DingPan package: web static + embeddable Python + server
# Usage:
#   powershell -ExecutionPolicy Bypass -File packaging\prepare-resources.ps1
#   powershell -ExecutionPolicy Bypass -File packaging\prepare-resources.ps1 -WithSetup
#   powershell -ExecutionPolicy Bypass -File packaging\prepare-resources.ps1 -SkipFrontend
param(
    [string]$PythonVersion = "3.12.8",
    # Skip npm build when only backend / launcher / docs changed
    [switch]$SkipFrontend,
    # Compile Inno Setup installer if ISCC is available
    [switch]$WithSetup,
    # Do not create zip (faster local smoke-test of out\DingPan)
    [switch]$NoZip,
    # Open Explorer to output when finished
    [switch]$OpenFolder
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Out = Join-Path $PSScriptRoot "out\DingPan"
$PyDir = Join-Path $PSScriptRoot "python-runtime"
$WebDist = Join-Path $Root "apps\web\dist"
$ServerSrc = Join-Path $Root "apps\server"
$started = Get-Date

function Add-NodeToPath {
    $candidates = @(
        "C:\Program Files\nodejs",
        "C:\Program Files (x86)\nodejs",
        "C:\nvm4w\nodejs",
        "$env:APPDATA\nvm",
        "$env:LOCALAPPDATA\Programs\node"
    )
    foreach ($dir in $candidates) {
        if ($dir -and (Test-Path (Join-Path $dir "node.exe"))) {
            $env:Path = "$dir;" + $env:Path
            return
        }
    }
}

function Find-Iscc {
    $cmd = Get-Command iscc -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $candidates = @(
        "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
        "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
        "${env:ProgramFiles(x86)}\Inno Setup 5\ISCC.exe",
        "$env:ProgramFiles\Inno Setup 5\ISCC.exe"
    )
    foreach ($p in $candidates) {
        if (Test-Path $p) { return $p }
    }
    return $null
}

Write-Host ""
Write-Host "========================================"
Write-Host " DingPan one-click package"
Write-Host "========================================"
Write-Host " Root : $Root"
Write-Host ""

if (-not $SkipFrontend) {
    Write-Host "==> Build frontend"
    Add-NodeToPath
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        throw "node.exe not found. Install Node.js 18+ and retry."
    }
    Write-Host "    node: $($node.Source)"

    Push-Location (Join-Path $Root "apps\web")
    try {
        if (-not (Test-Path "node_modules")) {
            Write-Host "    npm install (first time)..."
            npm install
            if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
        }
        npm run build
        if ($LASTEXITCODE -ne 0) { throw "frontend build failed" }
    }
    finally {
        Pop-Location
    }
}
else {
    Write-Host "==> Skip frontend build (-SkipFrontend)"
}

if (-not (Test-Path $WebDist)) {
    throw "frontend dist missing: $WebDist (run without -SkipFrontend once)"
}

Write-Host "==> Prepare output folder"
Remove-Item -Recurse -Force $Out -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path (Join-Path $Out "resources\web") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $Out "resources\server") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $Out "resources\python") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $Out "docs") | Out-Null

Copy-Item -Recurse -Force (Join-Path $WebDist "*") (Join-Path $Out "resources\web")
Copy-Item -Recurse -Force (Join-Path $ServerSrc "app") (Join-Path $Out "resources\server\app")
Copy-Item -Force (Join-Path $ServerSrc "requirements.txt") (Join-Path $Out "resources\server\requirements.txt")
Copy-Item -Force (Join-Path $Root "apps\desktop\launcher.py") (Join-Path $Out "DingPan.py")
Copy-Item -Recurse -Force $WebDist (Join-Path $Out "resources\server\web_dist")

# docs for end users
Copy-Item -Force (Join-Path $Root "docs\使用手册.md") (Join-Path $Out "docs\使用手册.md")
Copy-Item -Force (Join-Path $Root "README.md") (Join-Path $Out "docs\README.md")

$pythonExe = Join-Path $PyDir "python.exe"
if (-not (Test-Path $pythonExe)) {
    Write-Host "==> Download embeddable Python $PythonVersion"
    New-Item -ItemType Directory -Force -Path $PyDir | Out-Null
    $zip = Join-Path $PyDir "python-embed.zip"
    $url = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip"
    Invoke-WebRequest -Uri $url -OutFile $zip
    Expand-Archive -Force $zip -DestinationPath $PyDir
    Remove-Item $zip

    $pth = Get-ChildItem $PyDir -Filter "python*._pth" | Select-Object -First 1
    if ($pth) {
        $lines = Get-Content $pth.FullName
        $newLines = @()
        foreach ($line in $lines) {
            if ($line -match "^#import site") {
                $newLines += "import site"
            } else {
                $newLines += $line
            }
        }
        if ($newLines -notcontains "Lib\site-packages") {
            $newLines += "Lib\site-packages"
        }
        Set-Content -Path $pth.FullName -Value $newLines -Encoding ASCII
    }

    Write-Host "==> Install pip and dependencies"
    $getPip = Join-Path $PyDir "get-pip.py"
    Invoke-WebRequest -Uri "https://bootstrap.pypa.io/get-pip.py" -OutFile $getPip
    & $pythonExe $getPip
    & $pythonExe -m pip install -r (Join-Path $ServerSrc "requirements.txt")
} else {
    Write-Host "==> Refresh Python deps in portable runtime"
    & $pythonExe -m pip install -r (Join-Path $ServerSrc "requirements.txt") --quiet
}

Write-Host "==> Copy portable Python"
Copy-Item -Recurse -Force (Join-Path $PyDir "*") (Join-Path $Out "resources\python")

$startBat = @"
@echo off
chcp 65001 >nul
title DingPan
cd /d "%~dp0"
set ROOT=%~dp0
set PYTHONHOME=
set PYTHONPATH=%ROOT%resources\server
echo.
echo [DingPan] starting...
echo If window does not open, install WebView2 Runtime.
echo.
"%ROOT%resources\python\python.exe" "%ROOT%DingPan.py"
if errorlevel 1 (
  echo.
  echo [ERROR] exit code %ERRORLEVEL%
  pause
)
"@
Set-Content -Path (Join-Path $Out "DingPan.bat") -Value $startBat -Encoding ASCII
Copy-Item -Force (Join-Path $Out "DingPan.bat") (Join-Path $Out "start.bat")
# User-facing Chinese launcher name
cmd /c "copy /Y `"$Out\DingPan.bat`" `"$Out\一键安装启动.bat`"" | Out-Null
if (-not (Test-Path (Join-Path $Out "一键安装启动.bat"))) {
    Copy-Item -Force (Join-Path $Out "DingPan.bat") (Join-Path $Out "YiJianQiDong.bat")
    Write-Host "Note: Chinese launcher name failed; use DingPan.bat or YiJianQiDong.bat"
}

$uninstallBat = @"
@echo off
chcp 65001 >nul
echo This will delete the DingPan app folder.
echo User data remains under %%APPDATA%%\DingPan (delete manually if needed).
pause
rmdir /s /q "%~dp0"
"@
Set-Content -Path (Join-Path $Out "Uninstall.bat") -Value $uninstallBat -Encoding ASCII

Copy-Item -Force (Join-Path $PSScriptRoot "使用说明.txt") (Join-Path $Out "使用说明.txt")

# stop helpers
$ScriptsDir = Join-Path $Out "scripts"
New-Item -ItemType Directory -Force -Path $ScriptsDir | Out-Null
$StopPs1Src = Join-Path $Root "scripts\stop-dingpan.ps1"
if (Test-Path $StopPs1Src) {
    Copy-Item -Force $StopPs1Src (Join-Path $ScriptsDir "stop-dingpan.ps1")
    $stopBat = @"
@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-dingpan.ps1"
pause
"@
    Set-Content -Path (Join-Path $Out "DingPan-Stop.bat") -Value $stopBat -Encoding ASCII
    cmd /c "copy /Y `"$Out\DingPan-Stop.bat`" `"$Out\停止钉盘.bat`"" | Out-Null
}

$ZipPath = Join-Path $PSScriptRoot "out\DingPan-portable.zip"
if (-not $NoZip) {
    Write-Host "==> Zip package"
    Remove-Item -Force $ZipPath -ErrorAction SilentlyContinue
    Compress-Archive -Path $Out -DestinationPath $ZipPath -Force
}
else {
    Write-Host "==> Skip zip (-NoZip)"
}

$SetupPath = $null
if ($WithSetup) {
    Write-Host "==> Compile Inno Setup installer"
    $iscc = Find-Iscc
    if (-not $iscc) {
        Write-Host "    [WARN] ISCC.exe not found. Install Inno Setup 6, or skip -WithSetup."
    }
    else {
        & $iscc (Join-Path $PSScriptRoot "DingPan.iss")
        if ($LASTEXITCODE -ne 0) { throw "Inno Setup compile failed" }
        $SetupPath = Get-ChildItem (Join-Path $PSScriptRoot "out") -Filter "DingPan-Setup-*.exe" |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 1 -ExpandProperty FullName
    }
}

$elapsed = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
Write-Host ""
Write-Host "========================================"
Write-Host " Done in ${elapsed}s"
Write-Host "========================================"
Write-Host "  Folder : $Out"
if (-not $NoZip -and (Test-Path $ZipPath)) {
    $sizeMB = [math]::Round((Get-Item $ZipPath).Length / 1MB, 1)
    Write-Host "  Zip    : $ZipPath  ($sizeMB MB)"
}
if ($SetupPath) {
    Write-Host "  Setup  : $SetupPath"
}
Write-Host "  Entry  : 一键安装启动.bat / DingPan.bat"
Write-Host ""
Write-Host "Tips:"
Write-Host "  - Backend-only change : add -SkipFrontend"
Write-Host "  - Also build Setup.exe: add -WithSetup (needs Inno Setup)"
Write-Host "  - Fast local folder    : add -NoZip"
Write-Host ""

if ($OpenFolder) {
    $openTarget = if (-not $NoZip -and (Test-Path $ZipPath)) { Split-Path $ZipPath } else { $Out }
    Start-Process explorer.exe $openTarget
}
