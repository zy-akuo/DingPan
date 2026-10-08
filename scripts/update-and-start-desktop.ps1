#Requires -Version 5.1
<#
.SYNOPSIS
  Build frontend, sync web_dist, refresh Python deps, then start desktop app.

.PARAMETER SkipBuild
  Skip npm build + web_dist sync (fast restart when UI unchanged).

.PARAMETER SkipPip
  Skip pip install -r requirements.txt.
#>
param(
    [switch]$SkipBuild,
    [switch]$SkipPip
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Root = Split-Path -Parent $PSScriptRoot
$WebDir = Join-Path $Root "apps\web"
$WebDist = Join-Path $WebDir "dist"
$ServerDir = Join-Path $Root "apps\server"
$ServerWebDist = Join-Path $ServerDir "web_dist"
$VenvPython = Join-Path $Root ".venv\Scripts\python.exe"
$Launcher = Join-Path $Root "apps\desktop\launcher.py"

function Write-Step([string]$msg) {
    Write-Host ""
    Write-Host "==> $msg" -ForegroundColor Cyan
}

function Write-Ok([string]$msg) {
    Write-Host "    OK  $msg" -ForegroundColor Green
}

function Add-NodeToPath {
    foreach ($dir in @(
            "C:\Program Files\nodejs",
            "C:\Program Files (x86)\nodejs",
            "C:\nvm4w\nodejs",
            "$env:APPDATA\nvm",
            "$env:LOCALAPPDATA\Programs\nodejs",
            "$env:LOCALAPPDATA\Programs\node"
        )) {
        if ($dir -and (Test-Path (Join-Path $dir "node.exe"))) {
            $env:Path = "$dir;" + $env:Path
            return
        }
    }
}

function Sync-WebDist {
    if (-not (Test-Path $WebDist)) {
        throw "frontend dist missing: $WebDist"
    }
    if (Test-Path $ServerWebDist) {
        Remove-Item -Recurse -Force $ServerWebDist
    }
    New-Item -ItemType Directory -Force -Path $ServerWebDist | Out-Null
    Copy-Item -Recurse -Force (Join-Path $WebDist "*") $ServerWebDist
    Write-Ok "synced -> apps\server\web_dist"
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Magenta
Write-Host "  DingPan - update and start desktop" -ForegroundColor Magenta
Write-Host "========================================" -ForegroundColor Magenta
Write-Host "Project: $Root"

if (-not (Test-Path $VenvPython)) {
    throw ".venv missing. Run 一键安装启动.bat first."
}
if (-not (Test-Path $Launcher)) {
    throw "launcher missing: $Launcher"
}

if (-not $SkipPip) {
    Write-Step "Update Python deps"
    & $VenvPython -m pip install -r (Join-Path $ServerDir "requirements.txt")
    if ($LASTEXITCODE -ne 0) { throw "pip install failed" }
    Write-Ok "requirements.txt"
}
else {
    Write-Step "Skip pip (-SkipPip)"
}

if (-not $SkipBuild) {
    Write-Step "Build frontend"
    Add-NodeToPath
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { throw "node.exe not found. Install Node.js 18+." }
    Write-Host "    node: $($node.Source)"

    Push-Location $WebDir
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
    Write-Ok "frontend built"

    Write-Step "Sync static files for desktop"
    Sync-WebDist
}
else {
    Write-Step "Skip frontend build (-SkipBuild)"
    if (-not (Test-Path (Join-Path $ServerWebDist "index.html"))) {
        if (Test-Path (Join-Path $WebDist "index.html")) {
            Write-Host "    web_dist empty, syncing existing dist..."
            Sync-WebDist
        }
        else {
            throw "apps\server\web_dist missing. Run once without -SkipBuild."
        }
    }
    else {
        Write-Ok "using existing apps\server\web_dist"
    }
}

Write-Step "Free port 17831 if occupied"
$stopScript = Join-Path $PSScriptRoot "stop-dingpan.ps1"
if (Test-Path $stopScript) {
    try {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $stopScript | Out-Host
    } catch {
        Write-Host "    warn: stop script failed, continue anyway" -ForegroundColor Yellow
    }
}

Write-Step "Start desktop (close window to exit)"
Write-Host "    UI from: apps\server\web_dist"
Write-Host "    API from: apps\server (live source)"
& $VenvPython $Launcher
exit $LASTEXITCODE
