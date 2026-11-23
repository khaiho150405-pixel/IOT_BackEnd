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


# The free Edge TTS endpoint intermittently answers "No audio was received". The
# failure rate grows with text length and with how busy/throttled the service is
# (measured from ~0% to ~60% per request over one afternoon). Short phrases
# synthesized in parallel, each retried on its own, are far more reliable than
# retrying the whole sentence; when Edge still fails, a local Vietnamese voice
# answers quickly instead of the user waiting 10+ seconds.
EDGE_MAX_CHUNK_WORDS = int(os.environ.get("EDGE_TTS_MAX_CHUNK_WORDS", "8"))
EDGE_ATTEMPTS = int(os.environ.get("EDGE_TTS_ATTEMPTS", "5"))
EDGE_CONCURRENCY = int(os.environ.get("EDGE_TTS_CONCURRENCY", "4"))
EDGE_BUDGET_S = float(os.environ.get("EDGE_TTS_BUDGET_S", "3"))
# After a failed Edge render, skip Edge for this long: hammering a throttled
# endpoint keeps it throttled and every reply would wait the full budget.
EDGE_COOLDOWN_S = float(os.environ.get("EDGE_TTS_COOLDOWN_S", "300"))
# Consecutive failures double the pause (5, 10, 20... min) up to this cap, so a broken
# Edge endpoint does not add its ~3 s failure budget to a reply every few minutes.
EDGE_COOLDOWN_MAX_S = float(os.environ.get("EDGE_TTS_COOLDOWN_MAX_S", "3600"))
_edge_skip_until = 0.0
_edge_failures = 0


