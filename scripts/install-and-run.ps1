#Requires -Version 5.1
<#
.SYNOPSIS
  新机一键：检测/安装 Python + Node，安装依赖，启动后端与前端，并打开浏览器。
#>
param(
    [switch]$SkipInstallTools,
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8
try { chcp 65001 | Out-Null } catch { }
$Root = Split-Path -Parent $PSScriptRoot
$ToolsDir = Join-Path $Root ".tools"
$VenvPython = Join-Path $Root ".venv\Scripts\python.exe"
$WebDir = Join-Path $Root "apps\web"
$ServerDir = Join-Path $Root "apps\server"
$LogDir = Join-Path $Root ".logs"

function Write-Step([string]$msg) {
    Write-Host ""
    Write-Host "==> $msg" -ForegroundColor Cyan
}

function Write-Ok([string]$msg) {
    Write-Host "    OK  $msg" -ForegroundColor Green
}

function Write-Warn([string]$msg) {
    Write-Host "    !!  $msg" -ForegroundColor Yellow
}

function Refresh-Path {
    $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $user = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$ToolsDir\nodejs;$ToolsDir\python;$machine;$user"
    foreach ($extra in @(
            "$env:LOCALAPPDATA\Programs\Python\Python312",
            "$env:LOCALAPPDATA\Programs\Python\Python312\Scripts",
            "$env:LOCALAPPDATA\Programs\Python\Python311",
            "$env:LOCALAPPDATA\Programs\Python\Python311\Scripts",
            "C:\Program Files\nodejs",
            "$env:LOCALAPPDATA\Programs\nodejs",
            "C:\nvm4w\nodejs"
        )) {
        if (Test-Path $extra) {
            $env:Path = "$extra;$env:Path"
        }
    }
}

function Test-Command([string]$Name) {
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Get-PythonCmd {
    Refresh-Path
    if (Test-Path $VenvPython) { return $VenvPython }

    foreach ($c in @("py", "python", "python3")) {
        if (-not (Test-Command $c)) { continue }
        try {
            if ($c -eq "py") {
                $ver = & py -3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>$null
                if ($LASTEXITCODE -eq 0 -and $ver) {
                    $parts = $ver.Trim().Split(".")
                    if ([int]$parts[0] -gt 3 -or ([int]$parts[0] -eq 3 -and [int]$parts[1] -ge 11)) {
                        return "py -3"
                    }
                }
            } else {
                $ver = & $c -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>$null
                if ($LASTEXITCODE -eq 0 -and $ver) {
                    $parts = $ver.Trim().Split(".")
                    if ([int]$parts[0] -gt 3 -or ([int]$parts[0] -eq 3 -and [int]$parts[1] -ge 11)) {
                        return $c
                    }
                }
            }
        } catch { }
    }
    return $null
}

function Get-NodeOk {
    Refresh-Path
    if (-not (Test-Command "node")) { return $false }
    if (-not (Test-Command "npm")) { return $false }
    try {
        $maj = [int]((& node -v).TrimStart("v").Split(".")[0])
        return $maj -ge 18
    } catch {
        return $false
    }
}

function Install-WithWinget([string]$Id, [string]$DisplayName) {
    if (-not (Test-Command "winget")) {
        Write-Warn "未找到 winget，跳过安装 $DisplayName"
        return $false
    }
    Write-Step "通过 winget 安装 $DisplayName"
    $args = @(
        "install", "-e", "--id", $Id,
        "--accept-package-agreements", "--accept-source-agreements",
        "--disable-interactivity"
    )
    # 优先用户范围，失败再试默认
    & winget @args --scope user
    if ($LASTEXITCODE -eq 0) {
        Refresh-Path
        return $true
    }
    & winget @args
    Refresh-Path
    return ($LASTEXITCODE -eq 0)
}

function Install-PortableNode {
    Write-Step "下载便携 Node.js 20 LTS 到 .tools\nodejs"
    New-Item -ItemType Directory -Force -Path $ToolsDir | Out-Null
    $zip = Join-Path $ToolsDir "node.zip"
    $url = "https://nodejs.org/dist/v20.18.0/node-v20.18.0-win-x64.zip"
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    $extract = Join-Path $ToolsDir "node-extract"
    if (Test-Path $extract) { Remove-Item -Recurse -Force $extract }
    Expand-Archive -Force $zip -DestinationPath $extract
    $inner = Get-ChildItem $extract -Directory | Select-Object -First 1
    $dest = Join-Path $ToolsDir "nodejs"
    if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
    Move-Item $inner.FullName $dest
    Remove-Item -Force $zip -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $extract -ErrorAction SilentlyContinue
    Refresh-Path
    if (-not (Get-NodeOk)) { throw "便携 Node 安装失败" }
    Write-Ok "Node $((node -v))"
}

function Install-PortablePython {
    Write-Step "下载便携 Python 3.12 到 .tools\python"
    New-Item -ItemType Directory -Force -Path $ToolsDir | Out-Null
    $zip = Join-Path $ToolsDir "python-embed.zip"
    $dest = Join-Path $ToolsDir "python"
    $url = "https://www.python.org/ftp/python/3.12.8/python-3.12.8-embed-amd64.zip"
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    Expand-Archive -Force $zip -DestinationPath $dest
    Remove-Item -Force $zip

    $pth = Get-ChildItem $dest -Filter "python*._pth" | Select-Object -First 1
    if ($pth) {
        $lines = Get-Content $pth.FullName
        $new = @()
        foreach ($line in $lines) {
            if ($line -match "^#import site") { $new += "import site" }
            else { $new += $line }
        }
        if ($new -notcontains "Lib\site-packages") { $new += "Lib\site-packages" }
        Set-Content -Path $pth.FullName -Value $new -Encoding ASCII
    }

    $getPip = Join-Path $dest "get-pip.py"
    Invoke-WebRequest -Uri "https://bootstrap.pypa.io/get-pip.py" -OutFile $getPip -UseBasicParsing
    & (Join-Path $dest "python.exe") $getPip
    if ($LASTEXITCODE -ne 0) { throw "便携 Python 安装 pip 失败" }

    # venv 模块：embed 不含完整 ensurepip，用 virtualenv
    & (Join-Path $dest "python.exe") -m pip install "virtualenv>=20.0"
    Refresh-Path
    Write-Ok "便携 Python 就绪"
}

function Ensure-Python {
    $cmd = Get-PythonCmd
    if ($cmd) {
        Write-Ok "已检测到 Python ($cmd)"
        return $cmd
    }
    if ($SkipInstallTools) { throw "未找到 Python 3.11+，请先安装" }

    if (Install-WithWinget "Python.Python.3.12" "Python 3.12") {
        Start-Sleep -Seconds 2
        Refresh-Path
        $cmd = Get-PythonCmd
        if ($cmd) { return $cmd }
    }

    Install-PortablePython
    $cmd = Get-PythonCmd
    if (-not $cmd) {
        # 直接指向便携解释器
        $portable = Join-Path $ToolsDir "python\python.exe"
        if (Test-Path $portable) { return $portable }
        throw "无法安装 Python，请手动安装 Python 3.12 后重试"
    }
    return $cmd
}

function Ensure-Node {
    if (Get-NodeOk) {
        Write-Ok "已检测到 Node $((node -v)) / npm $((npm -v))"
        return
    }
    if ($SkipInstallTools) { throw "未找到 Node.js 18+，请先安装" }

    if (Install-WithWinget "OpenJS.NodeJS.LTS" "Node.js LTS") {
        Start-Sleep -Seconds 2
        Refresh-Path
        if (Get-NodeOk) {
            Write-Ok "Node $((node -v))"
            return
        }
    }

    Install-PortableNode
}

function Ensure-Venv([string]$PythonCmd) {
    Write-Step "创建 / 更新虚拟环境 .venv"
    if (-not (Test-Path $VenvPython)) {
        $portablePy = Join-Path $ToolsDir "python\python.exe"
        if ((Test-Path $portablePy) -and ($PythonCmd -eq $portablePy -or $PythonCmd -like "*\.tools\python\*")) {
            & $portablePy -m virtualenv (Join-Path $Root ".venv")
        } elseif ($PythonCmd -eq "py -3") {
            & py -3 -m venv (Join-Path $Root ".venv")
        } else {
            & $PythonCmd -m venv (Join-Path $Root ".venv")
        }
        if (-not (Test-Path $VenvPython)) { throw "创建 .venv 失败" }
    }
    Write-Ok $VenvPython

    Write-Step "安装 Python 依赖"
    & $VenvPython -m pip install --upgrade pip
    & $VenvPython -m pip install -r (Join-Path $ServerDir "requirements.txt")
    if ($LASTEXITCODE -ne 0) { throw "pip install 失败" }
    Write-Ok "requirements.txt 已安装"
}

function Ensure-NpmDeps {
    Write-Step "安装前端依赖 (npm install)"
    Push-Location $WebDir
    try {
        npm install
        if ($LASTEXITCODE -ne 0) { throw "npm install 失败" }
        Write-Ok "前端依赖就绪"
    } finally {
        Pop-Location
    }
}

function Test-PortOpen([int]$Port) {
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $c.Connect("127.0.0.1", $Port)
        $c.Close()
        return $true
    } catch {
        return $false
    }
}

function Wait-Http([string]$Url, [int]$TimeoutSec = 60) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
            if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500) { return $true }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Start-Services {
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
    $serverLog = Join-Path $LogDir "server.log"
    $webLog = Join-Path $LogDir "web.log"

    if (Test-PortOpen 17831) {
        Write-Warn "端口 17831 已被占用，将复用现有后端"
    } else {
        Write-Step "启动后端 http://127.0.0.1:17831"
        $serverCmd = @"
`$env:PYTHONPATH = '$ServerDir'
Set-Location '$ServerDir'
& '$VenvPython' -m uvicorn app.main:app --host 127.0.0.1 --port 17831 --reload *>> '$serverLog'
"@
        Start-Process -FilePath "powershell.exe" -ArgumentList @(
            "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $serverCmd
        ) -WindowStyle Minimized
    }

    if (Test-PortOpen 5173) {
        Write-Warn "端口 5173 已被占用，将复用现有前端"
    } else {
        Write-Step "启动前端 http://127.0.0.1:5173"
        $webCmd = @"
`$env:Path = '$ToolsDir\nodejs;' + `$env:Path
Set-Location '$WebDir'
npm run dev *>> '$webLog'
"@
        Start-Process -FilePath "powershell.exe" -ArgumentList @(
            "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $webCmd
        ) -WindowStyle Minimized
    }

    Write-Step "等待服务就绪"
    $apiOk = Wait-Http "http://127.0.0.1:17831/api/health" 90
    $webOk = Wait-Http "http://127.0.0.1:5173/" 90
    if (-not $apiOk) { Write-Warn "后端健康检查超时，请查看 .logs\server.log" }
    else { Write-Ok "后端已就绪" }
    if (-not $webOk) { Write-Warn "前端启动超时，请查看 .logs\web.log" }
    else { Write-Ok "前端已就绪" }

    if (-not $NoBrowser) {
        Write-Step "打开浏览器"
        Start-Process "http://127.0.0.1:5173/"
    }
}

# ---------- main ----------
Write-Host ""
Write-Host "========================================" -ForegroundColor Magenta
Write-Host "  DingPan - install deps and open browser" -ForegroundColor Magenta
Write-Host "========================================" -ForegroundColor Magenta
Write-Host "Project: $Root"

Refresh-Path
$py = Ensure-Python
Ensure-Node
Ensure-Venv $py
Ensure-NpmDeps
Start-Services

Write-Host ""
Write-Host "全部完成。" -ForegroundColor Green
Write-Host "  网页: http://127.0.0.1:5173/"
Write-Host "  API : http://127.0.0.1:17831/api/health"
Write-Host "  日志: $LogDir"
Write-Host "关闭对应的最小化 PowerShell 窗口即可停止服务。"
Write-Host ""
