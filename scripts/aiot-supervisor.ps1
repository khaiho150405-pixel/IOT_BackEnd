# Runs and watches the AIoT system: backend (port 3100) and its own Cloudflare tunnel.
# Started by Khoi-dong-AIoT.bat (double-click) and stopped by Tat-AIoT.bat, Ctrl+C or closing
# its window. It
#   1. waits for Ollama, starting the Ollama app if needed, so the backend can warm up Qwen,
#   2. starts the backend and restarts it whenever it exits,
#   3. starts the AIoT tunnel and restarts it whenever it exits:
#        - named tunnel if scripts\setup-named-tunnel.ps1 was run (fixed domain),
#        - otherwise a Quick Tunnel (random https://....trycloudflare.com address),
#   4. writes logs to backend\logs, the public address to backend\logs\public-url.txt and the
#      process ids it owns to backend\logs\aiot.pids (used by scripts\stop-aiot.ps1).
# Only one supervisor runs at a time. It only stops processes it started itself, never other
# services (e.g. the "Cloudflared" Windows service of other projects or whatever uses port 3000).
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
$pidFile = Join-Path $logs 'aiot.pids'

$mutex = New-Object Threading.Mutex($false, 'Local\AIoT-Smart-Room-Supervisor')
if (!$mutex.WaitOne(0)) { Write-Host 'He thong AIoT dang chay roi (chi duoc mo mot cua so).'; exit 0 }