def split_for_tts(text: str, max_words: int = EDGE_MAX_CHUNK_WORDS) -> list[str]:
    """Split at punctuation first, then cut long phrases into near-equal word groups."""
    import re
    import unicodedata

    text = unicodedata.normalize("NFC", " ".join(text.split()))
    chunks: list[str] = []
    for phrase in re.split(r"(?<=[.!?;:,…])\s+", text):
        words = phrase.split()
        if not words:
            continue
        groups = max(1, -(-len(words) // max(1, max_words)))
        size = -(-len(words) // groups)
        chunks.extend(" ".join(words[i:i + size]) for i in range(0, len(words), size))
    return chunks


EDGE_HEDGE_S = float(os.environ.get("EDGE_TTS_HEDGE_S", "1.2"))


async def edge_once(text: str, voice: str, receive_timeout: int) -> bytes:
    import edge_tts

    audio = bytearray()
    communicate = edge_tts.Communicate(text, voice, connect_timeout=5, receive_timeout=receive_timeout)
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            audio.extend(chunk["data"])
            if len(audio) > 8_000_000:
                raise ValueError("TTS output exceeds size limit")
    if not audio:
        raise RuntimeError("empty audio")
    return bytes(audio)


async def edge_chunk(text: str, voice: str, deadline: float) -> bytes:
    """Some exact strings fail repeatedly, so after a few misses a multi-word chunk
    is split in half (a different request text) and each half is tried again."""
    words = text.split()
    if len(words) < 2:
        return await edge_hedged(text, voice, deadline, EDGE_ATTEMPTS)
    try:
        return await edge_hedged(text, voice, deadline, 3)
    except ValueError:
        raise
    except Exception:
        middle = len(words) // 2
        print(f"[TTS] Splitting a failing {len(words)}-word chunk", flush=True)
        halves = await asyncio.gather(edge_chunk(" ".join(words[:middle]), voice, deadline),
                                      edge_chunk(" ".join(words[middle:]), voice, deadline))
        return b"".join(halves)


async def edge_hedged(text: str, voice: str, deadline: float, attempts: int) -> bytes:
    """Hedged requests: a failed request takes ~3 s to report, so start another
    attempt every EDGE_HEDGE_S while earlier ones are pending; first success wins."""
    loop = asyncio.get_running_loop()
    pending: set[asyncio.Task] = set()
    started = failed = 0
    try:
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0.3:
                break
            if started < attempts and len(pending) < 2:
                started += 1
                pending.add(asyncio.create_task(edge_once(text, voice, min(8, int(remaining) + 1))))
            elif not pending:
                break
            wait = remaining if started >= attempts or len(pending) >= 2 else min(EDGE_HEDGE_S, remaining)
            done, pending = await asyncio.wait(pending, timeout=wait, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                error = task.exception()
                if error is None:
                    return task.result()
                if isinstance(error, ValueError):
                    raise error
                failed += 1
                print(f"[TTS] Edge-TTS attempt failed ({failed}/{attempts}, {len(text.split())} words): {error}", flush=True)
    finally:
        for task in pending:
            task.cancel()
    raise RuntimeError("Edge TTS chunk failed after retries")


async def render_edge(text: str, voice: str, ffmpeg: str) -> bytes:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + EDGE_BUDGET_S
    gate = asyncio.Semaphore(max(1, EDGE_CONCURRENCY))

    async def guarded(part: str) -> bytes:
        async with gate:
            return await edge_chunk(part, voice, deadline)

    parts = split_for_tts(text)
    # TaskGroup cancels the remaining chunks as soon as one fails for good.
    async with asyncio.TaskGroup() as group:
        tasks = [group.create_task(guarded(part)) for part in parts]
    mp3_parts = [task.result() for task in tasks]
    # Concatenated MP3 frames form a valid stream, so one FFmpeg call decodes them all.
    result = subprocess.run(
        [ffmpeg, "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-f", "s16le",
         "-ar", "16000", "-ac", "1", "pipe:1"],
        input=b"".join(mp3_parts), stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
        timeout=20,
    )
    if result.returncode != 0 or not result.stdout:
        raise RuntimeError("FFmpeg could not decode Edge TTS audio")
    return result.stdout


def render_windows_vietnamese(text: str) -> bytes:
    """Offline Vietnamese voice (Windows OneCore "Microsoft An") through SAPI.

    pyttsx3 only lists the classic SAPI voices (English David/Zira), so its
    fallback read Vietnamese with an English voice. OneCore voices are reachable
    through SAPI by enumerating their token category explicitly."""
    import tempfile

    import comtypes
    import comtypes.client as cc

    comtypes.CoInitialize()  # request handler threads need their own COM apartment
    path = tempfile.mktemp(".wav")
    try:
        speaker = cc.CreateObject("SAPI.SpVoice")
        category = cc.CreateObject("SAPI.SpObjectTokenCategory")
        category.SetId(r"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Speech_OneCore\Voices", False)
        tokens = category.EnumerateTokens()
        token = next((tokens.Item(i) for i in range(tokens.Count)
                      if "vivn" in tokens.Item(i).Id.lower() or "vietnam" in tokens.Item(i).GetDescription().lower()), None)
        if token is None:
            raise RuntimeError("no Vietnamese Windows voice installed (Settings > Time & language > Speech)")
        speaker.Voice = token
        stream = cc.CreateObject("SAPI.SpFileStream")
        stream.Format.Type = 18  # SAFT16kHz16BitMono: exactly the device format
        stream.Open(path, 3)
        try:
            speaker.AudioOutputStream = stream
            speaker.Speak(text)
        finally:
            stream.Close()
        with wave.open(path, "rb") as audio:
            if audio.getnchannels() != 1 or audio.getsampwidth() != 2 or audio.getframerate() != 16000:
                raise RuntimeError("unexpected Windows voice format")
            pcm = audio.readframes(audio.getnframes())
        if not pcm:
            raise RuntimeError("Windows voice produced no audio")
        return pcm
    finally:
        if os.path.exists(path):
            os.remove(path)
        comtypes.CoUninitialize()


async def render_speech(text: str, voice: str, ffmpeg: str) -> tuple[bytes, str]:
    """Returns PCM16 and the engine name; only "edge" audio should be cached by callers."""
    global _edge_skip_until, _edge_failures

    # 1. Edge TTS (natural neural voice), chunked with per-chunk retry
    if perf_counter() >= _edge_skip_until:
        try:
            started = perf_counter()
            pcm = await render_edge(text, voice, ffmpeg)
            print(f"[TTS] Edge-TTS ok ({len(split_for_tts(text))} chunks, {int((perf_counter() - started) * 1000)} ms)", flush=True)
            _edge_failures = 0
            return pcm, "edge"
        except Exception as e:
            cooldown = min(EDGE_COOLDOWN_MAX_S, EDGE_COOLDOWN_S * (2 ** _edge_failures))
            _edge_failures += 1
            _edge_skip_until = perf_counter() + cooldown
            print(f"[TTS] Edge-TTS failed ({type(e).__name__}); using offline voice for {int(cooldown)} s", flush=True)

    # 2. Offline Vietnamese Windows voice
    try:
        started = perf_counter()
        pcm = await asyncio.to_thread(render_windows_vietnamese, text)
        print(f"[TTS] Offline Vietnamese voice ok ({int((perf_counter() - started) * 1000)} ms)", flush=True)
        return pcm, "windows"
    except Exception as e:
        print(f"[TTS] Offline Vietnamese voice failed: {e}", flush=True)

    # 3. Last resort: pyttsx3 default voice (may not pronounce Vietnamese)
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
            return result.stdout, "pyttsx3"
    except Exception as e:
        print(f"[TTS] Offline fallback failed: {e}", flush=True)

    raise RuntimeError("Both Edge TTS and offline fallback failed.")


def choose_voice(text: str, default_voice: str, lang: str | None = None) -> str:
    # Hệ thống luôn phản hồi bằng tiếng Việt với giọng đọc chuẩn
    return default_voice


# Whisper tends to "hear" these stock phrases (from subtitles in its training
# data) when an utterance is only noise. They are never useful commands here.
WHISPER_HALLUCINATIONS = {
    "thank you", "thank you very much", "thanks for watching", "thank you for watching", "you", "bye",
    "subscribe", "cam on cac ban da theo doi", "cam on cac ban da xem video",
    "hay subscribe cho kenh ghien mi go de khong bo lo nhung video hap dan",
    "hen gap lai cac ban trong nhung video tiep theo", "ghien mi go",
}
# The previous initial_prompt listed command phrases ("Turn on the light, turn off
# the light"), and Whisper echoed it back on noisy audio, which switched the LED.
# A prompt may never contain commands; any echo of it is discarded.
LEGACY_PROMPT_ECHOES = ("xung em goi dai ca", "turn on the light turn off the light", "tieng viet and english")
VIETNAMESE_CHARS = set("đĐàáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵ"
                       "ÀÁẢÃẠĂẰẮẲẴẶÂẦẤẨẪẬÈÉẺẼẸÊỀẾỂỄỆÌÍỈĨỊÒÓỎÕỌÔỒỐỔỖỘƠỜỚỞỠỢÙÚỦŨỤƯỪỨỬỮỰỲÝỶỸỴ")


def fold_text(text: str) -> str:
    import re
    import unicodedata

    text = unicodedata.normalize("NFD", text.lower()).replace("đ", "d")
    text = "".join(c for c in text if unicodedata.category(c) != "Mn")
    return " ".join(re.sub(r"[^\w\s]", " ", text).split())


def is_vietnamese_only_model(name: str) -> bool:
    return os.environ.get("ASR_VIETNAMESE_ONLY", "").strip() == "1" or "phowhisper" in name.lower()


def whisper_transcribe(model, frames: bytes, beam_size: int, english_model=None,
                       vietnamese_only: bool = False) -> tuple[str, str, dict]:
    """Transcribe one utterance; returns (text, language, details).

    Measured on natural Vietnamese commands (48 clips, clean + 15 dB noise):
    old multilingual Whisper base 30.4% word errors / 1.4 s, PhoWhisper-base
    (VinAI, Vietnamese fine-tune) decoded without timestamps 4.2% / 0.66 s.

    - PhoWhisper only knows Vietnamese and always reports "vi", so a small
      multilingual model (english_model) detects English and transcribes it.
    - Vietnamese unless the audio is clearly English.
    - No command phrases in the prompt (see LEGACY_PROMPT_ECHOES).
    - Segments Whisper itself is unsure about are dropped instead of guessed.
    """
    import numpy as np

    samples = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    details: dict = {"dropped": []}
    language = os.environ.get("ASR_LANGUAGE", "auto").lower()
    detector = english_model if vietnamese_only else model
    configured = os.environ.get("ASR_WITHOUT_TIMESTAMPS", "").strip()

    def timestamps_off(decoder) -> bool:
        # PhoWhisper was fine-tuned without timestamp tokens: decoding with them
        # dropped first words and invented sentences (40.7% vs 4.2% word errors).
        return configured == "1" if configured else (vietnamese_only and decoder is model)

    def detect() -> str:
        try:
            _, _, probabilities = detector.detect_language(samples, vad_filter=True)
            scores = dict(probabilities)
            vi, en = scores.get("vi", 0.0), scores.get("en", 0.0)
            details["lang_scores"] = {"vi": round(vi, 3), "en": round(en, 3)}
            return "en" if en >= 0.5 and en > 2 * vi else "vi"
        except Exception as error:  # empty/silent audio: keep Vietnamese
            details["lang_error"] = str(error)[:80]
            return "vi"

    if language in ("vi", "en"):
        if language == "en" and vietnamese_only and english_model is None:
            language = "vi"
        decoder = english_model if language == "en" and vietnamese_only else model
        text, confidence = decode_utterance(decoder, samples, language, beam_size, timestamps_off(decoder), details)
    elif detector is None:
        language = "vi"
        text, confidence = decode_utterance(model, samples, "vi", beam_size, timestamps_off(model), details)
    elif vietnamese_only:
        # Detect the language (multilingual model) while PhoWhisper decodes the
        # likely-Vietnamese answer; CTranslate2 releases the GIL, so both run at once.
        from concurrent.futures import ThreadPoolExecutor

        with ThreadPoolExecutor(max_workers=1) as pool:
            detected = pool.submit(detect)
            vi_details: dict = {"dropped": []}
            text, confidence = decode_utterance(model, samples, "vi", beam_size, timestamps_off(model), vi_details)
            language = detected.result()
        if language == "en":
            text, confidence = decode_utterance(english_model, samples, "en", beam_size,
                                                timestamps_off(english_model), details)
        else:
            details["dropped"].extend(vi_details["dropped"])
        decoder = english_model if language == "en" else model
    else:
        language = detect()
        decoder = model
        text, confidence = decode_utterance(model, samples, language, beam_size, timestamps_off(model), details)
    details["model"] = "english" if vietnamese_only and language == "en" else "primary"
    if confidence is not None:
        details["confidence"] = confidence
    return text, language, details


def decode_utterance(decoder, samples, language: str, beam_size: int, without_timestamps: bool,
                     details: dict) -> tuple[str, float | None]:
    import numpy as np

    segments, _ = decoder.transcribe(
        samples,
        language=language,
        beam_size=beam_size,
        temperature=0.0,
        condition_on_previous_text=False,
        vad_filter=os.environ.get("ASR_VAD_FILTER", "1") != "0",
        vad_parameters=dict(min_silence_duration_ms=300, speech_pad_ms=200),
        no_speech_threshold=0.6,
        log_prob_threshold=-1.0,
        compression_ratio_threshold=2.4,
        initial_prompt=os.environ.get("ASR_INITIAL_PROMPT") or None,
        hotwords=os.environ.get("ASR_HOTWORDS") or None,
        without_timestamps=without_timestamps,
    )
    kept, weights, scores = [], [], []
    for segment in segments:
        piece = segment.text.strip()
        reason = ""
        if segment.no_speech_prob > 0.6 and segment.avg_logprob < -0.5:
            reason = "no_speech"
        elif segment.avg_logprob < -1.0:
            reason = "low_confidence"
        elif segment.compression_ratio > 2.4:
            reason = "repetitive"
        if reason:
            details["dropped"].append(f"{reason}:{piece[:40]}")
            continue
        kept.append(piece)
        weights.append(max(1, len(piece)))
        scores.append(float(np.exp(segment.avg_logprob)))
    text = " ".join(p for p in kept if p).strip()
    folded = fold_text(text)
    if folded in WHISPER_HALLUCINATIONS or any(echo in folded for echo in LEGACY_PROMPT_ECHOES):
        details["dropped"].append(f"hallucination:{text[:40]}")
        text = ""
    # Foreign scripts (Thai, Cyrillic, CJK...) only appear on noise for this device.
    if any(ord(c) > 127 and c not in VIETNAMESE_CHARS for c in text):
        details["dropped"].append(f"foreign_script:{text[:40]}")
        text = ""
    confidence = round(sum(w * s for w, s in zip(weights, scores)) / sum(weights), 3) if text and weights else None
    return text, confidence


def save_debug_audio(wav: bytes, text: str, language: str, details: dict) -> None:
    """Opt-in (ASR_DEBUG_DIR) recording of utterances for measuring accuracy.
    Room audio is private, so nothing is written unless the operator sets it."""
    target = os.environ.get("ASR_DEBUG_DIR")
    if not target:
        return
    try:
        from datetime import datetime

        folder = Path(target)
        folder.mkdir(parents=True, exist_ok=True)
        stem = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        (folder / f"{stem}.wav").write_bytes(wav)
        (folder / f"{stem}.json").write_text(json.dumps(
            {"text": text, "language": language, **details}, ensure_ascii=False), encoding="utf-8")
    except Exception as error:
        print(f"ASR debug save failed: {error}", file=sys.stderr, flush=True)


class BridgeHandler(BaseHTTPRequestHandler):
    model: object | None
    whisper_model: object | None
    english_model: object | None = None
    vietnamese_only: bool = False
    engine: str
    beam_size: int
    ffmpeg: str
    voice: str

    def log_message(self, _format, *_args):
        # Do not log spoken text or raw audio from the room.
        return

    def send_bytes(self, status: int, body: bytes, content_type: str, headers: dict | None = None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        for name, value in (headers or {}).items():
            self.send_header(name, value)
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
        details: dict = {}
        if self.engine == "whisper":
            text, detected_lang, details = whisper_transcribe(
                self.whisper_model, frames, self.beam_size, self.english_model, self.vietnamese_only)
        else:
            from vosk import KaldiRecognizer

            recognizer = KaldiRecognizer(self.model, 16000)
            recognizer.SetWords(False)
            recognizer.AcceptWaveform(frames)
            result = json.loads(recognizer.FinalResult())
            text = str(result.get("text", "")).strip()
        elapsed = int((perf_counter() - started) * 1000)
        dropped = f", dropped: {details['dropped']}" if details.get("dropped") else ""
        print(f"Local ASR completed ({self.engine}, {elapsed} ms, lang={detected_lang}{dropped}): \"{text}\"", flush=True)
        save_debug_audio(body, text, detected_lang, details)
        self.send_json(200, {"text": text[:400], "language": detected_lang, "engine": self.engine,
                             "confidence": details.get("confidence")})

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
        pcm, engine = asyncio.run(render_speech(text.strip(), chosen_voice, self.ffmpeg))
        self.send_bytes(200, pcm, "audio/pcm; rate=16000; channels=1; format=s16le", {"X-TTS-Engine": engine})


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
            required = ("config.json", "model.bin", "tokenizer.json")
            missing = [name for name in required if not (model_path / name).is_file()]
            # Newer CTranslate2 converters write vocabulary.json, older ones vocabulary.txt.
            if not any((model_path / name).is_file() for name in ("vocabulary.json", "vocabulary.txt")):
                missing.append("vocabulary.json")
            if missing:
                raise SystemExit(f"Whisper model directory is incomplete ({', '.join(missing)}): {model_name}")
        print(f"Loading local Whisper model {model_name} (CPU int8, {args.threads} threads)...", flush=True)
        BridgeHandler.whisper_model = WhisperModel(
            model_name, device="cpu", compute_type="int8", cpu_threads=max(1, args.threads), num_workers=1
        )
        BridgeHandler.vietnamese_only = is_vietnamese_only_model(model_name)
        english_name = os.environ.get("ASR_ENGLISH_MODEL", "base").strip()
        if BridgeHandler.vietnamese_only and english_name:
            print(f"Loading English/language-detection Whisper model {english_name}...", flush=True)
            BridgeHandler.english_model = WhisperModel(
                english_name, device="cpu", compute_type="int8", cpu_threads=max(1, args.threads), num_workers=1
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
