$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$backendRoot = Join-Path $projectRoot 'backend'
$voiceRoot = Join-Path $env:LOCALAPPDATA 'AIoT\xiaozhi-esp32-server\main\xiaozhi-server'
$voicePython = Join-Path $voiceRoot '.venv\Scripts\python.exe'
$requirements = Join-Path $backendRoot 'requirements-local-voice.txt'
$envFile = Join-Path $backendRoot '.env'
$modelDir = Join-Path $env:LOCALAPPDATA 'AIoT\models\faster-whisper-small'

foreach ($path in @($voicePython, $requirements, $envFile)) {
  if (!(Test-Path -LiteralPath $path)) { throw "Required local voice file is missing: $path" }
}
$uv = Get-Command uv -ErrorAction SilentlyContinue
if (!$uv) { throw 'uv is required. Install Astral uv, then run this script again.' }

& $uv.Source pip install --python $voicePython -r $requirements
if ($LASTEXITCODE -ne 0) { throw 'Could not install faster-whisper into the local voice environment.' }

New-Item -ItemType Directory -Force -Path $modelDir | Out-Null
$files = @(
  @{ Name = 'config.json'; Minimum = 1000 },
  @{ Name = 'tokenizer.json'; Minimum = 1000000 },
  @{ Name = 'vocabulary.txt'; Minimum = 200000 },
  @{ Name = 'model.bin'; Minimum = 483546902 }
)
foreach ($file in $files) {
  $target = Join-Path $modelDir $file.Name
  if ((Test-Path -LiteralPath $target) -and (Get-Item -LiteralPath $target).Length -ge $file.Minimum) {
    if ($file.Name -eq 'model.bin' -and (Get-Item -LiteralPath $target).Length -ne $file.Minimum) {
      throw "Whisper model size is incorrect: $target"
    }
    Write-Host "Already downloaded: $($file.Name)"
    continue
  }
  $curlArgs = @('-fL', '--retry', '3', '--retry-delay', '2', '-o', $target)
  if ((Test-Path -LiteralPath $target) -and (Get-Item -LiteralPath $target).Length -gt 0) {
    $curlArgs += @('-C', '-')
  }
  $curlArgs += "https://huggingface.co/Systran/faster-whisper-small/resolve/main/$($file.Name)?download=true"
  & curl.exe @curlArgs
  if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $target) -or (Get-Item -LiteralPath $target).Length -lt $file.Minimum) {
    throw "Could not download a complete Whisper model file: $($file.Name)"
  }
  if ($file.Name -eq 'model.bin' -and (Get-Item -LiteralPath $target).Length -ne $file.Minimum) {
    throw "Whisper model size is incorrect: $target"
  }
}

$modelPath = $modelDir.Replace('\', '/')
$lines = [System.Collections.Generic.List[string]]::new()
[System.IO.File]::ReadAllLines($envFile) | ForEach-Object { $lines.Add($_) }
$updated = $false
for ($index = 0; $index -lt $lines.Count; $index++) {
  if ($lines[$index] -match '^LOCAL_WHISPER_MODEL=') {
    $lines[$index] = "LOCAL_WHISPER_MODEL=$modelPath"
    $updated = $true
  }
}
if (!$updated) { $lines.Add("LOCAL_WHISPER_MODEL=$modelPath") }
[System.IO.File]::WriteAllLines($envFile, $lines, [System.Text.UTF8Encoding]::new($false))
Write-Host "Whisper small is installed locally at $modelDir. backend/.env now points to this copy."
