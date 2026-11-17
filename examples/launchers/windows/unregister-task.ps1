<#
.SYNOPSIS
Stops and removes the Task Scheduler task created by register-task.ps1.

.DESCRIPTION
Stops the task, unregisters it, stops the worker process the task's wrapper started if it
is still running (matched by the recorded PID, start time and executable, never by command
line), and deletes the generated wrapper. Config, state and logs are kept.

.PARAMETER TaskName
Scheduled task name. Default: SoftwareFactory.

.PARAMETER FactoryHome
The FACTORY_HOME used at registration, if any (locates the generated wrapper).

.PARAMETER KeepWrapper
Leave the generated wrapper script in place.

.EXAMPLE
.\unregister-task.ps1 -TaskName "SoftwareFactory (pilot)"
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$TaskName = 'SoftwareFactory',
    [string]$FactoryHome = $env:FACTORY_HOME,
    [switch]$KeepWrapper
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

if ($FactoryHome) {
    $dataDir = [System.IO.Path]::GetFullPath($FactoryHome)
} else {
    $localAppData = $env:LOCALAPPDATA
    if (-not $localAppData) { $localAppData = Join-Path $env:USERPROFILE 'AppData\Local' }
    $dataDir = Join-Path $localAppData 'software-factory'
}
$safeName = $TaskName
foreach ($c in [System.IO.Path]::GetInvalidFileNameChars()) { $safeName = $safeName.Replace([string]$c, '_') }
$wrapperPath = Join-Path (Join-Path $dataDir 'launcher') "$safeName.ps1"
$pidFilePath = Join-Path (Join-Path $dataDir 'launcher') "$safeName.worker.json"

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
    if ($PSCmdlet.ShouldProcess($TaskName, 'Stop and unregister scheduled task')) {
        if ($task.State -eq 'Running') { Stop-ScheduledTask -TaskName $TaskName }
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Unregistered scheduled task '$TaskName'."
    }
} else {
    Write-Host "No scheduled task named '$TaskName'."
}

# Ending a task stops the wrapper, which can leave the node.exe worker it started running.
# The wrapper records that worker's PID, start time and executable. Stop the process only if
# all three still match, so a `factory start` you launched by hand (same CLI and config) or a
# process that reused the PID is never touched.
function Stop-RecordedWorker([string]$PidFile) {
    if (-not (Test-Path -LiteralPath $PidFile -PathType Leaf)) { return }
    $record = $null
    try { $record = [System.IO.File]::ReadAllText($PidFile) | ConvertFrom-Json } catch { }
    if ($record -and $record.pid -and $record.startTimeUtcTicks) {
        $proc = Get-Process -Id ([int]$record.pid) -ErrorAction SilentlyContinue
        if ($proc) {
            $actualTicks = $null
            try { $actualTicks = $proc.StartTime.ToUniversalTime().Ticks } catch { }
            $sameStart = $null -ne $actualTicks -and [Math]::Abs($actualTicks - [long]$record.startTimeUtcTicks) -lt [TimeSpan]::TicksPerSecond
            $sameExe = $proc.Path -and $record.node -and ($proc.Path -ieq [string]$record.node)
            if ($sameStart -and $sameExe) {
                if ($PSCmdlet.ShouldProcess("$($proc.ProcessName) pid $($proc.Id)", 'Stop the worker this task started')) {
                    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
                    Write-Host "Stopped worker process $($proc.Id) started by the task."
                }
            } else {
                Write-Host "PID $($record.pid) is no longer the worker this task started; leaving it alone."
            }
        }
    } else {
        Write-Warning "Could not read $PidFile; no worker process was stopped."
    }
    if ($PSCmdlet.ShouldProcess($PidFile, 'Delete worker PID record')) {
        Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
    }
}

Stop-RecordedWorker $pidFilePath

if (Test-Path -LiteralPath $wrapperPath -PathType Leaf) {
    if (-not $KeepWrapper -and $PSCmdlet.ShouldProcess($wrapperPath, 'Delete generated wrapper')) {
        Remove-Item -LiteralPath $wrapperPath -Force
        Write-Host "Deleted $wrapperPath"
    }
}
