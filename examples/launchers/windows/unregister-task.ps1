<#
.SYNOPSIS
Stops and removes the Task Scheduler task created by register-task.ps1.

.DESCRIPTION
Stops the task, unregisters it, stops any worker process the task's wrapper started that
is still running, and deletes the generated wrapper. Config, state and logs are kept.

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

# Ending a task stops the wrapper; make sure the node.exe worker it started is gone too.
function Read-WrapperValue([string]$Content, [string]$Name) {
    $m = [regex]::Match($Content, '(?m)^\$' + $Name + " = '((?:[^']|'')*)'\s*$")
    if ($m.Success) { return $m.Groups[1].Value.Replace("''", "'") }
    return $null
}

if (Test-Path -LiteralPath $wrapperPath -PathType Leaf) {
    $content = [System.IO.File]::ReadAllText($wrapperPath)
    $cli = Read-WrapperValue $content 'cli'
    $config = Read-WrapperValue $content 'config'
    if ($cli -and $config) {
        $leftovers = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'node.exe'" |
            Where-Object {
                $_.CommandLine -and
                $_.CommandLine.IndexOf($cli, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
                $_.CommandLine.IndexOf($config, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
                $_.CommandLine -match '\sstart\s'
            })
        foreach ($p in $leftovers) {
            if ($PSCmdlet.ShouldProcess("node.exe pid $($p.ProcessId)", 'Stop leftover worker process')) {
                Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
                Write-Host "Stopped leftover worker process $($p.ProcessId)."
            }
        }
    }
    if (-not $KeepWrapper -and $PSCmdlet.ShouldProcess($wrapperPath, 'Delete generated wrapper')) {
        Remove-Item -LiteralPath $wrapperPath -Force
        Write-Host "Deleted $wrapperPath"
    }
}