# Job object: the backend, its voice bridge and the tunnel are tied to this supervisor, so Windows
# stops them as soon as it ends in any way (window closed, process killed), not only on Ctrl+C.
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class AiotJob {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
    [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [StructLayout(LayoutKind.Sequential)] struct Basic { public long UserTime; public long JobUserTime; public uint LimitFlags; public UIntPtr MinWs; public UIntPtr MaxWs; public uint ActiveLimit; public UIntPtr Affinity; public uint Priority; public uint Scheduling; }
    [StructLayout(LayoutKind.Sequential)] struct Io { public ulong A, B, C, D, E, F; }
    [StructLayout(LayoutKind.Sequential)] struct Extended { public Basic BasicInfo; public Io IoInfo; public UIntPtr M1, M2, M3, M4; }
    static IntPtr job = IntPtr.Zero;
    public static bool Add(IntPtr process) {
        if (job == IntPtr.Zero) {
            job = CreateJobObject(IntPtr.Zero, null);
            Extended info = new Extended();
            info.BasicInfo.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            int length = Marshal.SizeOf(typeof(Extended));
            IntPtr buffer = Marshal.AllocHGlobal(length);
            Marshal.StructureToPtr(info, buffer, false);
            SetInformationJobObject(job, 9, buffer, (uint)length);
            Marshal.FreeHGlobal(buffer);
        }
        return AssignProcessToJobObject(job, process);
    }
}
'@

function Write-Log([string]$text) {
    $line = '{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $text
    Add-Content -Path (Join-Path $logs 'supervisor.log') -Value $line -Encoding utf8
    Write-Host $line
}
function Test-Port([int]$p) {
    # Bounded to 500 ms: on Windows a refused connection can otherwise take about 2 s.
    $client = New-Object Net.Sockets.TcpClient
    try { $task = $client.ConnectAsync('127.0.0.1', $p); return ($task.Wait(500) -and $client.Connected) }
    catch { return $false } finally { $client.Dispose() }
}
function Find-Cloudflared {
    $command = Get-Command cloudflared -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $path = "${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe"
    if (Test-Path -LiteralPath $path) { return $path }
    return $null
}
# Processes owned by this run: supervisor, backend, its voice bridge (a child of the backend), tunnel.
function Save-Pids {
    $lines = @("supervisor $PID powershell")
    if ($backendProc -and !$backendProc.HasExited) {
        $lines += "backend $($backendProc.Id) node"
        Get-CimInstance Win32_Process -Filter "ParentProcessId=$($backendProc.Id)" -ErrorAction SilentlyContinue |
            ForEach-Object { $lines += "child $($_.ProcessId) $($_.Name -replace '\.exe$', '')" }
    }
    if ($tunnelProc -and !$tunnelProc.HasExited) { $lines += "tunnel $($tunnelProc.Id) cloudflared" }
    Set-Content -Path $pidFile -Value $lines -Encoding ascii
}
# Stops the processes a previous run recorded (left behind if its window was killed), checking
# the name so a recycled process id is never stopped by mistake.
function Stop-Recorded([switch]$IncludeSupervisor) {
    if (!(Test-Path -LiteralPath $pidFile)) { return }
    foreach ($line in Get-Content -Path $pidFile) {
        $role, $id, $name = $line -split ' '
        if (!$id -or ($role -eq 'supervisor' -and !$IncludeSupervisor) -or [int]$id -eq $PID) { continue }
        $process = Get-Process -Id ([int]$id) -ErrorAction SilentlyContinue
        if ($process -and $process.ProcessName -eq $name) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
            Write-Log "Stopped $role ($name, pid $id)"
        }
    }
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}
function Start-Backend {
    # One file per start: Start-Process overwrites, so a restart must not erase the previous run's log.
    $stamp = '{0:yyyyMMdd-HHmmss}' -f (Get-Date)
    $out = Join-Path $logs "backend-$stamp.log"
    $err = Join-Path $logs "backend-$stamp.err.log"
    $node = (Get-Command node).Source
    Write-Log "Starting backend: $node dist/src/main.js (port $Port)"
    $process = Start-Process -FilePath $node -ArgumentList 'dist/src/main.js' -WorkingDirectory $backend `
        -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden -PassThru
    $null = $process.Handle # keep the handle so ExitCode is available after it exits
    if (![AiotJob]::Add($process.Handle)) { Write-Log 'Warning: backend not tied to the supervisor (job object).' }
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
    if (![AiotJob]::Add($process.Handle)) { Write-Log 'Warning: tunnel not tied to the supervisor (job object).' }
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
Stop-Recorded # leftovers of a run whose window was killed
# 1. Ollama: if it is not running after 10 s the Ollama app is started here. Wait at most 90 s
# in total so Qwen can be warmed up.
$ollamaWait = [Diagnostics.Stopwatch]::StartNew()
$ollamaLaunched = $false
while (!(Test-Port 11434) -and $ollamaWait.Elapsed.TotalSeconds -lt 90) {
    if (!$ollamaLaunched -and $ollamaWait.Elapsed.TotalSeconds -ge 10) {
        $ollamaLaunched = $true
        $ollamaApp = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama app.exe'
        if (Test-Path -LiteralPath $ollamaApp) { Write-Log 'Ollama not running: starting the Ollama app'; Start-Process -FilePath $ollamaApp -WindowStyle Hidden }
        else { Write-Log "Ollama app not found at $ollamaApp" }
    }
    Start-Sleep -Seconds 2
}
Write-Log ("Ollama " + $(if (Test-Port 11434) { "ready after $([int]$ollamaWait.Elapsed.TotalSeconds) s" } else { 'not answering; backend starts anyway (rule-based fallback)' }))

$cloudflared = if ($NoTunnel) { $null } else { Find-Cloudflared }
if (!$NoTunnel -and !$cloudflared) { Write-Log 'cloudflared not found: Internet tunnel disabled.' }
$backendProc = $null; $tunnelProc = $null
$backendFailures = 0
$announced = $false
try {
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
        Save-Pids
    } elseif ($backendFailures -and ((Get-Date) - $started).TotalMinutes -gt 10) {
        $backendFailures = 0 # stable again: next restart is quick
    }
    # 3. Tunnel, once the backend answers.
    if ($cloudflared -and (!$tunnelProc -or $tunnelProc.HasExited) -and (Test-Port $Port)) {
        if ($tunnelProc) { Write-Log "Tunnel exited (code $($tunnelProc.ExitCode)); restarting"; Start-Sleep -Seconds 5 }
        $tunnelProc = Start-Tunnel $cloudflared
        Save-Pids
    }
    if ($tunnelProc) { Update-PublicUrl }
    if (!$announced -and (Test-Port $Port)) {
        $announced = $true
        Save-Pids # the voice bridge is running by now
        $url = if (Test-Path -LiteralPath (Join-Path $logs 'public-url.txt')) { (Get-Content (Join-Path $logs 'public-url.txt') -Raw).Trim() } else { '' }
        Write-Host ''
        Write-Host '  HE THONG DA CHAY. Giu cua so nay mo; dong cua so hoac chay Tat-AIoT.bat de tat.' -ForegroundColor Green
        Write-Host "  Tren may nay : http://localhost:$Port/dashboard"
        if ($url) { Write-Host "  Qua Internet : $url/dashboard" }
        Write-Host ''
    }
    Start-Sleep -Seconds 5
}
} finally {
    # Ctrl+C, closing the window or Tat-AIoT.bat: stop everything this run started.
    Write-Log 'AIoT supervisor stopping.'
    Save-Pids
    Stop-Recorded
}
