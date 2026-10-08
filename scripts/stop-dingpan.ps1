#Requires -Version 5.1
<#
.SYNOPSIS
  Stop DingPan: free ports 17831/5173 and related python/node processes.
#>
$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ports = @(17831, 5173)
$killed = New-Object System.Collections.Generic.HashSet[int]

function Write-Step([string]$msg) {
    Write-Host "==> $msg" -ForegroundColor Cyan
}

function Stop-PidSafe([int]$ProcessId, [string]$reason) {
    if ($ProcessId -le 0) { return }
    if ($killed.Contains($ProcessId)) { return }
    try {
        $p = Get-Process -Id $ProcessId -ErrorAction Stop
        Write-Host ("    stop PID {0} ({1}) - {2}" -f $ProcessId, $p.ProcessName, $reason)
        Stop-Process -Id $ProcessId -Force -ErrorAction Stop
        [void]$killed.Add($ProcessId)
    } catch {
        # already exited
    }
}

function Stop-ByPort([int]$Port) {
    try {
        $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
        foreach ($c in $conns) {
            Stop-PidSafe -ProcessId ([int]$c.OwningProcess) -reason ("port $Port")
        }
    } catch { }
}

Write-Step "Close DingPan console windows"
try {
    # Window titles from start-dev.bat
    Get-Process cmd, powershell, pwsh -ErrorAction SilentlyContinue | ForEach-Object {
        $t = $_.MainWindowTitle
        if ($t -match "DingPan-Server|DingPan-Web|DingPan") {
            Stop-PidSafe -ProcessId $_.Id -reason ("window: $t")
        }
    }
} catch { }

Write-Step "Free ports 17831 / 5173"
foreach ($port in $ports) {
    Stop-ByPort $port
}

Write-Step "Scan DingPan-related python / node"
try {
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $cmd = [string]$_.CommandLine
            $name = [string]$_.Name
            if (-not $cmd) { return $false }
            $isPy = $name -match "python|uvicorn"
            $isNode = $name -match "node"
            $hit =
                ($cmd -match "DingPan\.py") -or
                ($cmd -match "apps\\server" -and $cmd -match "uvicorn") -or
                ($cmd -match "app\.main:app") -or
                ($cmd -match "apps\\web" -and $cmd -match "vite|npm") -or
                ($cmd -match "17831" -and $isPy)
            return $hit
        } |
        ForEach-Object {
            Stop-PidSafe -ProcessId ([int]$_.ProcessId) -reason ("cmdline match")
        }
} catch { }

Start-Sleep -Milliseconds 400

# second pass for ports (child processes)
foreach ($port in $ports) {
    Stop-ByPort $port
}

$still = @()
foreach ($port in $ports) {
    try {
        $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        if ($c) { $still += $port }
    } catch { }
}

Write-Host ""
if ($killed.Count -eq 0 -and $still.Count -eq 0) {
    Write-Host "No running DingPan service found." -ForegroundColor Yellow
} else {
    Write-Host ("Stopped {0} process(es)." -f $killed.Count) -ForegroundColor Green
}
if ($still.Count -gt 0) {
    Write-Host ("WARN: port still in use: {0}" -f ($still -join ", ")) -ForegroundColor Yellow
    exit 1
}
exit 0
