# Local Xiaozhi demo setup

## Demo architecture

The ESP32 streams PCM16 audio and sensor state to the existing NestJS backend on the laptop. The backend uses Ollama with `qwen2.5:3b` for local intent and reply generation, faster-whisper small (CPU int8, beam size 1) for Vietnamese speech recognition, and Edge TTS for spoken replies. The LLM and speech recognition need no API key. Edge TTS uses Microsoft's online voice service, so spoken replies need internet access. The ESP32 does not hold or run the model weights; it is the microphone, speaker, sensor, OLED and LED client.

Install the local ASR once. This installs the Python package and downloads the roughly 484 MB Whisper model to the laptop; the script writes only the model path into `backend/.env` and leaves other settings alone:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\install-local-asr.ps1"
```

Set `AI_PROVIDER=ollama` in `backend/.env`, then start the demo from the project root:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\start-local-xiaozhi.ps1"
```

The script starts Ollama when needed; the backend starts its loopback-only Whisper/TTS helper and warms Ollama when it boots. Keep this terminal open during the demo and press `Ctrl+C` to stop it. Edge TTS needs an internet connection. The firmware Wi-Fi settings in `include/config.h` must point to a 2.4 GHz network that both the ESP32 and laptop can reach; the firmware's WebSocket host must be the laptop address on that same network. ASR is pinned to Vietnamese and uses a short prompt for “đại ca”, LED commands, temperature and humidity; the local Vosk engine remains available by setting `LOCAL_ASR_ENGINE=vosk`.

For a voice check, speak one short sentence about 20–30 cm from the INMP441 microphone in a quiet room. The recognized words appear on the OLED/dashboard. Backend logs include capture duration, RMS and peak level only; they do not save or print room audio or transcripts. If no `Voice capture` line appears, lower `VAD_RMS` in `backend/.env` from 500 toward 350; if background noise triggers turns, raise it. Speech recognition transcribes words; it does not identify a person by voiceprint.

The installed official Xiaozhi server is a separate implementation. Its `/xiaozhi/v1/` WebSocket expects the Xiaozhi hello/session protocol, Opus audio and MCP IoT messages, while this project's firmware uses `/aiot` and PCM16. Sending the current firmware to the official server will not work. This project keeps its tested device protocol and uses the local Ollama model so sensor, OLED, LED, speaker and dashboard functions stay connected.

The OLED layout in `src/main.cpp` uses large temperature and humidity readings, short device state/LED/page labels at y=27, and a divider at y=35. The 128×28 conversation bitmap starts at y=36 with one question line and one AI reply line per page. The preview script is `backend/scripts/preview-oled.ts`; its generated image is `.pio/oled-preview.png`.

For local music playback, copy `.mp4` audio/video files into `backend/music/mp4/` and ask by the filename, for example “phát bài nhạc thư giãn”. The backend discovers those files, decodes the first audio stream with PyAV to 16 kHz mono PCM16, and streams it to the ESP32 speaker. The device does not decode MP4. Files are limited to 100 MB and five minutes; say “dừng nhạc” to stop playback. The local Whisper Python environment must include PyAV.

To check the physical display independently, follow [OLED-TEST.md](OLED-TEST.md). The test firmware cycles black, white, checkerboard, bars and grid/text patterns without starting Wi-Fi or touching the other peripherals.
