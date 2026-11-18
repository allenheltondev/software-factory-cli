<#
.SYNOPSIS
Stops and removes the Task Scheduler task created by register-task.ps1.

.DESCRIPTION
Disables and stops the task, stops the worker process the task's wrapper started if it is
still running, unregisters the task, and deletes the generated wrapper. Config, state and
logs are kept. The worker is matched by the recorded PID, start time and executable, or by
the marker the wrapper puts on its command line (--title=updraft-task:<TaskName>); a
`updraft start` you run by hand has neither and is never stopped.

.PARAMETER TaskName
Scheduled task name. Default: Updraft.

.PARAMETER UpdraftHome
The UPDRAFT_HOME used at registration, if any (locates the generated wrapper).

.PARAMETER KeepWrapper
Leave the generated wrapper script in place.

.EXAMPLE
.\unregister-task.ps1 -TaskName "Updraft (pilot)"
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$TaskName = 'Updraft',
    [string]$UpdraftHome = $env:UPDRAFT_HOME,
    [switch]$KeepWrapper
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
# Loaded up front, with -WhatIf off, so a -WhatIf run is not filled with the module's own alias
# setup. (Import-Module has no -WhatIf parameter of its own.)
$whatIf = $WhatIfPreference; $WhatIfPreference = $false
Import-Module CimCmdlets
$WhatIfPreference = $whatIf

if ($UpdraftHome) {
    $dataDir = [System.IO.Path]::GetFullPath($UpdraftHome)
} else {
    $localAppData = $env:LOCALAPPDATA
    if (-not $localAppData) { $localAppData = Join-Path $env:USERPROFILE 'AppData\Local' }
    $dataDir = Join-Path $localAppData 'updraft'
}
$safeName = $TaskName
foreach ($c in [System.IO.Path]::GetInvalidFileNameChars()) { $safeName = $safeName.Replace([string]$c, '_') }
$wrapperPath = Join-Path (Join-Path $dataDir 'launcher') "$safeName.ps1"
$pidFilePath = Join-Path (Join-Path $dataDir 'launcher') "$safeName.worker.json"
$workerMarker = "updraft-task:$safeName"

# Disable first, then stop: stopping the running wrapper leaves the repeating triggers armed, and
# a repeat before the task is gone would start a wrapper that adopts the worker and outlives this.
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
    if ($PSCmdlet.ShouldProcess($TaskName, 'Disable and stop scheduled task')) {
        Disable-ScheduledTask -TaskName $TaskName | Out-Null
        if ((Get-ScheduledTask -TaskName $TaskName).State -eq 'Running') { Stop-ScheduledTask -TaskName $TaskName }
    }
} else {
    Write-Host "No scheduled task named '$TaskName'."
}

# Ending a task stops the wrapper, which can leave the node.exe worker it started running.
# The wrapper records that worker's PID, start time and executable. Stop the process only if
# all three still match, so a `updraft start` you launched by hand (same CLI and config) or a
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

# A worker whose wrapper ended between starting it and writing its PID record has no record, but
# carries the task's marker on its command line (--title=<marker>). A `updraft start` run by hand
# never does.
function Stop-MarkedWorkers([string]$Marker, [string]$Why) {
    $needle = '"--title=' + $Marker + '"'
    $marked = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine.Contains($needle) })
    foreach ($m in $marked) {
        if ($PSCmdlet.ShouldProcess("node.exe pid $($m.ProcessId)", "Stop the worker $Why")) {
            Stop-Process -Id $m.ProcessId -Force -ErrorAction SilentlyContinue
            Write-Host "Stopped worker process $($m.ProcessId) started by $Why (found by its marker)."
        }
    }
}
Stop-MarkedWorkers $workerMarker 'the task'

# Removed only now that nothing of it is running.
if ($task -and $PSCmdlet.ShouldProcess($TaskName, 'Unregister scheduled task')) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Unregistered scheduled task '$TaskName'."
}

if (Test-Path -LiteralPath $wrapperPath -PathType Leaf) {
    if (-not $KeepWrapper -and $PSCmdlet.ShouldProcess($wrapperPath, 'Delete generated wrapper')) {
        Remove-Item -LiteralPath $wrapperPath -Force
        Write-Host "Deleted $wrapperPath"
    }
}
