#!/usr/bin/env python3
"""Loopback-only Vietnamese ASR and Edge TTS bridge for the local Ollama provider."""

import argparse
import asyncio
import io
import json
import os
import shutil
import subprocess
import sys
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from time import perf_counter


def ffmpeg_path() -> str:
    configured = os.environ.get("FFMPEG_EXE")
    if configured and Path(configured).is_file():
        return configured
    found = shutil.which("ffmpeg")
    if found:
        return found
    local = Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "WinGet" / "Packages"
    for candidate in local.glob("Gyan.FFmpeg.Shared*/ffmpeg-*/bin/ffmpeg.exe"):
        if candidate.is_file():
            return str(candidate)
    raise RuntimeError("FFmpeg is required for Edge TTS audio conversion.")


async def render_speech(text: str, voice: str, ffmpeg: str) -> bytes:
    import edge_tts

    # 1. Try Edge TTS (natural neural voice) with retry
    for attempt in range(2):
        try:
            audio = bytearray()
            async for chunk in edge_tts.Communicate(text, voice).stream():
                if chunk["type"] == "audio":
                    audio.extend(chunk["data"])
                    if len(audio) > 8_000_000:
                        raise ValueError("TTS output exceeds size limit")
            if audio:
                result = subprocess.run(
                    [ffmpeg, "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-f", "s16le",
                     "-ar", "16000", "-ac", "1", "pipe:1"],
                    input=bytes(audio), stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
                    timeout=20,
                )
                if result.returncode == 0 and result.stdout:
                    return result.stdout
        except Exception as e:
            print(f"[TTS] Edge-TTS attempt {attempt + 1} failed: {e}", flush=True)
            await asyncio.sleep(0.3)

    # 2. 100% Offline pyttsx3 fallback if Edge TTS is unreachable
    print("[TTS] Falling back to offline pyttsx3 voice engine...", flush=True)
    try:
        import pyttsx3
        import tempfile

        engine = pyttsx3.init()
        engine.setProperty("rate", 160)
        tmp = tempfile.mktemp(".wav")
        engine.save_to_file(text, tmp)
        engine.runAndWait()
        with open(tmp, "rb") as f:
            raw_wav = f.read()
        if os.path.exists(tmp):
            os.remove(tmp)
        result = subprocess.run(
            [ffmpeg, "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-f", "s16le",
             "-ar", "16000", "-ac", "1", "pipe:1"],
            input=raw_wav, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
            timeout=10,
        )
        if result.returncode == 0 and result.stdout:
            return result.stdout
    except Exception as e:
        print(f"[TTS] Offline fallback failed: {e}", flush=True)

    raise RuntimeError("Both Edge TTS and offline fallback failed.")


def choose_voice(text: str, default_voice: str, lang: str | None = None) -> str:
    # Hệ thống luôn phản hồi bằng tiếng Việt với giọng đọc chuẩn
    return default_voice


