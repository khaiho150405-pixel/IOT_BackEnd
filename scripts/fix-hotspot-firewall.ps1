#Requires -RunAsAdministrator
# Opens the AIoT ports for devices on the Windows Mobile Hotspot (192.168.137.0/24) only:
#   TCP 3100 (ESP32 + HTTP), TCP 3443 (HTTPS dashboard), TCP 1883 (MQTT), UDP 5353 (mDNS aiot.local).
# Port 3000 is no longer AIoT's (another service uses it), so it is not opened here.
param([string]$NodePath = '', [int[]]$TcpPorts = @(3100, 3443, 1883), [int[]]$UdpPorts = @(5353))
$ErrorActionPreference = 'Stop'
foreach ($p in $TcpPorts + $UdpPorts) { if ($p -lt 2 -or $p -gt 65534) { throw "Invalid port $p" } }
if (!$NodePath) { $NodePath = (& node -e "console.log(require('node:fs').realpathSync.native(process.execPath))").Trim() }
if (!(Test-Path -LiteralPath $NodePath)) { throw 'Node executable not found' }
$NodePath = [IO.Path]::GetFullPath($NodePath)

# Port ranges covering 1-65535 except the given ports (Block rules override Allow rules).
function Get-ComplementRanges([int[]]$Ports) {
    $ranges = @(); $start = 1
    foreach ($p in ($Ports | Sort-Object -Unique)) {
        if ($p -gt $start) { $ranges += "$start-$($p - 1)" }
        $start = $p + 1
    }
    if ($start -le 65535) { $ranges += "$start-65535" }
    return $ranges
}

# Narrow only the automatic "Query User" block rules Windows created for this exact Node
# executable, so they keep blocking every port except the AIoT ones.
foreach ($protocol in @('TCP', 'UDP')) {
    $ports = if ($protocol -eq 'TCP') { $TcpPorts } else { $UdpPorts }
    if (!$ports) { continue }
    $rules = @(Get-NetFirewallRule -Enabled True -Direction Inbound -Action Block | Where-Object {
        $_.Name -like "$protocol Query User*" -and
        (($_ | Get-NetFirewallApplicationFilter).Program -ieq $NodePath)
    })
    foreach ($rule in $rules) {
        $filter = $rule | Get-NetFirewallPortFilter
        # 'Any' on first run; a list of ranges when an earlier run (other ports) already
        # narrowed the rule. Recompute it either way so a changed port list takes effect.
        $narrowedBefore = @($filter.LocalPort | Where-Object { $_ -match '^\d+-\d+$' }).Count -gt 0
        if ($filter.Protocol -eq $protocol -and ($filter.LocalPort -eq 'Any' -or $narrowedBefore)) {
            $rule | Set-NetFirewallRule -LocalPort (Get-ComplementRanges $ports)
            Write-Host "Excluded $protocol $($ports -join ', ') from Node block: $($rule.Name)"
        }
    }
}

$rulesToCreate = @(
    @{ Name = 'AIoT-Hotspot-Node-TCP'; Protocol = 'TCP'; Ports = $TcpPorts; LocalAddress = '192.168.137.1' },
    # mDNS queries are multicast (224.0.0.251), so the local address is not restricted.
    @{ Name = 'AIoT-Hotspot-Node-mDNS'; Protocol = 'UDP'; Ports = $UdpPorts; LocalAddress = 'Any' }
)
foreach ($r in $rulesToCreate) {
    $existing = Get-NetFirewallRule -Name $r.Name -ErrorAction SilentlyContinue
    if ($existing) { $existing | Remove-NetFirewallRule }
    if (!$r.Ports) { continue }
    New-NetFirewallRule -Name $r.Name -DisplayName ($r.Name -replace '-', ' ') -Direction Inbound -Action Allow -Enabled True `
        -Profile Any -Program $NodePath -Protocol $r.Protocol -LocalPort $r.Ports -LocalAddress $r.LocalAddress `
        -RemoteAddress 192.168.137.0/24 | Out-Null
    Write-Host "Allowed Node $($r.Protocol) $($r.Ports -join ', ') from hotspot 192.168.137.0/24."
}
Write-Host 'Firewall remains enabled. Start the backend, then open http://192.168.137.1:3100/trust on the phone.'
