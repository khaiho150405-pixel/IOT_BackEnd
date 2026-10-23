# Trợ lý giọng nói AI + ESP32-S3 N16R8

Firmware và backend NestJS cho bật/tắt LED bằng lời nói, hỏi nhiệt độ/độ ẩm, trò chuyện và phát nhạc từ thư viện cục bộ. Có thể chọn Qwen 2.5 3B chạy local qua Ollama + Vosk tiếng Việt, hoặc Gemini nhận âm thanh trực tiếp; giọng đọc dùng Edge TTS ở chế độ local và Gemini TTS ở chế độ Gemini.

Máy chạy backend phải bật. ESP32 không chạy mô hình và không gọi AI trực tiếp. Chế độ local xử lý LLM và nhận dạng tiếng Việt trên laptop; Edge TTS vẫn cần Internet. Vosk model hiện tại chỉ nhận dạng tiếng Việt; chế độ Gemini hỗ trợ nhận âm thanh đa ngôn ngữ. Đây là hội thoại theo lượt: nói một câu, dừng khoảng 0,5 giây, đợi hệ thống xử lý và trả lời rồi nói tiếp. Chưa có wake word hoặc khử tiếng vọng để nói đè lên loa.

Tối ưu demo: chế độ local giữ Qwen đã nạp trong bộ nhớ, TTS chạy song song với chờ ACK và lịch sử không chặn phản hồi. Backend dành tối đa 8 giây cho phân tích và 9,5 giây để đưa câu trả lời chữ/OLED đầu tiên ra thiết bị. Khi câu trả lời đã hiện, TTS có thêm tối đa 2,2 giây, sau đó thử giọng ngắn đã chuẩn bị sẵn trong 0,7 giây. Nếu phân tích quá hạn, gửi `response_timeout`, hiện chỉ dẫn trên OLED và trả micro về nghe. Chế độ Gemini vẫn phụ thuộc API/mạng. Log `Voice latency: text=...ms` và `audio=...ms` đo từ lúc phát hiện hết câu, chưa gồm thời gian VAD im lặng và độ trễ phát loa.

OLED 128×64: hai dòng đầu luôn hiển thị `Nhiet do`, `Do am`, trạng thái và số trang. Vùng dưới có một dòng `Bạn:` và hai dòng `AI:`, hỗ trợ dấu tiếng Việt bằng bitmap. Nội dung dài tự chuyển trang mỗi 3,5 giây. Cần nạp firmware mới để áp dụng phần đầu màn hình.

Luồng nhiều lượt: ESP32 gửi `playback_done` khi loa/buffer đã phát hết; backend mới gửi `listening`. Firmware xóa toàn bộ trạng thái phát khi nhận `listening`; nếu audio bị kẹt thì watchdog khôi phục, không giữ micro bị khóa. Backend đợi xác nhận kết thúc tối đa 4 giây sau audio_end rồi hủy an toàn. Khi chuẩn bị giọng nói thành công, OLED hiện câu trả lời và audio được gửi ngay tiếp theo; không còn cố ý hiện câu trả lời rồi chờ TTS nhiều giây. Khi TTS lỗi/quá hạn, OLED vẫn hiện nội dung thực và báo lỗi, không giả vờ đã nói.

`DEMO_FAST_CONFIRMATIONS=true` bật câu xác nhận tiếng Việt ngắn và dùng số đo mới từ sensor. Câu LED được tạo giọng sẵn lúc backend khởi động và chỉ phát xác nhận sau ACK. Các phản hồi khác cache theo văn bản/provider/voice, giới hạn 24 mục/8 MB. Ở chế độ local, Edge TTS cần Internet; đặt `AI_PROVIDER=gemini` để dùng Gemini phân tích âm thanh đa ngôn ngữ và Gemini TTS.

## Cấu trúc

- `platformio.ini`: PlatformIO, Arduino-ESP32 2.0.17, flash 16 MB và Octal PSRAM 8 MB.
- `include/config.h`: Wi-Fi, địa chỉ WebSocket, địa chỉ OLED, số LED, độ sáng và gain mic.
- `src/main.cpp`: khởi tạo I2S, xử lý mạng/âm thanh core 0; DHT22/OLED/LED core 1.
- `scripts/windows_paths.py`: rút gọn đường dẫn thư viện khi build trên Windows để tránh vượt giới hạn độ dài lệnh GCC; tự bỏ qua trên Linux/macOS.
- `backend/`: NestJS, Ollama/Vosk hoặc Gemini, Edge/Gemini TTS, xác thực WebSocket, chia trang OLED, thư viện nhạc, lịch sử PostgreSQL tùy chọn và kiểm thử.
- `backend/.env.example`: cấu hình provider local/Gemini, token và tùy chọn; xem hướng dẫn trong `backend/README.md`.

