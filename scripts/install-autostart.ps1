# Starts the AIoT system automatically when you log on to Windows.
# Registers a per-user scheduled task "AIoT Smart Room" (no administrator rights needed)
# that runs scripts\aiot-supervisor.ps1 hidden. Remove it with:  -Uninstall
param([switch]$Uninstall, [switch]$StartNow)
$ErrorActionPreference = 'Stop'
$taskName = 'AIoT Smart Room'
if ($Uninstall) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Removed the '$taskName' logon task. Running processes are not stopped."
    exit 0
}
$supervisor = Join-Path $PSScriptRoot 'aiot-supervisor.ps1'
if (!(Test-Path -LiteralPath $supervisor)) { throw "Missing $supervisor" }
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$supervisor`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
    -Principal $principal -Description 'AIoT Smart Room: backend + Cloudflare tunnel (scripts\aiot-supervisor.ps1)' -Force | Out-Null
Write-Host "Registered '$taskName': starts at logon for $user."
if ($StartNow) { Start-ScheduledTask -TaskName $taskName; Write-Host 'Started now.' }
Write-Host 'Logs and the public address: backend\logs (public-url.txt).'
