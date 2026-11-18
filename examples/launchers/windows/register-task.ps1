<#
.SYNOPSIS
Registers a Task Scheduler task that runs `updraft start` at logon for the current user.

.DESCRIPTION
The task runs under your own account with an interactive logon type, so no password is
stored and the worker sees the same credential context (gh, Git credential manager) as
your terminal sessions.

Task Scheduler cannot set environment variables or capture stdout, so this script writes a
small generated wrapper (launcher\<TaskName>.ps1 under the per-user data directory). The
wrapper sets PATH, starts node.exe with the installed package's dist\cli.js directly (not the
npm .cmd shim), and redirects stdout/stderr to launcher.out.log / launcher.err.log in the
per-user log directory. The worker also writes its own log there.

The wrapper supervises the worker: after any exit other than a clean one (code 0), it starts
the worker again, waiting 5s after the first quick failure and doubling up to 5 min. Task
Scheduler's own "restart on failure" does not restart a task whose action exits non-zero, so
it cannot be relied on for that. If the wrapper itself is ended (Stop-ScheduledTask, its
console closing), the task's repeating trigger starts it again within RepeatIntervalMinutes,
and the new wrapper waits on the worker the old one started when that is still running.

Triggers: at logon, repeating every RepeatIntervalMinutes for as long as you are logged on;
unless -NoStart, also from now on at the same interval, so this session is covered without
logging off. Task settings: restart on failure, ignore overlapping launches (a repeat while
the wrapper runs does nothing), no execution time limit, start when available.

Compatible with Windows PowerShell 5.1 and PowerShell 7. Run it from a normal (not
elevated) PowerShell window as the user who should run the worker.

.PARAMETER ConfigPath
Config file passed to `updraft start --config`. Defaults to the per-user location
(%APPDATA%\updraft\config.yaml, or <UpdraftHome>\config.yaml).

.PARAMETER TaskName
Scheduled task name. Default: Updraft.

.PARAMETER NodePath
node.exe to run. Default: the node.exe found on PATH.

.PARAMETER CliPath
The installed package's dist\cli.js. Default: <npm root -g>\@allenheltondev\updraft\dist\cli.js,
then the dist\cli.js of the package this script ships in.

.PARAMETER WorkingDirectory
Working directory for the worker. Default: the config file's directory.

.PARAMETER ExtraPath
Additional directories to put on the worker's PATH (for example an agent CLI install dir).

.PARAMETER UpdraftHome
Sets UPDRAFT_HOME for the worker. Default: the current UPDRAFT_HOME, if set.

.PARAMETER RestartCount
How many times Task Scheduler restarts a failed run. Default: 999 (the maximum).

.PARAMETER RestartIntervalMinutes
Delay between restarts. Default: 1 (the minimum).

.PARAMETER RepeatIntervalMinutes
How often the task's triggers repeat, starting the wrapper again if it is not running.
Default: 5.

.PARAMETER MinBackoffSeconds
The wrapper's delay before restarting a worker that exited after a short run. Default: 5.

.PARAMETER MaxBackoffSeconds
The longest delay between restarts after repeated quick failures. Default: 300.

.PARAMETER NoStart
Register without starting the task now. The task then first runs at your next logon (and
repeats from there); this session gets no repeating trigger.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\register-task.ps1

.EXAMPLE
.\register-task.ps1 -ConfigPath "D:\My Configs\updraft.yaml" -TaskName "Updraft (pilot)" -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$ConfigPath,
    [string]$TaskName = 'Updraft',
    [string]$NodePath,
    [string]$CliPath,
    [string]$WorkingDirectory,
    [string[]]$ExtraPath = @(),
    [string]$UpdraftHome = $env:UPDRAFT_HOME,
    [ValidateRange(1, 999)][int]$RestartCount = 999,
    [ValidateRange(1, 44640)][int]$RestartIntervalMinutes = 1,
    [ValidateRange(1, 1440)][int]$RepeatIntervalMinutes = 5,
    [ValidateRange(1, 3600)][int]$MinBackoffSeconds = 5,
    [ValidateRange(1, 86400)][int]$MaxBackoffSeconds = 300,
    [switch]$NoStart
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$AppDir = 'updraft'
$PackageName = '@allenheltondev/updraft'

