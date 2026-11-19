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
    $dataDir = Join-Path $env:USERPROFILE '.updraft'
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
# Open a process and hold it. While this handle is open, Windows cannot give the PID to another
# process, so everything done afterwards (wait, record, stop) goes through this same object and
# reaches the process that was matched. It is returned only if it started at $StartUtc, the start
# time recorded for it or the CreationDate of the CIM match. Both come from the kernel's creation
# time; CIM keeps whole microseconds, hence the tolerance of under 1 microsecond (10 ticks).
function Open-SameProcess([int]$Id, [datetime]$StartUtc) {
    try {
        $p = [System.Diagnostics.Process]::GetProcessById($Id)
        $null = $p.Handle
        if (-not $p.HasExited -and [Math]::Abs($p.StartTime.ToUniversalTime().Ticks - $StartUtc.Ticks) -lt 10) { return $p }
        $p.Dispose()
    } catch { }
    return $null
}

# Stop a process opened with Open-SameProcess, through its held handle.
function Stop-HeldProcess($p) {
    try { $p.Kill(); $null = $p.WaitForExit(10000) } catch { }  # it may have exited meanwhile
    $p.Dispose()
}

function Stop-RecordedWorker([string]$PidFile) {
    if (-not (Test-Path -LiteralPath $PidFile -PathType Leaf)) { return }
    $record = $null
    try { $record = [System.IO.File]::ReadAllText($PidFile) | ConvertFrom-Json } catch { }
    if ($record -and $record.pid -and $record.startTimeUtcTicks) {
        $proc = Open-SameProcess ([int]$record.pid) ([datetime]::new([long]$record.startTimeUtcTicks, 'Utc'))
        if ($proc -and $proc.Path -and $record.node -and ($proc.Path -ieq [string]$record.node)) {
            if ($PSCmdlet.ShouldProcess("$($proc.ProcessName) pid $($proc.Id)", 'Stop the worker this task started')) {
                $id = $proc.Id
                Stop-HeldProcess $proc
                Write-Host "Stopped worker process $id started by the task."
            } else {
                $proc.Dispose()
            }
        } else {
            if ($proc) { $proc.Dispose() }
            if (Get-Process -Id ([int]$record.pid) -ErrorAction SilentlyContinue) {
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
        if (-not $m.CreationDate) { continue }
        # Held and checked against the match's own start time before anything else, and stopped
        # through that handle: a worker that exited since the query (or during a -Confirm prompt)
        # cannot be confused with a process that got its PID.
        $p = Open-SameProcess ([int]$m.ProcessId) $m.CreationDate.ToUniversalTime()
        if (-not $p) { continue }
        if ($PSCmdlet.ShouldProcess("node.exe pid $($p.Id)", "Stop the worker $Why")) {
            $id = $p.Id
            Stop-HeldProcess $p
            Write-Host "Stopped worker process $id started by $Why (found by its marker)."
        } else {
            $p.Dispose()
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
