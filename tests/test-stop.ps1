# Test the stop script with a fake process inventory; no real process is terminated.
$ErrorActionPreference = "Stop"
$testRoot = (Split-Path -Parent $PSScriptRoot).TrimEnd('\') + '\'
$script:stopped = @()
$script:inventory = @(
    [pscustomobject]@{ ProcessId=$PID; ParentProcessId=0; Name='pwsh.exe'; CommandLine='test'; ExecutablePath=''; CreationDate=1 },
    [pscustomobject]@{ ProcessId=1700000001; ParentProcessId=0; Name='python.exe'; CommandLine='python -m uvicorn app.main:app'; ExecutablePath=($testRoot + '.venv\Scripts\python.exe'); CreationDate=1 },
    [pscustomobject]@{ ProcessId=1700000002; ParentProcessId=1700000001; Name='python.exe'; CommandLine='worker'; ExecutablePath=''; CreationDate=1 },
    [pscustomobject]@{ ProcessId=1700000003; ParentProcessId=0; Name='python.exe'; CommandLine='python -m uvicorn app.main:app --port 17831'; ExecutablePath='C:\OtherProject\python.exe'; CreationDate=1 },
    [pscustomobject]@{ ProcessId=1700000004; ParentProcessId=0; Name='node.exe'; CommandLine=('node "' + $testRoot + 'apps\web\node_modules\vite\bin\vite.js"'); ExecutablePath='C:\node\node.exe'; CreationDate=1 },
    [pscustomobject]@{ ProcessId=1700000005; ParentProcessId=0; Name='python.exe'; CommandLine='python unrelated.py'; ExecutablePath=($testRoot + '.venv\Scripts\python.exe'); CreationDate=1 }
)
function Get-CimInstance {
    param($ClassName, $Filter, $ErrorAction)
    if ($Filter) {
        $id = [int]($Filter -replace 'ProcessId=', '')
        return $script:inventory | Where-Object { $_.ProcessId -eq $id }
    }
    return $script:inventory
}
function Stop-Process {
    param($Id, [switch]$Force, $ErrorAction)
    $script:stopped += $Id
}
. (Join-Path $PSScriptRoot '..\scripts\stop-dingpan.ps1')
$actual = ($script:stopped | Sort-Object) -join ','
if ($actual -ne '1700000001,1700000002,1700000004') { throw "Unexpected stop targets: $actual" }
Write-Host 'Process ownership regression passed; unrelated processes preserved.'