function Resolve-FullPath([string]$Path) {
    return [System.IO.Path]::GetFullPath($Path)
}

# Quote a value as a PowerShell single-quoted string literal.
function ConvertTo-PsLiteral([string]$Value) {
    if ($null -eq $Value) { return '$null' }
    return "'" + $Value.Replace("'", "''") + "'"
}

function Find-CommandDir([string]$Name) {
    $cmd = Get-Command -Name $Name -CommandType Application, ExternalScript -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($cmd) { return Split-Path -Parent $cmd.Source }
    return $null
}

# --- Per-user locations (mirrors src/paths.ts) -------------------------------------------
if ($UpdraftHome) {
    $UpdraftHome = Resolve-FullPath $UpdraftHome
    $defaultConfigDir = $UpdraftHome
    $dataDir = $UpdraftHome
    $logDir = Join-Path $UpdraftHome 'logs'
} else {
    $localAppData = $env:LOCALAPPDATA
    if (-not $localAppData) { $localAppData = Join-Path $env:USERPROFILE 'AppData\Local' }
    $roamingAppData = $env:APPDATA
    if (-not $roamingAppData) { $roamingAppData = Join-Path $env:USERPROFILE 'AppData\Roaming' }
    $defaultConfigDir = Join-Path $roamingAppData $AppDir
    $dataDir = Join-Path $localAppData $AppDir
    $logDir = Join-Path $dataDir 'logs'
}

if (-not $ConfigPath) { $ConfigPath = Join-Path $defaultConfigDir 'config.yaml' }
$ConfigPath = Resolve-FullPath $ConfigPath
if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    Write-Warning "Config file not found: $ConfigPath. Run 'updraft configure' (or pass -ConfigPath) before the task starts."
}

if (-not $WorkingDirectory) { $WorkingDirectory = Split-Path -Parent $ConfigPath }
$WorkingDirectory = Resolve-FullPath $WorkingDirectory

# --- node.exe and the installed cli.js ---------------------------------------------------
if (-not $NodePath) {
    $nodeCmd = Get-Command -Name node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $nodeCmd) { throw 'node.exe was not found on PATH. Install Node.js 22.13+ or pass -NodePath.' }
    $NodePath = $nodeCmd.Source
}
$NodePath = Resolve-FullPath $NodePath
if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw "node.exe not found: $NodePath" }

if (-not $CliPath) {
    $candidates = @()
    $npmCmd = Get-Command -Name npm.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($npmCmd) {
        $npmRoot = (& $npmCmd.Source root -g 2>$null | Select-Object -First 1)
        if ($npmRoot) { $candidates += (Join-Path $npmRoot "$PackageName\dist\cli.js") }
    }
    # This script ships in <package>\examples\launchers\windows.
    $candidates += (Join-Path $PSScriptRoot '..\..\..\dist\cli.js')
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $CliPath = $candidate; break }
    }
    if (-not $CliPath) {
        throw "Could not find $PackageName\dist\cli.js. Install the package (npm install -g $PackageName) or pass -CliPath."
    }
}
$CliPath = Resolve-FullPath $CliPath
if (-not (Test-Path -LiteralPath $CliPath -PathType Leaf)) { throw "cli.js not found: $CliPath" }

