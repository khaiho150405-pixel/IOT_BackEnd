# Backend cho trợ lý ESP32-S3

## Khởi chạy

Chạy từ thư mục `backend`, dùng Node.js >=22:

```powershell
npm.cmd ci
Copy-Item .env.example .env
# Sửa .env: chọn AI_PROVIDER=ollama hoặc AI_PROVIDER=gemini; cấu hình DEVICE_TOKEN.
npm.cmd run build
npm.cmd start
```

Không ghi đè `.env` đã có. `npm.cmd run dev` chạy TypeScript trực tiếp để phát triển. `AI_PROVIDER=ollama` dùng Qwen cục bộ qua Ollama và khởi động helper Vosk tiếng Việt trên loopback; model LLM và nhận dạng tiếng nói không cần API key. Edge TTS vẫn cần Internet. `AI_PROVIDER=gemini` dùng Gemini audio/TTS và cần key/quota. ESP32 chỉ biết IP/port và `WS_TOKEN` trùng `DEVICE_TOKEN`. Không tự gọi Gemini API thật trong bài test.

## AIoT Control Desk

Sau khi backend chạy, mở `http://localhost:3000/dashboard` trên máy tính. Dashboard poll trạng thái thiết bị/cảm biến mỗi 2 giây, gửi lệnh bật/tắt LED qua WebSocket và có ô nhập câu tự nhiên như “bật đèn” hoặc “nhiệt độ trong phòng bao nhiêu?”. Đặt `AI_PROVIDER=ollama` để dùng Qwen 2.5 3B cục bộ qua Ollama cùng Vosk tiếng Việt; không cần API key cho nhận dạng giọng nói và mô hình ngôn ngữ. Phát giọng dùng Edge TTS, cần internet. Đặt `AI_PROVIDER=gemini` để quay lại Gemini. Trạng thái LED được đồng bộ từ trường `led_enabled` trong hello của firmware và ACK của mỗi lệnh; với firmware cũ, dashboard hiển thị chưa xác định cho đến khi có ACK. API dashboard chỉ cho phép truy cập loopback và yêu cầu Origin cùng nguồn, nên giao diện điều khiển hoạt động trên chính máy backend, không phải điện thoại hay máy khác trong LAN. Đây là LED WS2812B trên testboard, không phải relay đèn điện lưới.

`GEMINI_API_STYLE=current` dùng định dạng request trong tài liệu Gemini hiện tại với các model mặc định trong `.env.example`. Nếu tài khoản chỉ có model cũ còn hỗ trợ, chọn tên model đó, model TTS tương ứng và `GEMINI_API_STYLE=legacy` để dùng `responseMimeType`/`prebuiltVoiceConfig`. Không trộn hai thế hệ request nếu model không hỗ trợ. HTTP 400/404/403/429 được báo ở terminal; firmware hiển thị lỗi và quay về nghe, không thông báo thực hiện lệnh thành công khi chưa có ACK.

Model có thể thay đổi khả dụng theo tài khoản/thời gian. Có thể kiểm tra các model được cấp quyền trong Google AI Studio. Không có thử nghiệm API thật trong lần phát triển khi chưa cung cấp key.

## Luồng xử lý

1. ESP32 mở `/aiot` với Bearer token, gửi `hello` có MAC và PCM16/16k/mono.
2. `UtteranceDetector` giữ pre-roll khoảng 300 ms, ngưỡng RMS cấu hình, tối thiểu 160 ms âm thanh trên ngưỡng, kết thúc sau 900 ms im lặng/tối đa 12 giây. Đây chỉ là phát hiện năng lượng âm thanh; tiếng ồn có thể kích hoạt. Chế độ local dùng Vosk để nhận dạng tiếng Việt; Gemini nhận âm thanh trực tiếp và hỗ trợ nhiều ngôn ngữ.
3. Chế độ local gửi WAV tới helper Vosk loopback rồi gửi transcript, 5 lượt hội thoại gần nhất, số đo mới và danh sách nhạc tới Ollama. Chế độ Gemini gửi audio cùng ngữ cảnh tới model; prompt yêu cầu tự nhận ngôn ngữ và đáp lại cùng ngôn ngữ, hoặc theo yêu cầu người nói.
4. Kiểm tra JSON bằng schema và whitelist ý định. Bật/tắt đèn phải có ACK tương ứng từ ESP32 trong 3 giây. Không thực thi mã hoặc URL model tự đề xuất.
5. Gửi transcript/reply và các trang bitmap OLED; TTS được chọn theo provider, chuyển về PCM16/16k/mono, phát theo nhịp 20 ms.
6. Kết thúc/hủy/lỗi đều giải phóng trạng thái bận. Nút BOOT gửi `interrupt` để hủy request API/phát âm thanh, quay lại lắng nghe.

Phiên âm và phản hồi mỗi trường tối đa 400 ký tự, tối đa 32 trang OLED. Đây là phản hồi ngắn; yêu cầu nội dung dài nên chia thành nhiều lượt. Text Unicode luôn có trong giao thức/lịch sử; glyph trên OLED phụ thuộc font server. Windows có Segoe UI cho tiếng Việt. Linux cần cài font Noto Sans hoặc chỉ định thư mục font `.ttf/.otf/.ttc` qua `FONT_DIR`; CJK/Arabic/Thai cần font chứa hệ chữ tương ứng. `OLED_FONT` cho phép chọn family/kích thước. Font quá lớn có thể làm vượt giới hạn trang.