## Chạy backend trước

Yêu cầu Node.js 22 trở lên. Trong terminal tại `E:\AIoT\Code`:

```powershell
cd backend
npm.cmd ci
Copy-Item .env.example .env
```

Chỉ sao chép `.env.example` khi chưa có `.env`, tránh ghi đè cấu hình riêng. Chế độ hiện cấu hình trong `backend/.env` là `AI_PROVIDER=ollama`; không cần Gemini key. Để đổi sang Gemini, đặt `AI_PROVIDER=gemini` và thêm `GEMINI_API_KEY`. Tạo token ngẫu nhiên bằng lệnh dưới rồi đặt cùng giá trị cho `DEVICE_TOKEN` ở `.env` và `WS_TOKEN` ở `include/config.h`:

```powershell
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
npm.cmd run build
npm.cmd start
```

Hoặc chạy từ thư mục gốc bằng `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\start-local-xiaozhi.ps1"`; script khởi chạy Ollama và backend local.

Khi `AI_PROVIDER=gemini`, chọn `GEMINI_MODEL`/`GEMINI_TTS_MODEL` mà tài khoản hỗ trợ; lỗi 400/404 thường cần kiểm tra model/cấu hình, lỗi 401/403 kiểm tra key/quyền và lỗi 429 kiểm tra quota. Chế độ `ollama` dùng model local, không cần Gemini key. Không dán key vào source hoặc chat. `http://localhost:3000/health` chỉ xác nhận backend chạy.

Sau khi backend chạy, mở `http://localhost:3000/dashboard` trên laptop để dùng AIoT Control Desk. Bảng điều khiển hiển thị ESP32 online/offline, nhiệt độ, độ ẩm, trạng thái bận, cho bật/tắt LED WS2812B trên testboard qua lệnh WebSocket có ACK, và có ô nhập câu tự nhiên.

**Điều khiển bằng điện thoại & laptop qua MQTT / Web Mobile:**
- **Giao diện Web Mobile trên điện thoại:** Mở `http://<IP_LAN_BACKEND>:3000/mobile` từ bất kỳ điện thoại/laptop nào trong cùng mạng Wi-Fi để xem cảm biến nhiệt độ/độ ẩm real-time, bật/tắt đèn và chat với AI.
- **Cơ chế MQTT:** Backend tích hợp sẵn MQTT Broker nhúng tại cổng `1883` (hoặc kết nối broker ngoài qua `MQTT_BROKER_URL`). Bất kỳ ứng dụng MQTT nào trên điện thoại (như *IoT MQTT Panel*, *MQTT Dash*) hoặc laptop (*MQTT Explorer*) đều có thể điều khiển:
  - `aiot/led/set`: gửi `on` hoặc `off` để bật/tắt đèn LED.
  - `aiot/command`: gửi JSON `{"action":"led","state":"on"|"off"}` hoặc `{"action":"text","text":"Nhiệt độ phòng?"}` để ra lệnh AI.
  - `aiot/sensor`: nhận dữ liệu nhiệt độ và độ ẩm real-time từ cảm biến DHT22.
  - `aiot/state`: nhận trạng thái kết nối và trạng thái đèn LED.
  - `aiot/chat`: nhận transcript câu hỏi và câu trả lời của AI.
  - Test nhanh bằng script trên laptop: `node scripts/mqtt-client-demo.js [on|off|ask|monitor]`.

**Cấu hình Wi-Fi & IP Server bằng điện thoại (WiFiManager / Captive Portal):**
- **Không cần cắm cáp nạp lại code:** ESP32 lưu thông tin Wi-Fi và IP Server vào bộ nhớ Flash (NVS Preferences).
- **Cách vào chế độ cài đặt:**
  1. *Chủ động:* Nhấn giữ nút **BOOT (GPIO 0)** trên ESP32 trong **3 giây**.
  2. *Tự động:* Nếu bật nguồn mà không kết nối được Wi-Fi sau 25 giây, ESP32 sẽ tự động chuyển sang chế độ cài đặt.