# --- PATH for the background process -----------------------------------------------------
# The task gets the PATH stored in the registry, not this session's PATH, so put the tools
# the worker and future agents need first.
$pathDirs = New-Object System.Collections.Generic.List[string]
function Add-PathDir([string]$Dir) {
    if (-not $Dir) { return }
    $full = (Resolve-FullPath $Dir).TrimEnd('\')
    foreach ($existing in $pathDirs) { if ($existing -ieq $full) { return } }
    $pathDirs.Add($full)
}
Add-PathDir (Split-Path -Parent $NodePath)
foreach ($tool in @('git', 'gh')) {
    $dir = Find-CommandDir $tool
    if ($dir) { Add-PathDir $dir } else { Write-Warning "$tool was not found on PATH; the worker needs it. Use -ExtraPath to add its directory." }
}
foreach ($agent in @('codex', 'claude', 'kiro-cli')) {
    $dir = Find-CommandDir $agent
    if ($dir) { Add-PathDir $dir } else { Write-Verbose "$agent not found on PATH (only needed when that agent is enabled)." }
}
foreach ($dir in $ExtraPath) { Add-PathDir $dir }

# --- Generated wrapper -------------------------------------------------------------------
$safeName = $TaskName
foreach ($c in [System.IO.Path]::GetInvalidFileNameChars()) { $safeName = $safeName.Replace([string]$c, '_') }
$wrapperDir = Join-Path $dataDir 'launcher'
$wrapperPath = Join-Path $wrapperDir "$safeName.ps1"
$pidFilePath = Join-Path $wrapperDir "$safeName.worker.json"

$pathLiterals = ($pathDirs | ForEach-Object { ConvertTo-PsLiteral $_ }) -join ', '
$updraftHomeLiteral = if ($UpdraftHome) { ConvertTo-PsLiteral $UpdraftHome } else { '$null' }

$wrapper = @"
# Generated by register-task.ps1 for scheduled task $(ConvertTo-PsLiteral $TaskName) on $(Get-Date -Format s).
# Re-run register-task.ps1 to change these values; edits here are overwritten.
`$ErrorActionPreference = 'Stop'
`$node = $(ConvertTo-PsLiteral $NodePath)
`$cli = $(ConvertTo-PsLiteral $CliPath)
`$config = $(ConvertTo-PsLiteral $ConfigPath)
`$workDir = $(ConvertTo-PsLiteral $WorkingDirectory)
`$logDir = $(ConvertTo-PsLiteral $logDir)
`$pathPrepend = @($pathLiterals)
`$updraftHome = $updraftHomeLiteral
`$pidFilePath = $(ConvertTo-PsLiteral $pidFilePath)
`$minBackoffSeconds = $MinBackoffSeconds
`$maxBackoffSeconds = $MaxBackoffSeconds
# A run at least this long counts as healthy: the next restart starts from the minimum delay again.
`$stableRunSeconds = 600

`$wrapperLog = Join-Path `$logDir 'launcher.wrapper.log'
function Write-WrapperLog([string]`$Message) {
    try {
        New-Item -ItemType Directory -Force -Path `$logDir | Out-Null
        Add-Content -LiteralPath `$wrapperLog -Value ('{0} {1}' -f (Get-Date -Format o), `$Message)
    } catch { }
}