## Nhạc

Thêm WAV PCM16 mono 16 kHz vào thư mục `music`, rồi sửa `music/catalog.json`:

```json
[
  {"id":"song-01","title":"Tên bài hát của nhóm","file":"song-01.wav"}
]
```

Chỉ phát ID trong danh mục, không chấp nhận đường dẫn/URL do Gemini tự tạo. Giới hạn 10 MB/file (khoảng 5 phút), không decode MP3 trực tiếp. Chuyển đổi bằng FFmpeg nếu có:

```powershell
ffmpeg -i source.mp3 -ac 1 -ar 16000 -c:a pcm_s16le music/song-01.wav
```

Nói “Bật bài Tên bài hát của nhóm”. Nhấn BOOT để dừng và nói tiếp. Micro tạm ngắt trong lúc phát, nên không thể nói đè “dừng nhạc” để ngắt trực tiếp. Không có nhạc sẵn trong repository và không kết nối dịch vụ streaming.

## PostgreSQL

Đặt `DATABASE_URL=postgresql://user:password@localhost:5432/aiot` để lưu bền vững. Database phải được tạo sẵn; backend tự chạy migration tạo bảng `aiot_chat_log` và index của ứng dụng. Không dùng `synchronize`. Mỗi dòng có deviceId, phiên âm, câu trả lời, ý định và thời điểm. Mỗi thiết bị dùng 5 lượt mới nhất làm ngữ cảnh. Không có DATABASE_URL thì chỉ giữ 5 lượt/thiết bị trong RAM, tối đa 100 thiết bị, mất sau restart; terminal sẽ thông báo rõ.

Nếu cấu hình DB nhưng không kết nối được, server không khởi động. Nếu ghi lịch sử lỗi giữa phiên, phản hồi vẫn được phát và terminal báo lỗi. Nhóm triển khai cần đặt chính sách giữ/xóa lịch sử phù hợp.

## Giao thức dành cho đội ứng dụng

| Hướng | Message | Ý nghĩa |
| --- | --- | --- |
| ESP→server | `hello` | Bắt buộc trong 10 giây, PCM format và device_id |
| ESP→server | binary | Mic PCM16 LE mono 16k, tối đa 4096 byte/frame |
| ESP→server | `sensor` | valid, temperature °C, humidity %, uptime_ms |
| ESP→server | `ack` | id, device, action, enabled |
| ESP→server | `interrupt` | Nút BOOT: hủy lượt đang chạy |
| ESP→server | `playback_done` | id khớp audio_start; gửi sau khi buffer và DMA đã phát hết |
| ESP→server | `error` | Lỗi format, đầy buffer… |
| server→ESP | `status` | state=thinking/listening |
| server→ESP | `command` | id, device=led, action=on/off |
| server→ESP | `transcript` / `chat` | text hoặc reply, language |
| server→ESP | `display` | batch, index, total, bitmap base64 128×48 row-major MSB |
| server→ESP | `audio_start` | id, duration_ms, mode=speech/music, xóa buffer cũ |
| server→ESP | binary | Loa PCM16 LE mono 16k, 640 byte/20 ms |
| server→ESP | `audio_end` / `audio_stop` | audio_end kèm id: phát hết buffer / audio_stop: hủy ngay |
| server→ESP | `notice` | code=tts_failed/turn_failed, xem log server |

Không phải Socket.IO. HTTP `/health` là liveness, không kiểm tra kết nối Ollama hoặc quota Gemini. Header token được kiểm tra trước khi nâng cấp WebSocket; tối đa 8 kết nối, 8192 byte/message, giới hạn tần suất và một lượt AI/thiết bị. Server có ping/pong để loại kết nối chết.

`ws://` hiện chỉ cho LAN tin cậy. Khi đưa ra ngoài LAN cần bổ sung WSS với kiểm tra certificate phía ESP32 và token riêng từng thiết bị; token qua WS không mã hóa không đủ bảo vệ trên Internet. Không nhúng khóa API vào firmware/app di động.

## Kiểm thử

```powershell
npm.cmd test
npm.cmd run build
npx.cmd tsx scripts/preview-oled.ts
```

Test tự động dùng API giả lập, không tiêu quota. Có kiểm tra vòng WebSocket, ACK timeout, hủy playback, lỗi TTS, validation quyết định AI, VAD, WAV, chống alias khi resample, OLED tiếng Việt, giới hạn file nhạc và cách ly lịch sử. Bản thử thực cần đo tín hiệu mic, tinh chỉnh `VAD_RMS`; nhiều ngôn ngữ giọng nói yêu cầu Gemini vì Vosk hiện cấu hình tiếng Việt.

Tài liệu API đã đối chiếu: [Gemini audio](https://ai.google.dev/gemini-api/docs/generate-content/audio), [Gemini speech generation](https://ai.google.dev/gemini-api/docs/generate-content/speech-generation).
