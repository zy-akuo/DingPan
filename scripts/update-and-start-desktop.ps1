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

function Get-NodeMajor([string]$NodeExe) {
    try {
        $raw = & $NodeExe -v 2>$null
        if (-not $raw) { return 0 }
        return [int]($raw.ToString().TrimStart("v").Split(".")[0])
    } catch {
        return 0
    }
}

function Resolve-NvmRoot {
    foreach ($cand in @(
            (Join-Path $env:APPDATA "nvm"),
            "D:\nvm\nvm",
            "C:\nvm4w",
            "C:\nvm"
        )) {
        if ($cand -and (Test-Path (Join-Path $cand "nvm.exe"))) { return $cand }
        if ($cand -and (Test-Path (Join-Path $cand "settings.txt"))) { return $cand }
    }
    $nvmCmd = Get-Command nvm -ErrorAction SilentlyContinue
    if ($nvmCmd -and $nvmCmd.Source) {
        $dir = Split-Path -Parent $nvmCmd.Source
        if (Test-Path $dir) { return $dir }
    }
    return $null
}

function Add-NodeToPath {
    # Vite 8 需要 Node >= 20；优先选够用的版本，避免 nvm 默认停在 14 导致「假成功」旧包
    $minMajor = 20
    $candidates = New-Object System.Collections.Generic.List[string]

    $nvmRoot = Resolve-NvmRoot
    if ($nvmRoot) {
        Get-ChildItem $nvmRoot -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match '^v?\d+\.\d+\.\d+$' } |
            Sort-Object {
                $n = $_.Name.TrimStart("v")
                try { [version]$n } catch { [version]"0.0.0" }
            } -Descending |
            ForEach-Object {
                $exe = Join-Path $_.FullName "node.exe"
                if (Test-Path $exe) { [void]$candidates.Add($exe) }
            }
    }

    foreach ($dir in @(
            (Join-Path $Root ".tools\nodejs"),
            (Join-Path $Root ".tools\node"),
            "C:\Program Files\nodejs",
            "C:\Program Files (x86)\nodejs",
            "C:\nvm4w\nodejs",
            "$env:LOCALAPPDATA\Programs\nodejs",
            "$env:LOCALAPPDATA\Programs\node"
        )) {
        $exe = Join-Path $dir "node.exe"
        if (Test-Path $exe) { [void]$candidates.Add($exe) }
    }

    $which = Get-Command node -ErrorAction SilentlyContinue
    if ($which -and $which.Source) { [void]$candidates.Add($which.Source) }

    $picked = $null
    foreach ($exe in $candidates) {
        if ((Get-NodeMajor $exe) -ge $minMajor) {
            $picked = $exe
            break
        }
    }
    if (-not $picked) {
        throw "需要 Node.js >= 20（当前过旧或未安装）。可用 nvm: nvm install 22 && nvm use 22"
    }
    $dir = Split-Path -Parent $picked
    $env:Path = "$dir;" + $env:Path
    Write-Host "    node: $picked ($(& $picked -v))"
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
    if (-not $node) { throw "node.exe not found. Install Node.js 20+." }
    $beforeStamp = 0.0
    if (Test-Path $WebDist) {
        Get-ChildItem $WebDist -Recurse -File -ErrorAction SilentlyContinue |
            ForEach-Object { if ($_.LastWriteTime.ToFileTimeUtc() -gt $beforeStamp) { $beforeStamp = $_.LastWriteTime.ToFileTimeUtc() } }
    }

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

    if (-not (Test-Path (Join-Path $WebDist "index.html"))) {
        throw "frontend build produced no dist/index.html (Node 是否过旧？需要 >= 20)"
    }
    $afterStamp = 0.0
    Get-ChildItem $WebDist -Recurse -File -ErrorAction SilentlyContinue |
        ForEach-Object { if ($_.LastWriteTime.ToFileTimeUtc() -gt $afterStamp) { $afterStamp = $_.LastWriteTime.ToFileTimeUtc() } }
    if ($afterStamp -le $beforeStamp) {
        throw "frontend dist 未更新（构建可能静默失败，请确认 Node >= 20）"
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
