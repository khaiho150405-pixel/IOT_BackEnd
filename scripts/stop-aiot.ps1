# Stops the AIoT system started by Khoi-dong-AIoT.bat: the supervisor, the backend, its voice
# bridge and the AIoT tunnel. Only processes AIoT started are touched (recorded process ids, or
# the children of the AIoT supervisor), never other Node apps or the "Cloudflared" service.
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $root 'backend\logs\aiot.pids'
$stopped = 0

function Stop-Tree([int]$id, [string]$why) {
    # Ollama (started by the supervisor when it was off) is a shared app: leave it and its children.
    $self = Get-Process -Id $id -ErrorAction SilentlyContinue
    if (!$self -or $self.ProcessName -match '^ollama') { return }
    # Children first (backend -> voice bridge), then the process itself.
    Get-CimInstance Win32_Process -Filter "ParentProcessId=$id" -ErrorAction SilentlyContinue |
        ForEach-Object { Stop-Tree $_.ProcessId "$why child" }
    $process = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($process) {
        Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
        Write-Host ("  da tat {0} ({1}, pid {2})" -f $why, $process.ProcessName, $id)
        $script:stopped++
    }
}

# 1. Processes recorded by the supervisor (names checked: a recycled id is never stopped).
if (Test-Path -LiteralPath $pidFile) {
    foreach ($line in Get-Content -Path $pidFile) {
        $role, $id, $name = $line -split ' '
        $process = Get-Process -Id ([int]$id) -ErrorAction SilentlyContinue
        if ($process -and $process.ProcessName -eq $name) { Stop-Tree ([int]$id) $role }
    }
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}
# 2. A supervisor without a pid file (older version): find it by its command line.
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'aiot-supervisor\.ps1' -and $_.ProcessId -ne $PID } |
    ForEach-Object { Stop-Tree $_.ProcessId 'supervisor' }

if ($stopped) { Write-Host "Da tat he thong AIoT ($stopped tien trinh)." -ForegroundColor Green }
else { Write-Host 'He thong AIoT khong chay.' }