- Màn hình OLED sẽ hiển thị thông báo: `CAU HINH WI-FI`, phát Wi-Fi tên `AIoT_Smart_Room`.
- Lấy điện thoại kết nối vào Wi-Fi `AIoT_Smart_Room`, trang web cấu hình tiếng Việt sẽ tự động bật lên (hoặc mở trình duyệt gõ `192.168.4.1`).
- Chọn mạng Wi-Fi trong phòng, nhập Mật khẩu, nhập IP Laptop đang chạy backend và bấm **"LƯU VÀ KẾT NỐI"**. ESP32 sẽ lưu vĩnh viễn và tự động kết nối vào mạng mới.
- Thiết bị có thể cấp nguồn hoàn toàn độc lập bằng củ sạc điện thoại 5V hoặc sạc dự phòng, không cần cắm vào máy tính.

Đây chưa phải công tắc đèn điện lưới; muốn điều khiển đèn phòng cần module relay phù hợp và phần cứng đấu nối riêng.

## Đấu dây

Các module và ESP32 phải nối chung GND.

| Module | Chân module | GPIO ESP32-S3 |
| --- | --- | --- |
| DHT22 | DATA | 10 |
| OLED SSD1306 128×64 I2C | SDA / SCL | 8 / 9 |
| WS2812B | DIN | 11 |
| INMP441 | WS / SCK / SD | 4 / 5 / 6 |
| MAX98357A | LRC / BCLK / DIN | 15 / 16 / 17 |

- INMP441 cấp 3.3 V, L/R nối GND để chọn kênh trái.
- DHT22 cấp 3.3 V; nếu dùng cảm biến rời, kéo DATA lên 3.3 V bằng điện trở 4.7–10 kΩ.
- OLED dùng nguồn 3.3 V và địa chỉ mặc định `0x3C`; sửa cấu hình nếu module dùng `0x3D`.
- MAX98357A dùng nguồn phù hợp module (thường 5 V); SD/EN phải ở trạng thái bật theo module. Loa nối giữa OUT+ và OUT−, không nối một đầu loa xuống GND. Firmware gửi cùng mẫu sang hai kênh I2S.
- WS2812B dùng nguồn phù hợp và đủ dòng; với nguồn 5 V nên dùng bộ chuyển mức logic 3.3→5 V. `LED_COUNT` mặc định 1, dành cho LED ngoài tại GPIO 11.

## Cấu hình và nạp

1. Mở thư mục này bằng VS Code có PlatformIO IDE.
2. Sửa `WIFI_SSID`, `WIFI_PASSWORD`, `WS_HOST`, `WS_PORT`, `WS_PATH`, `WS_TOKEN` trong `include/config.h`. Nếu chưa có file này, sao chép từ `include/config.example.h`. Wi-Fi cần hỗ trợ 2.4 GHz. `WS_HOST` chỉ chứa IP/hostname, không có `ws://`; dùng IP LAN của máy chạy backend, không dùng `localhost`. Cho phép backend qua Windows Firewall trên mạng Private nếu cần.
3. Kết nối ESP32-S3 N16R8 qua USB, chọn environment `esp32-s3-n16r8`, bấm Build rồi Upload.
4. Mở Serial Monitor ở 115200 baud. Firmware in dung lượng flash/PSRAM và IP khi nối Wi-Fi.

Lệnh tương đương trong terminal PlatformIO:

```powershell
pio run
pio run --target upload
pio device monitor --baud 115200
```

Nếu cần chọn cổng: `pio run --target upload --upload-port COM5` (thay COM5 bằng cổng thực tế). Nếu không vào chế độ nạp: giữ BOOT, nhấn rồi thả RESET, thả BOOT và thử Upload lại. Cấu hình Serial hiện dùng USB CDC native của ESP32-S3; dùng cổng USB native để xem log. Nếu board chỉ dùng cầu USB-UART, đổi `ARDUINO_USB_CDC_ON_BOOT` thành `0`.

`include/config.h` và `backend/.env` đã được thêm vào `.gitignore`. Không chia sẻ hai file chứa Wi-Fi/token; bàn giao các file example. Token phải khớp giữa firmware và backend.

## Giao thức backend bắt buộc