class BridgeHandler(BaseHTTPRequestHandler):
    model: object | None
    whisper_model: object | None
    engine: str
    beam_size: int
    ffmpeg: str
    voice: str

    def log_message(self, _format, *_args):
        # Do not log spoken text or raw audio from the room.
        return

    def send_bytes(self, status: int, body: bytes, content_type: str):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, status: int, value: dict):
        self.send_bytes(status, json.dumps(value, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def do_GET(self):
        if self.path == "/health":
            self.send_json(200, {"status": "ok", "asr": self.engine, "tts": "edge-tts"})
        else:
            self.send_json(404, {"error": "not_found"})

    def do_POST(self):
        if self.client_address[0] not in ("127.0.0.1", "::1"):
            self.send_json(403, {"error": "loopback_only"})
            return
        length = int(self.headers.get("Content-Length", "0"))
        limit = 1_000_000 if self.path == "/transcribe" else 8_000
        if length <= 0 or length > limit:
            self.send_json(413, {"error": "invalid_size"})
            return
        body = self.rfile.read(length)
        try:
            if self.path == "/transcribe":
                self.transcribe(body)
            elif self.path == "/synthesize":
                self.synthesize(body)
            else:
                self.send_json(404, {"error": "not_found"})
        except (ValueError, wave.Error, json.JSONDecodeError) as error:
            self.send_json(400, {"error": str(error)[:120]})
        except Exception as error:
            print(f"Local voice request failed: {type(error).__name__}: {error}", file=sys.stderr, flush=True)
            self.send_json(502, {"error": "local_voice_unavailable"})

    def transcribe(self, body: bytes):
        with wave.open(io.BytesIO(body), "rb") as audio:
            if audio.getnchannels() != 1 or audio.getsampwidth() != 2 or audio.getframerate() != 16000:
                raise ValueError("Expected mono PCM16 WAV at 16000 Hz")
            frames = audio.readframes(audio.getnframes())
        started = perf_counter()
        detected_lang = "vi"
        if self.engine == "whisper":
            import numpy as np

            samples = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
            segments, info = self.whisper_model.transcribe(
                samples,
                language=None,
                beam_size=self.beam_size,
                temperature=0.0,
                condition_on_previous_text=False,
                vad_filter=True,
                vad_parameters=dict(min_silence_duration_ms=250),
                repetition_penalty=1.2,
                no_speech_threshold=0.6,
                initial_prompt="Tiếng Việt and English. Xưng em, gọi đại ca. Turn on the light, turn off the light, temperature, humidity, chat, talk.",
            )
            collected = []
            for segment in segments:
                if getattr(segment, "no_speech_prob", 0) < 0.75:
                    collected.append(segment.text)
            text = "".join(collected).strip()
            if info and getattr(info, "language", None):
                if info.language in ("vi", "en"):
                    detected_lang = info.language
                else:
                    detected_lang = "vi"
            # Filter out foreign script hallucinations (Thai, Cyrillic, Arabic, CJK, Korean, etc.) on silence/noise
            vietnamese_chars = set("đĐàáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵÀÁẢÃẠĂẰẮẲẴẶÂẦẤẨẪẬÈÉẺẼẸÊỀẾỂỄỆÌÍỈĨỊÒÓỎÕỌÔỒỐỔỖỘƠỜỚỞỠỢÙÚỦŨỤƯỪỨỬỮỰỲÝỶỸỴ")
            if any(ord(c) > 127 and c not in vietnamese_chars for c in text):
                text = ""
        else:
            from vosk import KaldiRecognizer

            recognizer = KaldiRecognizer(self.model, 16000)
            recognizer.SetWords(False)
            recognizer.AcceptWaveform(frames)
            result = json.loads(recognizer.FinalResult())
            text = str(result.get("text", "")).strip()
        elapsed = int((perf_counter() - started) * 1000)
        print(f"Local ASR completed ({self.engine}, {elapsed} ms, lang={detected_lang}): \"{text}\"", flush=True)
        self.send_json(200, {"text": text[:400], "language": detected_lang, "engine": self.engine})

    def synthesize(self, body: bytes):
        try:
            payload = body.decode("utf-8")
        except UnicodeDecodeError:
            payload = body.decode("utf-8", errors="replace")
        request = json.loads(payload)
        text = request.get("text")
        lang = request.get("language")
        if not isinstance(text, str) or not text.strip() or len(text) > 400:
            raise ValueError("text must contain 1 to 400 characters")
        chosen_voice = choose_voice(text.strip(), self.voice, lang)
        pcm = asyncio.run(render_speech(text.strip(), chosen_voice, self.ffmpeg))
        self.send_bytes(200, pcm, "audio/pcm; rate=16000; channels=1; format=s16le")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8010)
    parser.add_argument("--engine", choices=("vosk", "whisper"), default=os.environ.get("LOCAL_ASR_ENGINE", "vosk"))
    parser.add_argument("--model", default="")
    parser.add_argument("--threads", type=int, default=int(os.environ.get("LOCAL_ASR_CPU_THREADS", "4")))
    parser.add_argument("--beam-size", type=int, default=int(os.environ.get("LOCAL_ASR_BEAM_SIZE", "1")))
    args = parser.parse_args()
    if args.host not in ("127.0.0.1", "::1"):
        raise SystemExit("The local voice bridge must bind to loopback only.")
    if not 1 <= args.beam_size <= 5:
        raise SystemExit("--beam-size must be between 1 and 5.")
    BridgeHandler.engine = args.engine
    BridgeHandler.beam_size = args.beam_size
    BridgeHandler.model = None
    BridgeHandler.whisper_model = None
    if args.engine == "vosk":
        from vosk import Model, SetLogLevel

        SetLogLevel(-1)
        if not Path(args.model).is_dir():
            raise SystemExit(f"Vosk model directory not found: {args.model}")
        BridgeHandler.model = Model(args.model)
    else:
        from faster_whisper import WhisperModel

        model_name = args.model or "small"
        model_path = Path(model_name)
        if model_path.is_absolute() or "/" in model_name or "\\" in model_name:
            required = ("config.json", "model.bin", "tokenizer.json", "vocabulary.txt")
            missing = [name for name in required if not (model_path / name).is_file()]
            if missing:
                raise SystemExit(f"Whisper model directory is incomplete ({', '.join(missing)}): {model_name}")
        print(f"Loading local Whisper model {model_name} (CPU int8, {args.threads} threads)...", flush=True)
        BridgeHandler.whisper_model = WhisperModel(
            model_name, device="cpu", compute_type="int8", cpu_threads=max(1, args.threads), num_workers=1
        )
        print(f"Local Whisper model {model_name} ready.", flush=True)
    BridgeHandler.ffmpeg = ffmpeg_path()
    BridgeHandler.voice = os.environ.get("LOCAL_TTS_VOICE", "vi-VN-HoaiMyNeural")
    server = ThreadingHTTPServer((args.host, args.port), BridgeHandler)
    server.daemon_threads = True
    print(f"Local voice bridge ready at http://{args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
