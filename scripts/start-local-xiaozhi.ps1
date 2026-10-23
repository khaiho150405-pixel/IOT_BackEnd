param([switch]$CheckOnly)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$backendRoot = Join-Path $projectRoot 'backend'
$envFile = Join-Path $backendRoot '.env'
$ollama = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
$voiceRoot = Join-Path $env:LOCALAPPDATA 'AIoT\xiaozhi-esp32-server\main\xiaozhi-server'
$voicePython = Join-Path $voiceRoot '.venv\Scripts\python.exe'
$voskModel = Join-Path $voiceRoot 'models\vosk\vosk-model-small-vn-0.4'
$model = 'qwen2.5:3b'
$asrEngine = (Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^LOCAL_ASR_ENGINE=' } | Select-Object -Last 1) -replace '^LOCAL_ASR_ENGINE=', ''
if (!$asrEngine) { $asrEngine = 'vosk' }
$asrEngine = $asrEngine.Trim().Trim('"', "'").ToLowerInvariant()
$whisperModel = (Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^LOCAL_WHISPER_MODEL=' } | Select-Object -Last 1) -replace '^LOCAL_WHISPER_MODEL=', ''
if (!$whisperModel) { $whisperModel = 'small' }
$whisperModel = $whisperModel.Trim().Trim('"', "'")

foreach ($path in @($backendRoot, $envFile, $ollama, $voicePython)) {
  if (!(Test-Path -LiteralPath $path)) { throw "Required local demo file is missing: $path" }
}
if ($asrEngine -eq 'whisper') {
  & $voicePython -c 'import faster_whisper' 2>$null
  if ($LASTEXITCODE -ne 0) {
    $requirements = Join-Path $backendRoot 'requirements-local-voice.txt'
    throw "Whisper package missing. Run: uv pip install --python `"$voicePython`" -r `"$requirements`""
  }
} elseif ($asrEngine -eq 'vosk') {
  if (!(Test-Path -LiteralPath $voskModel)) { throw "Vietnamese Vosk model is missing: $voskModel" }
} else {
  throw 'LOCAL_ASR_ENGINE must be whisper or vosk.'
}

$configuredProvider = (Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^AI_PROVIDER=' } | Select-Object -Last 1) -replace '^AI_PROVIDER=', ''
if ($configuredProvider.Trim().Trim('"', "'").ToLowerInvariant() -ne 'ollama') {
  throw 'Set AI_PROVIDER=ollama in backend/.env before starting the local demo.'
}

try {
  $tags = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 3
} catch {
  Start-Process -FilePath $ollama -ArgumentList 'serve' -WindowStyle Hidden
  $deadline = (Get-Date).AddSeconds(30)
  do {
    Start-Sleep -Milliseconds 500
    try { $tags = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 2; break }
    catch { $tags = $null }
  } while ((Get-Date) -lt $deadline)
  if (!$tags) { throw 'Ollama did not start at http://127.0.0.1:11434.' }
}

if (!($tags.models | Where-Object { $_.name -eq $model })) {
  & $ollama pull $model
  if ($LASTEXITCODE -ne 0) { throw "Could not download $model." }
}

$address = Get-NetIPAddress -AddressFamily IPv4 -IPAddress '192.168.137.1' -ErrorAction SilentlyContinue | Select-Object -First 1
if (!$address) {
  $route = Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
    Sort-Object RouteMetric, InterfaceMetric | Select-Object -First 1
  if ($route) {
    $address = Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $route.InterfaceIndex -AddressState Preferred -ErrorAction SilentlyContinue |
      Where-Object { $_.IPAddress -notlike '127.*' } | Select-Object -First 1
  }
}
$lanIp = if ($address) { $address.IPAddress } else { 'localhost' }

Write-Host "Local model: $model (Ollama)"
if ($asrEngine -eq 'whisper') {
  Write-Host "Vietnamese speech recognition: Whisper $whisperModel (local CPU int8)"
} else {
  Write-Host 'Vietnamese speech recognition: Vosk'
}
Write-Host 'Speech output: Edge TTS (internet required)'
Write-Host "Backend health: http://${lanIp}:3000/health"
Write-Host 'The NestJS backend starts the loopback-only voice bridge and warms the model.'
if ($CheckOnly) { exit 0 }
if (Get-NetTCPConnection -State Listen -LocalPort 3000 -ErrorAction SilentlyContinue) {
  throw 'Port 3000 is already in use. Stop the existing AIoT backend before restarting.'
}
Write-Host 'Press Ctrl+C to stop the AIoT backend.'
Push-Location $backendRoot
try { & npm run dev }
finally { Pop-Location }
