# Publishes the AIoT backend on the Internet through its OWN Cloudflare Quick Tunnel.
# - Separate cloudflared process: the "Cloudflared" Windows service (other projects, other
#   domains) and its configuration are not touched.
# - No Cloudflare account needed: Cloudflare assigns a random https://<words>.trycloudflare.com
#   address, printed below. It changes every time this script is started.
# - Only the backend's HTTP port is published (default 3100); Cloudflare provides HTTPS.
#   MQTT (1883) stays on the local network.
# Stop it with Ctrl+C (or close the window).
param(
    [int]$Port = 3100,
    [string]$Cloudflared = ''
)
$ErrorActionPreference = 'Stop'
if (!$Cloudflared) {
    $command = Get-Command cloudflared -ErrorAction SilentlyContinue
    $Cloudflared = if ($command) { $command.Source } else { "${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe" }
}
if (!(Test-Path -LiteralPath $Cloudflared)) { throw "cloudflared not found: install it or pass -Cloudflared <path>" }
$ready = $false
foreach ($attempt in 1..5) {
    # Plain TCP check: Invoke-WebRequest in Windows PowerShell may go through a system proxy.
    $client = New-Object Net.Sockets.TcpClient
    try { $client.Connect('127.0.0.1', $Port); $ready = $true; break }
    catch { Start-Sleep -Seconds 2 }
    finally { $client.Dispose() }
}
if (!$ready) { throw "AIoT backend is not answering on http://127.0.0.1:$Port - start it first" }

Write-Host "Starting a separate Quick Tunnel to http://localhost:$Port ..."
Write-Host 'Look for the line with https://....trycloudflare.com: that is the public address.'
# Its own metrics port, so it never clashes with the service's (127.0.0.1:20241).
& $Cloudflared tunnel --no-autoupdate --metrics 127.0.0.1:20251 --url "http://localhost:$Port"
