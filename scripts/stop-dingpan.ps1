#Requires -Version 5.1
# Stop only processes attributed to this checkout or portable directory.
$ErrorActionPreference = "Stop"
$Root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)).TrimEnd('\') + '\'
$RootPattern = [regex]::Escape($Root)
$processes = @(Get-CimInstance Win32_Process)
$targets = New-Object 'System.Collections.Generic.HashSet[int]'
$ancestors = New-Object 'System.Collections.Generic.HashSet[int]'
$ancestorId = $PID
while ($ancestorId -gt 0 -and $ancestors.Add($ancestorId)) {
    $ancestor = $processes | Where-Object { $_.ProcessId -eq $ancestorId } | Select-Object -First 1
    if (-not $ancestor) { break }
    $ancestorId = [int]$ancestor.ParentProcessId
}
foreach ($process in $processes) {
    if ($ancestors.Contains([int]$process.ProcessId)) { continue }
    $command = [string]$process.CommandLine
    $executable = [string]$process.ExecutablePath
    $belongsHere = ($command -match $RootPattern) -or $executable.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase)
    $isService = ($process.Name -match '^(pythonw?|node)(\.exe)?$') -and
        ($command -match 'uvicorn|vite|launcher\.py|DingPan\.py')
    if ($belongsHere -and $isService) { [void]$targets.Add([int]$process.ProcessId) }
}
# Include reload workers, whose command line may omit the application name.
do {
    $added = $false
    foreach ($process in $processes) {
        if ($targets.Contains([int]$process.ParentProcessId) -and -not $ancestors.Contains([int]$process.ProcessId)) {
            if ($targets.Add([int]$process.ProcessId)) { $added = $true }
        }
    }
} while ($added)
foreach ($processId in $targets) {
    # Avoid terminating a recycled PID.
    $original = $processes | Where-Object { $_.ProcessId -eq $processId } | Select-Object -First 1
    $current = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
    if ($current -and $current.CreationDate -eq $original.CreationDate) {
        Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
        Write-Host "Stopped DingPan PID $processId"
    }
}
if ($targets.Count -eq 0) { Write-Host "No processes belonging to this DingPan directory found." }