Firmware dùng **WebSocket RFC 6455 thuần** qua `ws://HOST:PORT/aiot`, có header `Authorization: Bearer <WS_TOKEN>`. Backend NestJS đi kèm dùng thư viện `ws`, không dùng Socket.IO. Đây là giao thức tùy chỉnh; không có wrapper `{event,data}`. Kết nối ESP32→backend hiện chưa mã hóa, chỉ dùng trong LAN tin cậy; không mở port này trực tiếp ra Internet. Backend gọi Ollama loopback ở chế độ local hoặc Gemini qua HTTPS. Token chung chỉ phù hợp bản mẫu; triển khai nhiều thiết bị cần token riêng, TLS và quản lý quyền.

Sau khi kết nối, thiết bị gửi text JSON:

```json
{"type":"hello","device_id":"MAC","audio":{"format":"pcm_s16le","sample_rate":16000,"channels":1},"max_audio_chunk_bytes":4096,"led_enabled":true}
```

Khi trạng thái `Listen`, thiết bị gửi binary **PCM signed 16-bit little-endian, mono, 16000 Hz**, tối đa 256 mẫu/512 byte mỗi lần. Backend gom đoạn âm thanh bằng ngưỡng RMS, kết thúc sau khoảng 900 ms im lặng hoặc tối đa 12 giây. Chế độ local gửi WAV tới Vosk tiếng Việt rồi đưa transcript qua Ollama; chế độ Gemini gửi WAV trực tiếp cho Gemini để tự nhận ngôn ngữ, phiên âm, chọn ý định và trả lời. Đây không phải nhận dạng streaming từng từ. Mỗi 2 giây thiết bị gửi thông số:

```json
{"type":"sensor","valid":true,"temperature":28.5,"humidity":65.0,"uptime_ms":12345}
```

Nếu DHT22 đọc lỗi, `valid=false` và hai giá trị là `null`.

Server gửi text JSON để điều khiển:

```json
{"type":"command","id":"unique-command-id","device":"led","action":"on"}
{"type":"command","id":"unique-command-id","device":"led","action":"off"}
{"type":"command","device":"led","action":"color","r":0,"g":80,"b":255}
{"type":"chat","reply":"Xin chào"}
{"type":"transcript","text":"Nhiệt độ trong phòng bao nhiêu?","language":"vi"}
{"type":"status","state":"thinking"}
{"type":"status","state":"listening"}
{"type":"audio_start","mode":"speech"}
{"type":"audio_end"}
{"type":"audio_stop"}
```

Các dòng trên là các message riêng biệt. `led_enabled` trong `hello` đồng bộ lại trạng thái logic sau khi backend hoặc WebSocket khởi động lại; firmware cũ không có trường này sẽ được hiển thị là chưa xác định cho tới ACK kế tiếp. ACK có cùng `id`, `device`, `action` và trạng thái `enabled`; backend chỉ xác nhận thành công sau khi nhận ACK đúng trong 3 giây. Đây là trạng thái phần mềm mà firmware báo, không phải phép đo quang học xác nhận LED có sáng vật lý hay không. Lệnh sai trả `{"type":"error","message":"..."}`. `reply` và `transcript` được in Serial; backend còn gửi `display` chứa bitmap để hiển thị chúng trên OLED. Firmware vẫn hỗ trợ JSON `color`, còn voice assistant hiện xử lý bật/tắt theo yêu cầu.

Mỗi message `display` có `batch`, `index` (từ 0), `total` (1–32), `bitmap` base64 của 768 byte. Bitmap row-major 128×48, bit cao trước; phần này nằm dưới 16 pixel header. Trang tự đổi sau 4 giây và lặp lại đến hội thoại tiếp theo. Header luôn có nhiệt độ/độ ẩm, trạng thái và LED ON/OFF. Font chạy trên máy backend: tiếng Việt/Anh đã có bản xem trước; ngôn ngữ khác cần font tương ứng trên server hoặc `FONT_DIR`/`OLED_FONT`. Không thể cam kết mọi hệ chữ khi máy thiếu font.

