<#
.SYNOPSIS
Registers a Task Scheduler task that runs `factory start` at logon for the current user.

.DESCRIPTION
The task runs under your own account with an interactive logon type, so no password is
stored and the worker sees the same credential context (gh, Git credential manager) as
your terminal sessions.

Task Scheduler cannot set environment variables or capture stdout, so this script writes a
small generated wrapper (launcher\<TaskName>.ps1 under the per-user data directory). The
wrapper sets PATH, starts node.exe with the installed package's dist\cli.js directly (not the
npm .cmd shim), and redirects stdout/stderr to launcher.out.log / launcher.err.log in the
per-user log directory. The worker also writes its own log there.

Task settings: restart on failure, ignore overlapping launches, no execution time limit,
start when available (a missed logon trigger runs as soon as possible).

Compatible with Windows PowerShell 5.1 and PowerShell 7. Run it from a normal (not
elevated) PowerShell window as the user who should run the worker.

.PARAMETER ConfigPath
Config file passed to `factory start --config`. Defaults to the per-user location
(%APPDATA%\software-factory\config.yaml, or <FactoryHome>\config.yaml).

.PARAMETER TaskName
Scheduled task name. Default: SoftwareFactory.

.PARAMETER NodePath
node.exe to run. Default: the node.exe found on PATH.

.PARAMETER CliPath
The installed package's dist\cli.js. Default: <npm root -g>\software-factory-cli\dist\cli.js,
then the dist\cli.js of the package this script ships in.

.PARAMETER WorkingDirectory
Working directory for the worker. Default: the config file's directory.

.PARAMETER ExtraPath
Additional directories to put on the worker's PATH (for example an agent CLI install dir).

.PARAMETER FactoryHome
Sets FACTORY_HOME for the worker. Default: the current FACTORY_HOME, if set.

.PARAMETER RestartCount
How many times Task Scheduler restarts a failed run. Default: 999 (the maximum).

.PARAMETER RestartIntervalMinutes
Delay between restarts. Default: 1 (the minimum).

.PARAMETER NoStart
Register without starting the task now.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\register-task.ps1

.EXAMPLE
.\register-task.ps1 -ConfigPath "D:\My Configs\factory.yaml" -TaskName "SoftwareFactory (pilot)" -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$ConfigPath,
    [string]$TaskName = 'SoftwareFactory',
    [string]$NodePath,
    [string]$CliPath,
    [string]$WorkingDirectory,
    [string[]]$ExtraPath = @(),
    [string]$FactoryHome = $env:FACTORY_HOME,
    [ValidateRange(1, 999)][int]$RestartCount = 999,
    [ValidateRange(1, 44640)][int]$RestartIntervalMinutes = 1,
    [switch]$NoStart
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$AppDir = 'software-factory'
$PackageName = 'software-factory-cli'

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
if ($FactoryHome) {
    $FactoryHome = Resolve-FullPath $FactoryHome
    $defaultConfigDir = $FactoryHome
    $dataDir = $FactoryHome
    $logDir = Join-Path $FactoryHome 'logs'
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
    Write-Warning "Config file not found: $ConfigPath. Run 'factory configure' (or pass -ConfigPath) before the task starts."
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
$factoryHomeLiteral = if ($FactoryHome) { ConvertTo-PsLiteral $FactoryHome } else { '$null' }

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
`$factoryHome = $factoryHomeLiteral
`$pidFilePath = $(ConvertTo-PsLiteral $pidFilePath)

trap {
    try {
        New-Item -ItemType Directory -Force -Path `$logDir | Out-Null
        Add-Content -LiteralPath (Join-Path `$logDir 'launcher.wrapper.log') -Value ('{0} {1}' -f (Get-Date -Format o), `$_)
    } catch { }
    exit 1
}

`$env:PATH = ((`$pathPrepend + @(`$env:PATH)) -join ';')
if (`$factoryHome) { `$env:FACTORY_HOME = `$factoryHome }
New-Item -ItemType Directory -Force -Path `$logDir | Out-Null

`$out = Join-Path `$logDir 'launcher.out.log'
`$err = Join-Path `$logDir 'launcher.err.log'
foreach (`$f in @(`$out, `$err)) {
    if (Test-Path -LiteralPath `$f) { Move-Item -LiteralPath `$f -Destination "`$f.prev" -Force }
}

# Start-Process joins arguments with spaces, so quote each one.
`$argList = @(`$cli, 'start', '--config', `$config) | ForEach-Object { '"' + `$_ + '"' }
`$proc = Start-Process -FilePath `$node -ArgumentList `$argList -WorkingDirectory `$workDir ``
    -NoNewWindow -PassThru -RedirectStandardOutput `$out -RedirectStandardError `$err
`$null = `$proc.Handle  # keep the handle so ExitCode is available after exit

# Record exactly which process this wrapper started, so unregister-task.ps1 can stop it
# without touching a manually started worker that uses the same CLI and config.
`$pidFile = `$pidFilePath
try {
    `$record = New-Object PSObject -Property @{
        pid = `$proc.Id
        startTimeUtcTicks = `$proc.StartTime.ToUniversalTime().Ticks
        node = `$proc.Path
    }
    [System.IO.File]::WriteAllText(`$pidFile, (`$record | ConvertTo-Json -Compress))
    `$proc.WaitForExit()
} finally {
    Remove-Item -LiteralPath `$pidFile -Force -ErrorAction SilentlyContinue
}
exit `$proc.ExitCode
"@

# --- Task definition ---------------------------------------------------------------------
$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$taskArgs = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$wrapperPath`""

$action = New-ScheduledTaskAction -Execute $powershellExe -Argument $taskArgs -WorkingDirectory $WorkingDirectory
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -RestartCount $RestartCount `
    -RestartInterval (New-TimeSpan -Minutes $RestartIntervalMinutes) `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries
$description = "software-factory worker: `"$NodePath`" `"$CliPath`" start --config `"$ConfigPath`""
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
if ($FactoryHome) { Write-Host "FACTORY_HOME:      $FactoryHome" }

if ($PSCmdlet.ShouldProcess($wrapperPath, 'Write launcher wrapper')) {
    New-Item -ItemType Directory -Force -Path $wrapperDir | Out-Null
    # ASCII-safe content; UTF-8 with BOM so Windows PowerShell 5.1 reads non-ASCII paths correctly.
    [System.IO.File]::WriteAllText($wrapperPath, $wrapper, (New-Object System.Text.UTF8Encoding($true)))
}

# Stopping a task ends its wrapper but can leave the node.exe worker it started running; that
# worker would hold the worker lock and make the re-registered task exit as "already running".
# Same logic as unregister-task.ps1: stop the recorded process only if its PID, start time and
# executable all still match, so a `factory start` run by hand is never touched.
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
