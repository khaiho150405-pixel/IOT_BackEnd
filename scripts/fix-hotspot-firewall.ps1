#Requires -RunAsAdministrator
param([string]$NodePath = '', [int]$Port = 3000)
$ErrorActionPreference = 'Stop'
if ($Port -lt 2 -or $Port -gt 65534) { throw 'Invalid port' }
if (!$NodePath) { $NodePath = (& node -e "console.log(require('node:fs').realpathSync.native(process.execPath))").Trim() }
if (!(Test-Path -LiteralPath $NodePath)) { throw 'Node executable not found' }
$NodePath = [IO.Path]::GetFullPath($NodePath)
# Fix only automatic TCP user-deny rules for this exact Node executable.
# Keep their block on every other TCP port and leave UDP rules untouched.
$rules = @(Get-NetFirewallRule -Enabled True -Direction Inbound -Action Block | Where-Object {
    $_.Name -like 'TCP Query User*' -and
    (($_ | Get-NetFirewallApplicationFilter).Program -ieq $NodePath)
})
foreach ($rule in $rules) {
    $filter = $rule | Get-NetFirewallPortFilter
    if ($filter.Protocol -eq 'TCP' -and $filter.LocalPort -eq 'Any') {
        $rule | Set-NetFirewallRule -LocalPort @("1-$($Port-1)", "$($Port+1)-65535")
        Write-Host "Excluded TCP $Port from Node block: $($rule.Name)"
    }
}
$name = 'AIoT-Hotspot-Node-TCP'
$existing = Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue
if ($existing) { $existing | Remove-NetFirewallRule }
New-NetFirewallRule -Name $name -DisplayName 'AIoT hotspot Node TCP' -Direction Inbound -Action Allow -Enabled True -Profile Any -Program $NodePath -Protocol TCP -LocalPort $Port -LocalAddress 192.168.137.1 -RemoteAddress 192.168.137.0/24 | Out-Null
Write-Host "Ready: Node TCP $Port allowed only from hotspot 192.168.137.0/24. Firewall remains enabled."
Write-Host 'Start backend, then open http://192.168.137.1:3000/health from phone.'