Âm thanh trả về là binary **PCM16 LE / mono / 16 kHz**. Backend chuyển đầu ra Edge TTS hoặc Gemini TTS sang PCM16 rồi gửi 640 byte mỗi 20 ms. Firmware không giải mã MP3/WAV. Mỗi WebSocket message hoàn chỉnh có số byte chẵn, tối đa 4096 byte; không fragmentation. `audio_start` mở lượt phát, `audio_end` cho phép bộ đệm phát hết, `audio_stop` hủy ngay. Mic bị tạm ngắt khi server bận hoặc đang phát để hạn chế tự nghe lại. Nếu TTS lỗi, câu trả lời chữ vẫn hiển thị và có thông báo Audio unavailable.

## Cách sử dụng và nhạc

- Khi OLED hiện `Listen`, thử “Bật đèn”, “Tắt đèn”, “Nhiệt độ và độ ẩm trong phòng bao nhiêu?”. Chế độ local dùng ASR tiếng Việt; chọn Gemini để thử giọng nói đa ngôn ngữ. Nói rõ, từng lượt; chất lượng nhận diện còn phụ thuộc mic và tiếng ồn.
- Khi muốn hủy xử lý hoặc dừng nhạc/giọng nói, **nhấn rồi thả BOOT khi board đang chạy**, không nhấn RESET. Đợi `Listen` rồi nói tiếp. Không nhận lệnh giọng nói trong lúc phát nhạc vì chế độ half-duplex.
- Để phát nhạc, thêm file WAV **PCM16 mono 16 kHz** vào `backend/music`, tối đa 10 MB/file, và đăng ký ID/tên/file trong `backend/music/catalog.json`. Ví dụ trong `backend/README.md`. Danh mục ban đầu rỗng; hệ thống sẽ không tự tìm bài trên YouTube/Spotify.
- Nếu có FFmpeg, chuyển file của nhóm: `ffmpeg -i input.mp3 -ac 1 -ar 16000 -c:a pcm_s16le backend/music/song.wav`. Chất lượng 16 kHz mono chủ yếu phục vụ lời nói, không phải hi-fi.

## Hành vi và kiểm tra trên board

- Mất kết nối: LED đỏ nếu LED đang bật; khi đã ra lệnh tắt thì LED vẫn tắt dù mất mạng. Trạng thái offline hiện trên OLED. Khi phát, LED đang bật nhấp nháy.
- DHT22 đọc mỗi 2 giây. OLED làm mới mỗi 200 ms, tự chuyển trang. Lỗi DHT không làm dừng chương trình; dữ liệu cảm biến cũ quá 8 giây không được đưa làm số đo hiện tại cho AI.
- Wi-Fi/WebSocket tự kết nối lại. Không có backend, cảm biến/OLED vẫn chạy nhưng chưa thể nhận diện giọng nói.
- Mic được đọc/xả liên tục nhưng chỉ gửi khi server sẵn sàng, tránh phát lại mẫu cũ. Có timeout 90 giây để tự kết nối lại nếu server treo.
- Kiểm tra flash ~16 MB và PSRAM ~8 MB trong log; thử ngắt/kết nối lại Wi-Fi, gửi on/off/color, rồi phát PCM mẫu trước khi nối pipeline AI.
- Việc biên dịch chỉ xác nhận mã nguồn và thư viện tương thích. Âm lượng mic/loa, nguồn điện, timing âm thanh thực tế cần kiểm tra trên phần cứng.

## Kiểm thử và giới hạn xác nhận

`npm.cmd test` trong `backend` kiểm tra VAD, WAV/resampling, bitmap OLED, xác thực, ACK, lịch sử, giới hạn nhạc và một vòng WebSocket với AI giả lập. `npm.cmd run build` kiểm tra TypeScript; `pio run` kiểm tra firmware. Chạy `npx.cmd tsx scripts/preview-oled.ts` trong `backend` để tạo `.pio/oled-preview.png`.

Các bài kiểm thử đơn vị không gọi Gemini thật; đã chạy smoke test local Qwen/Vosk cho lệnh đèn và câu hỏi cảm biến. Trước bàn giao cần thử âm thanh thực trên board và đo/điều chỉnh `VAD_RMS`/`MIC_SHIFT`. Không lưu audio thô vào DB; nếu bật PostgreSQL, bản phiên âm và câu trả lời được lưu. Không đưa key thật vào bản bàn giao.

Tham khảo: [Gemini audio input](https://ai.google.dev/gemini-api/docs/generate-content/audio), [Gemini TTS](https://ai.google.dev/gemini-api/docs/generate-content/speech-generation), [PlatformIO](https://docs.platformio.org/en/latest/platforms/espressif32.html).