trap {
    Write-WrapperLog ('wrapper error: {0}' -f `$_)
    exit 1
}

`$env:PATH = ((`$pathPrepend + @(`$env:PATH)) -join ';')
if (`$updraftHome) { `$env:UPDRAFT_HOME = `$updraftHome }
New-Item -ItemType Directory -Force -Path `$logDir | Out-Null

# The worker an earlier wrapper of this task started, if it is still running: same PID, start
# time and executable as recorded. A wrapper can end while its worker keeps running
# (Stop-ScheduledTask, or the wrapper's console closing), and starting a second worker then would
# only fail on the worker lock. This wrapper waits on that worker instead.
function Get-RecordedWorker {
    if (-not (Test-Path -LiteralPath `$pidFilePath -PathType Leaf)) { return `$null }
    try {
        `$record = [System.IO.File]::ReadAllText(`$pidFilePath) | ConvertFrom-Json
        `$p = Get-Process -Id ([int]`$record.pid) -ErrorAction Stop
        `$sameStart = [Math]::Abs(`$p.StartTime.ToUniversalTime().Ticks - [long]`$record.startTimeUtcTicks) -lt [TimeSpan]::TicksPerSecond
        `$sameExe = `$p.Path -and (`$p.Path -ieq [string]`$record.node)
        if (`$sameStart -and `$sameExe) { return `$p }
    } catch { }
    return `$null
}

# Rotate launcher.out.log / launcher.err.log to .prev. A file another process still holds open
# cannot be moved; this launch then writes to time-stamped files rather than failing to start.
function Get-LaunchLogs {
    `$out = Join-Path `$logDir 'launcher.out.log'
    `$err = Join-Path `$logDir 'launcher.err.log'
    try {
        foreach (`$f in @(`$out, `$err)) {
            if (Test-Path -LiteralPath `$f) { Move-Item -LiteralPath `$f -Destination "`$f.prev" -Force }
        }
        return @(`$out, `$err)
    } catch {
        `$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        Write-WrapperLog ('could not rotate the launcher logs ({0}); this launch writes launcher.out.{1}.log and launcher.err.{1}.log' -f `$_, `$stamp)
        return @((Join-Path `$logDir "launcher.out.`$stamp.log"), (Join-Path `$logDir "launcher.err.`$stamp.log"))
    }
}

