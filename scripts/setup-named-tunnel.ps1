# Gives the AIoT backend a FIXED public address with its own named Cloudflare tunnel.
#   powershell -ExecutionPolicy Bypass -File scripts\setup-named-tunnel.ps1 -Hostname aiot.example.com
# - Creates a NEW tunnel "aiot-smart-room"; other tunnels, the "Cloudflared" Windows service
#   and their configuration are not touched.
# - Its credentials and config live in backend\data\cloudflared (git-ignored).
# - The DNS record is only created if the hostname is free: an existing record is never
#   overwritten (cloudflared refuses without --overwrite-dns, which is not used here).
# - The first run opens the browser to log in to Cloudflare and pick the domain (zone).
# Afterwards scripts\aiot-supervisor.ps1 runs this tunnel instead of the Quick Tunnel.
param(
    [Parameter(Mandatory = $true)][string]$Hostname,
    [string]$TunnelName = 'aiot-smart-room',
    [int]$Port = 3100
)
$ErrorActionPreference = 'Stop'
if ($Hostname -notmatch '^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$') { throw "Invalid hostname: $Hostname" }
$root = Split-Path -Parent $PSScriptRoot
$dir = Join-Path $root 'backend\data\cloudflared'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$command = Get-Command cloudflared -ErrorAction SilentlyContinue
$exe = if ($command) { $command.Source } else { "${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe" }
if (!(Test-Path -LiteralPath $exe)) { throw 'cloudflared not found' }

# 1. Account login (once): stores cert.pem in %USERPROFILE%\.cloudflared.
$cert = Join-Path $env:USERPROFILE '.cloudflared\cert.pem'
if (!(Test-Path -LiteralPath $cert)) {
    Write-Host 'Opening the browser: log in to Cloudflare and choose the domain for' $Hostname
    & $exe tunnel login
    if (!(Test-Path -LiteralPath $cert)) { throw 'Cloudflare login was not completed.' }
}

# 2. The AIoT tunnel (created once).
$credentials = Join-Path $dir "$TunnelName.json"
$existing = (& $exe tunnel list --output json | ConvertFrom-Json) | Where-Object { $_.name -eq $TunnelName } | Select-Object -First 1
if (!$existing) {
    & $exe tunnel create --credentials-file $credentials $TunnelName
    if ($LASTEXITCODE) { throw 'Creating the tunnel failed.' }
    $existing = (& $exe tunnel list --output json | ConvertFrom-Json) | Where-Object { $_.name -eq $TunnelName } | Select-Object -First 1
} elseif (!(Test-Path -LiteralPath $credentials)) {
    & $exe tunnel token --cred-file $credentials $TunnelName | Out-Null
    if ($LASTEXITCODE) { throw "Tunnel '$TunnelName' exists but its credentials could not be fetched." }
}
$id = $existing.id
Write-Host "Tunnel $TunnelName = $id"

# 3. DNS: CNAME <hostname> -> <id>.cfargotunnel.com, only if the name is not taken.
& $exe tunnel route dns $TunnelName $Hostname
if ($LASTEXITCODE) { throw "DNS for $Hostname was not created (already in use, or not in your Cloudflare zone). Nothing was overwritten." }

# 4. Config used by aiot-supervisor.ps1.
@"
tunnel: $id
credentials-file: $credentials
metrics: 127.0.0.1:20251
ingress:
  - hostname: $Hostname
    service: http://localhost:$Port
  - service: http_status:404
"@ | Set-Content -Path (Join-Path $dir 'config.yml') -Encoding ascii
Write-Host "Done. https://$Hostname -> http://localhost:$Port"
Write-Host 'Restart the supervisor (or log off/on) to switch from the Quick Tunnel to this address.'
