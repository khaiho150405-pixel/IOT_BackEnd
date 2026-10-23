# MP4 music for the ESP32 demo

Copy audio or video `.mp4` files into this folder. The backend discovers the filenames automatically; no catalog edit is needed. Ask the device to “phát bài <tên file>” or “mở nhạc <tên file>”. Say “dừng nhạc” to stop playback.

The laptop backend decodes the first MP4 audio stream to 16 kHz mono PCM16, then streams it to the ESP32 speaker over the existing WebSocket. The ESP32 does not decode MP4 itself. The configured local Python environment must have PyAV installed; the Whisper environment used by this project already includes it. Tracks are limited to 100 MB and five minutes so the demo stays within the device/backend audio path limits.

Use clear filenames such as `nhac-thu-gian.mp4`. The backend uses the filename as the track title. Keep personal music files in this folder; the project ignores `.mp4` files in Git.