# Supervise the worker. Task Scheduler's "restart on failure" does not restart a task whose action
# exits non-zero, so the wrapper restarts the worker itself after any exit except a clean one
# (code 0: the worker was asked to stop), waiting longer after each quick failure. The task's
# repeating trigger starts the wrapper again if the wrapper itself is ended.
`$backoff = `$minBackoffSeconds
while (`$true) {
    `$proc = Get-RecordedWorker
    `$adopted = `$null -ne `$proc
    if (`$adopted) {
        Write-WrapperLog ('worker process {0} from an earlier launch is still running; waiting on it' -f `$proc.Id)
    } else {
        `$logs = Get-LaunchLogs
        # Start-Process joins arguments with spaces, so quote each one. -WindowStyle Hidden (not
        # -NoNewWindow) gives node a console of its own, so a console control event that reaches
        # this wrapper's console (Ctrl+C, close) does not end the worker.
        `$argList = @(`$cli, 'start', '--config', `$config) | ForEach-Object { '"' + `$_ + '"' }
        `$proc = Start-Process -FilePath `$node -ArgumentList `$argList -WorkingDirectory `$workDir ``
            -WindowStyle Hidden -PassThru -RedirectStandardOutput `$logs[0] -RedirectStandardError `$logs[1]
        `$null = `$proc.Handle  # keep the handle so ExitCode is available after exit

        # Record exactly which process this wrapper started, so unregister-task.ps1 can stop it
        # without touching a manually started worker that uses the same CLI and config. Path can
        # still be empty right after the start; the file started is `$node in that case.
        `$exe = `$proc.Path
        if (-not `$exe) { `$exe = [System.IO.Path]::GetFullPath(`$node) }
        `$record = New-Object PSObject -Property @{
            pid = `$proc.Id
            startTimeUtcTicks = `$proc.StartTime.ToUniversalTime().Ticks
            node = `$exe
        }
        [System.IO.File]::WriteAllText(`$pidFilePath, (`$record | ConvertTo-Json -Compress))
    }

    `$started = Get-Date
    `$proc.WaitForExit()
    `$code = `$null
    if (-not `$adopted) { try { `$code = `$proc.ExitCode } catch { } }
    Remove-Item -LiteralPath `$pidFilePath -Force -ErrorAction SilentlyContinue
    if (`$code -eq 0) {
        Write-WrapperLog 'worker exited cleanly (code 0); not restarting it'
        exit 0
    }

    `$ran = [int]((Get-Date) - `$started).TotalSeconds
    if (`$ran -ge `$stableRunSeconds) { `$backoff = `$minBackoffSeconds }
    `$codeText = if (`$null -eq `$code) { 'unknown (not started by this wrapper)' } else { '{0} (0x{0:X8})' -f `$code }
    Write-WrapperLog ('worker exited with code {0} after {1}s; restarting it in {2}s' -f `$codeText, `$ran, `$backoff)
    Start-Sleep -Seconds `$backoff
    `$backoff = [Math]::Min(`$backoff * 2, `$maxBackoffSeconds)
}
"@

# --- Task definition ---------------------------------------------------------------------
$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$taskArgs = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$wrapperPath`""

$action = New-ScheduledTaskAction -Execute $powershellExe -Argument $taskArgs -WorkingDirectory $WorkingDirectory
# Repeat with no end (an empty Duration). New-ScheduledTaskTrigger -AtLogOn has no repetition
# parameters, so the pattern is copied from a -Once trigger built with one.
$repeatInterval = New-TimeSpan -Minutes $RepeatIntervalMinutes
$repeating = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval $repeatInterval
$repeating.Repetition.Duration = ''
# Never end a running wrapper because a repetition period ended.
$repeating.Repetition.StopAtDurationEnd = $false
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$logonTrigger.Repetition = $repeating.Repetition
$trigger = @($logonTrigger)
if (-not $NoStart) {
    # Covers this session too: the logon trigger's repetition only begins at the next logon.
    $trigger += $repeating
}
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -RestartCount $RestartCount `
    -RestartInterval (New-TimeSpan -Minutes $RestartIntervalMinutes) `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries
$description = "updraft worker: `"$NodePath`" `"$CliPath`" start --config `"$ConfigPath`""
$task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $description

Write-Host "Task name:         $TaskName"
Write-Host "Run as:            $userId (interactive logon, no stored password)"
Write-Host "node.exe:          $NodePath"
Write-Host "cli.js:            $CliPath"
Write-Host "Config:            $ConfigPath"
Write-Host "Working directory: $WorkingDirectory"
Write-Host "Wrapper:           $wrapperPath"
Write-Host "Logs:              $logDir"
Write-Host "PATH prepend:      $($pathDirs -join ';')"
if ($UpdraftHome) { Write-Host "UPDRAFT_HOME:      $UpdraftHome" }

if ($PSCmdlet.ShouldProcess($wrapperPath, 'Write launcher wrapper')) {
    New-Item -ItemType Directory -Force -Path $wrapperDir | Out-Null
    # ASCII-safe content; UTF-8 with BOM so Windows PowerShell 5.1 reads non-ASCII paths correctly.
    [System.IO.File]::WriteAllText($wrapperPath, $wrapper, (New-Object System.Text.UTF8Encoding($true)))
}

# Stopping a task ends its wrapper but can leave the node.exe worker it started running; that
# worker would hold the worker lock and make the re-registered task exit as "already running".
# Same logic as unregister-task.ps1: stop the recorded process only if its PID, start time and
# executable all still match, so a `updraft start` run by hand is never touched.
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
                Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
                Write-Host "Stopped worker process $($proc.Id) started by the previous registration."
            } else {
                Write-Host "PID $($record.pid) is no longer the worker this task started; leaving it alone."
            }
        }
    } else {
        Write-Warning "Could not read $PidFile; no worker process was stopped."
    }
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
}

if ($PSCmdlet.ShouldProcess($TaskName, 'Register scheduled task')) {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing -and $existing.State -eq 'Running') { Stop-ScheduledTask -TaskName $TaskName }
    # Also covers a worker orphaned earlier (task stopped by hand while node kept running).
    Stop-RecordedWorker $pidFilePath
    Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
    Write-Host "Registered scheduled task '$TaskName'."
    if (-not $NoStart) {
        Start-ScheduledTask -TaskName $TaskName
        Write-Host "Started. Check status with: Get-ScheduledTaskInfo -TaskName '$TaskName'"
    }
}
