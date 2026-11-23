# Keeps the AIoT system running: backend (port 3100) and its own Cloudflare tunnel.
# Started at logon by scripts\install-autostart.ps1 (or run by hand). It
#   1. waits for Ollama (its own startup entry) so the backend can warm up Qwen,
#   2. starts the backend and restarts it whenever it exits,
#   3. starts the AIoT tunnel and restarts it whenever it exits:
#        - named tunnel if scripts\setup-named-tunnel.ps1 was run (fixed domain),
#        - otherwise a Quick Tunnel (random https://....trycloudflare.com address),
#   4. writes logs to backend\logs and the public address to backend\logs\public-url.txt.
# Only one supervisor runs at a time. It never touches other services (e.g. the
# "Cloudflared" Windows service of other projects or whatever listens on port 3000).
param(
    [int]$Port = 3100,
    [switch]$NoTunnel
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$backend = Join-Path $root 'backend'
$logs = Join-Path $backend 'logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$namedConfig = Join-Path $root 'backend\data\cloudflared\config.yml'

$mutex = New-Object Threading.Mutex($false, 'Local\AIoT-Smart-Room-Supervisor')
if (!$mutex.WaitOne(0)) { Write-Host 'AIoT supervisor is already running.'; exit 0 }

function Write-Log([string]$text) {
    $line = '{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $text
    Add-Content -Path (Join-Path $logs 'supervisor.log') -Value $line -Encoding utf8
    Write-Host $line
}
function Test-Port([int]$p) {
    $client = New-Object Net.Sockets.TcpClient
    try { $client.Connect('127.0.0.1', $p); return $true } catch { return $false } finally { $client.Dispose() }
}
function Find-Cloudflared {
    $command = Get-Command cloudflared -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $path = "${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe"
    if (Test-Path -LiteralPath $path) { return $path }
    return $null
}
function Start-Backend {
    $out = Join-Path $logs ('backend-{0:yyyyMMdd}.log' -f (Get-Date))
    $err = Join-Path $logs ('backend-{0:yyyyMMdd}.err.log' -f (Get-Date))
    $node = (Get-Command node).Source
    Write-Log "Starting backend: $node dist/src/main.js (port $Port)"
    $process = Start-Process -FilePath $node -ArgumentList 'dist/src/main.js' -WorkingDirectory $backend `
        -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden -PassThru
    $null = $process.Handle # keep the handle so ExitCode is available after it exits
    return $process
}
function Start-Tunnel([string]$exe) {
    $err = Join-Path $logs 'tunnel.log'
    if (Test-Path -LiteralPath $namedConfig) {
        Write-Log "Starting named AIoT tunnel ($namedConfig)"
        $arguments = @('tunnel', '--no-autoupdate', '--config', "`"$namedConfig`"", 'run')
    } else {
        Write-Log "Starting AIoT Quick Tunnel to http://localhost:$Port"
        $arguments = @('tunnel', '--no-autoupdate', '--metrics', '127.0.0.1:20251', '--url', "http://localhost:$Port")
    }
    $process = Start-Process -FilePath $exe -ArgumentList $arguments -RedirectStandardError $err `
        -RedirectStandardOutput (Join-Path $logs 'tunnel.out.log') -WindowStyle Hidden -PassThru
    $null = $process.Handle
    return $process
}
function Update-PublicUrl {
    $file = Join-Path $logs 'public-url.txt'
    if (Test-Path -LiteralPath $namedConfig) {
        $hostLine = Select-String -Path $namedConfig -Pattern '^\s*-\s*hostname:\s*(\S+)' | Select-Object -First 1
        if ($hostLine) { Set-Content -Path $file -Value ("https://" + $hostLine.Matches[0].Groups[1].Value) -Encoding ascii }
        return
    }
    $log = Join-Path $logs 'tunnel.log'
    if (!(Test-Path -LiteralPath $log)) { return }
    $match = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -Last 1
    if ($match) {
        $url = $match.Matches[0].Value
        $previous = if (Test-Path -LiteralPath $file) { (Get-Content -Path $file -Raw).Trim() } else { '' }
        if ($url -ne $previous) { Set-Content -Path $file -Value $url -Encoding ascii; Write-Log "Public address: $url" }
    }
}

Write-Log 'AIoT supervisor started.'
# 1. Ollama (started by its own startup entry); wait up to 90 s so Qwen can be warmed up.
for ($i = 0; $i -lt 45 -and !(Test-Port 11434); $i++) { Start-Sleep -Seconds 2 }
Write-Log ("Ollama " + $(if (Test-Port 11434) { 'ready' } else { 'not answering; backend starts anyway (rule-based fallback)' }))

$cloudflared = if ($NoTunnel) { $null } else { Find-Cloudflared }
if (!$NoTunnel -and !$cloudflared) { Write-Log 'cloudflared not found: Internet tunnel disabled.' }
$backendProc = $null; $tunnelProc = $null
$backendFailures = 0
while ($true) {
    # 2. Backend. If something else already answers on the port (e.g. a backend started by
    # hand), leave it alone and only take over once it is gone.
    if (!$backendProc -or $backendProc.HasExited) {
        if ($backendProc) {
            $backendFailures++
            Write-Log "Backend exited (code $($backendProc.ExitCode)); restart #$backendFailures"
            $backendProc = $null
            Start-Sleep -Seconds ([Math]::Min(60, 5 * $backendFailures))
        }
        if (Test-Port $Port) { Start-Sleep -Seconds 10; continue }
        $backendProc = Start-Backend
        $started = Get-Date
    } elseif ($backendFailures -and ((Get-Date) - $started).TotalMinutes -gt 10) {
        $backendFailures = 0 # stable again: next restart is quick
    }
    # 3. Tunnel, once the backend answers.
    if ($cloudflared -and (!$tunnelProc -or $tunnelProc.HasExited) -and (Test-Port $Port)) {
        if ($tunnelProc) { Write-Log "Tunnel exited (code $($tunnelProc.ExitCode)); restarting"; Start-Sleep -Seconds 5 }
        $tunnelProc = Start-Tunnel $cloudflared
    }
    if ($tunnelProc) { Update-PublicUrl }
    Start-Sleep -Seconds 5
}
