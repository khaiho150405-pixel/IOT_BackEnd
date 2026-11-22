# Trợ lý giọng nói AI + ESP32-S3 N16R8 (AIoT Smart Room)

ESP32-S3 thu âm, hiển thị OLED, bật/tắt LED và đo nhiệt độ/độ ẩm. Toàn bộ phần AI chạy trên **máy AI worker** (laptop/PC Windows chạy backend):

```
ESP32-S3 ──WebSocket (PCM 16 kHz)──▶ Backend NestJS (cổng 3000)
                                      ├─ Voice bridge Python (127.0.0.1:8010)
                                      │    ├─ Nhận dạng tiếng Việt: PhoWhisper-base (VinAI), CPU int8
                                      │    ├─ Nhận biết + nhận dạng tiếng Anh: Whisper base
                                      │    └─ Giọng đọc: Edge TTS (Internet) → giọng Windows "Microsoft An" (offline) khi Edge lỗi
                                      ├─ Ollama + Qwen 2.5 3B (127.0.0.1:11434): hiểu câu nói, phân loại ý định, trò chuyện
                                      ├─ Dashboard /dashboard, Web Mobile /mobile
                                      └─ MQTT broker nhúng (cổng 1883)
```

Mỗi lượt hội thoại: nói một câu, dừng ~1 giây; hệ thống nhận dạng (~1 s), Qwen phân tích (~0,7–2,5 s), rồi ESP32 nói câu trả lời (tổng ~2,5–4 s). Qwen phân loại câu thành trò chuyện, bật/tắt đèn, hỏi nhiệt độ/độ ẩm, phát/dừng nhạc; code kiểm tra lại quyết định (số đo luôn lấy từ cảm biến, lệnh đèn phải có động từ bật/tắt, chỉ phát bài có thật). Phép tính nói ("một cộng một bằng mấy") được giải chính xác bằng code. Hội thoại theo lượt (half-duplex): chưa có wake word và khử tiếng vọng.

> Hướng dẫn rút gọn để bật/tắt hằng ngày: [KHOI-DONG-THU-CONG.md](KHOI-DONG-THU-CONG.md).

## Cấu trúc thư mục

| Đường dẫn | Nội dung |
| --- | --- |
| `src/main.cpp`, `platformio.ini` | Firmware ESP32-S3 (Arduino-ESP32 2.0.17, flash 16 MB, PSRAM 8 MB) |
| `include/config.example.h` | Mẫu cấu hình firmware → sao chép thành `include/config.h` (không commit) |
| `backend/` | Backend NestJS, voice bridge, dashboard, kiểm thử |
| `backend/.env.example` | Mẫu cấu hình backend → sao chép thành `backend/.env` (không commit) |
| `backend/scripts/local-voice-bridge.py` | Nhận dạng giọng nói + tổng hợp giọng (backend tự khởi chạy) |
| `backend/requirements-local-voice.txt` | Gói Python cho voice bridge |
| `backend/requirements-model-convert.txt` | Gói Python chỉ dùng một lần để tạo model PhoWhisper |
| `scripts/setup-phowhisper.py` | Tải và chuyển đổi PhoWhisper-base → `models/phowhisper-base-ct2` |
| `scripts/start-local-xiaozhi.ps1` | Kiểm tra cấu hình, bật Ollama và chạy backend bằng một lệnh |
| `scripts/fix-hotspot-firewall.ps1` | Mở cổng 3000 cho ESP32 khi dùng Mobile Hotspot của Windows |
| `models/` | Model đã chuyển đổi (tạo ra trên máy, không commit) |

## 1. Cài đặt máy AI worker (Windows 10/11, làm một lần)

Cấu hình đã kiểm chứng: Windows 11, CPU Intel i5-10300H (4 nhân), RAM 16 GB, không cần GPU. Cần khoảng 5 GB đĩa trống và Internet cho lần cài đầu.

| Phần mềm | Phiên bản đã kiểm chứng | Dùng cho |
| --- | --- | --- |
| Git | bất kỳ | lấy code |
| Node.js | ≥ 22 (đang dùng 24.19) | backend |
| Python | 3.10–3.12 (đang dùng 3.12.4) | voice bridge |
| FFmpeg | 9.x (Gyan build) | chuyển MP3 của Edge TTS sang PCM |
| Ollama | 0.40.x + model `qwen2.5:3b` (~1,9 GB) | mô hình ngôn ngữ |
| Giọng Windows "Microsoft An" (tiếng Việt) | gói giọng nói Windows | giọng đọc offline khi Edge TTS lỗi |
| VS Code + PlatformIO (Core 6.x) | chỉ khi cần nạp firmware | firmware ESP32 |

### Bước 1 – Cài phần mềm

Mở **PowerShell** và chạy:

```powershell
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Python.Python.3.12 -e
winget install --id Gyan.FFmpeg.Shared -e
winget install --id Ollama.Ollama -e
```

Đóng và mở lại PowerShell để nhận PATH mới, rồi kiểm tra:

```powershell
git --version; node -v; py -3.12 --version; ffmpeg -version | Select-Object -First 1; ollama --version
```

### Bước 2 – Tải model ngôn ngữ Qwen

```powershell
ollama pull qwen2.5:3b
```

### Bước 3 – Cài giọng đọc tiếng Việt offline của Windows

**Settings → Time & language → Speech → Manage voices → Add voices → Tiếng Việt (Vietnamese)**. Kiểm tra (phải in ra `MSTTS_V110_viVN_An`):

```powershell
Get-ChildItem HKLM:\SOFTWARE\Microsoft\Speech_OneCore\Voices\Tokens | Where-Object PSChildName -match viVN | Select-Object -ExpandProperty PSChildName
```

Thiếu giọng này hệ thống vẫn chạy, nhưng khi Edge TTS lỗi sẽ phải dùng giọng tiếng Anh đọc tiếng Việt.

### Bước 4 – Lấy code và cài thư viện backend

```powershell
git clone https://github.com/khaiho150405-pixel/IOT_BackEnd.git AIoT
cd AIoT\backend
npm.cmd ci
cd ..
```

### Bước 5 – Cài gói Python cho voice bridge

```powershell
py -3.12 -m pip install -r backend\requirements-local-voice.txt
py -3.12 -c "import sys; print(sys.executable)"
```

Ghi lại đường dẫn `python.exe` in ra ở lệnh thứ hai (ví dụ `C:\Users\<tên>\AppData\Local\Programs\Python\Python312\python.exe`) để điền vào `LOCAL_VOICE_PYTHON` ở bước 7.

### Bước 6 – Tạo model nhận dạng tiếng Việt PhoWhisper (một lần, ~10 phút)

Tải [vinai/PhoWhisper-base](https://huggingface.co/vinai/PhoWhisper-base) (~290 MB, giấy phép BSD-3) và chuyển sang CTranslate2 int8 (~80 MB):

```powershell
py -3.12 -m pip install torch --index-url https://download.pytorch.org/whl/cpu
py -3.12 -m pip install -r backend\requirements-model-convert.txt
py -3.12 scripts\setup-phowhisper.py
```

Kết quả nằm ở `models\phowhisper-base-ct2` (đã có trong `.gitignore`). Có thể gỡ `torch`/`transformers` sau bước này. Lần chạy backend đầu tiên còn tự tải Whisper `base` (~150 MB, dùng cho tiếng Anh) vào cache Hugging Face.

### Bước 7 – Cấu hình backend

```powershell
Copy-Item backend\.env.example backend\.env
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

Mở `backend\.env` và sửa:

| Biến | Giá trị |
| --- | --- |
| `LOCAL_VOICE_PYTHON` | đường dẫn `python.exe` từ bước 5 |
| `LOCAL_WHISPER_MODEL` | giữ `../models/phowhisper-base-ct2` (tính từ thư mục `backend`) |
| `DEVICE_TOKEN` | chuỗi ngẫu nhiên vừa tạo; **phải trùng** `WS_TOKEN` trong `include/config.h` của firmware |
| `VAD_RMS`, `SPEAKER_VOLUME` | giữ `325` và `0.5` nếu firmware dùng `MIC_SHIFT = 17` |

Chỉ sao chép `.env.example` khi chưa có `.env`. Không commit `.env` và không gửi token/key qua chat.

### Bước 8 – Mở tường lửa cho ESP32

Lần đầu chạy backend, Windows hỏi quyền mạng cho Node.js: chọn **Private networks**. Nếu ESP32 kết nối qua **Mobile Hotspot** của laptop, chạy (PowerShell **Run as Administrator**):

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\fix-hotspot-firewall.ps1
```

## 2. Chạy hệ thống

Từ thư mục gốc repo:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-local-xiaozhi.ps1
```

Script kiểm tra `.env`, Python, gói Python, model PhoWhisper, tự bật Ollama nếu chưa chạy rồi khởi động backend (dừng bằng `Ctrl+C`). Chỉ kiểm tra cấu hình mà không chạy: thêm `-CheckOnly`.

Hoặc chạy thủ công:

```powershell
cd backend
npm.cmd run build
npm.cmd start
```

Backend sẵn sàng khi log hiện (5–90 giây tùy máy đã nạp model chưa):

```
Local Whisper model ../models/phowhisper-base-ct2 ready.
Local voice bridge ready at http://127.0.0.1:8010
Local LLM ready; kept loaded for the demo.
[AIoT] Server is listening at http://0.0.0.0:3000
```

Cấp nguồn ESP32: log hiện `Device hello accepted: <MAC>`, OLED hiện `Listen` là có thể nói.

**Lần đầu tiên:** mở `http://localhost:3000/dashboard` **trên chính máy AI worker** và tạo tài khoản **Chủ nhà** (chỉ làm được từ máy này, và chỉ khi chưa có tài khoản nào). Sau đó dùng khu "Người dùng & phân quyền" để tạo tài khoản cho người khác.

### Kiểm tra máy AI worker đã giống hệ thống gốc

| Kiểm tra | Kết quả mong đợi |
| --- | --- |
| `cd backend; npm.cmd test` | toàn bộ test `pass`, `fail 0` |
| `http://localhost:3000/health` | `{"status":"ok",...}` |
| `http://localhost:3000/dashboard` | đăng nhập chủ nhà, thấy ESP32 online, nhiệt độ/độ ẩm, nút bật/tắt LED |
| Nói "Bật đèn lên" | log `[Qwen] ... intent=led_on`, LED bật, ESP32 nói "Em đã bật đèn, đại ca." |
| Nói "Một cộng một bằng mấy" | ESP32 trả lời "1 cộng 1 bằng 2" |

Trên điện thoại cùng mạng: `http://<IP máy AI worker>:3000/mobile` (hoặc `/dashboard`), đăng nhập bằng tài khoản được cấp.

## Tài khoản và phân quyền

Mọi API điều khiển, trang `/dashboard`, `/mobile` và broker MQTT đều yêu cầu đăng nhập; mỗi tài khoản chỉ thấy và điều khiển các thiết bị được cấp. Lệnh bằng **giọng nói** tại chỗ vẫn hoạt động không cần tài khoản (người nói ở trong phòng) và được ghi nhật ký với nguồn "Giọng nói".

| Vai trò | Xem thiết bị | Điều khiển | Chat với AI | Quản lý người dùng | Thiết bị, phòng | Nhật ký |
| --- | --- | --- | --- | --- | --- | --- |
| **Chủ nhà** (1 người) | tất cả | tất cả | tất cả | tất cả (trừ chính mình) | ✅ | tất cả |
| **Quản trị** | tất cả | tất cả | tất cả | thành viên và khách | ✅ | tất cả |
| **Thành viên** | được cấp | nếu được cấp | nếu được cấp | ❌ | ❌ | của mình |
| **Khách** | được cấp | nếu được cấp | ❌ không bao giờ | ❌ | ❌ | của mình |

- Quyền cấp theo **từng thiết bị** hoặc **theo phòng** (mọi thiết bị trong phòng). ESP32 tự xuất hiện trong danh sách khi kết nối lần đầu; chủ nhà/quản trị đặt tên và gán phòng.
- **Khách** luôn có hạn dùng (mặc định 24 giờ, gia hạn được); hết hạn thì không đăng nhập được.
- Đăng nhập cấp **access token 15 phút** và **refresh token 30 ngày** (xoay vòng; dùng lại token cũ sẽ thu hồi cả phiên). Đổi mật khẩu, đổi vai trò hoặc khóa tài khoản làm mọi phiên cũ mất hiệu lực. Sai mật khẩu 5 lần trong 15 phút: khóa đăng nhập 5 phút.
- Mật khẩu băm bằng scrypt; dữ liệu nằm trong `backend/data/aiot.sqlite` (hoặc PostgreSQL nếu đặt `DATABASE_URL`), khóa ký token trong `backend/data/auth-secret`. **Sao lưu thư mục `backend/data/`**, không commit nó (đã có trong `.gitignore`).
- **MQTT:** đăng nhập bằng cùng tên/mật khẩu. Thành viên dùng topic theo thiết bị `aiot/device/<MAC>/led/set`, `aiot/device/<MAC>/command`, `aiot/device/<MAC>/sensor`…; topic tổng hợp (`aiot/sensor`, `aiot/#`) chỉ dành cho chủ nhà/quản trị. Lệnh không có quyền bị bỏ qua (không ngắt kết nối) và ghi nhật ký "Bị từ chối".
- **Nhật ký** ghi: ai, lúc nào, nguồn (Web, App, Giọng nói, MQTT), thao tác, thiết bị, kết quả.
- Quên mật khẩu chủ nhà: dừng backend, đổi tên `backend/data/aiot.sqlite` (dữ liệu cũ được giữ lại để tra cứu), khởi động lại và tạo chủ nhà mới.

API chính (gửi `Authorization: Bearer <accessToken>`; app di động gửi thêm `X-Client: app`):

| API | Quyền |
| --- | --- |
| `GET /api/auth/status`, `POST /api/auth/login`, `/refresh`, `/logout` | công khai |
| `POST /api/auth/setup` | chỉ từ máy chạy backend, khi chưa có tài khoản |
| `GET /api/auth/me`, `POST /api/auth/password`, `GET /api/devices`, `GET /api/rooms` | đã đăng nhập |
| `POST /api/devices/:id/led` · `POST /api/devices/:id/text` | quyền điều khiển · quyền chat trên thiết bị |
| `GET/POST /api/users`, `PATCH/DELETE /api/users/:id`, `PUT /api/users/:id/permissions` | chủ nhà/quản trị |
| `PATCH /api/devices/:id`, `POST/DELETE /api/rooms` | chủ nhà/quản trị |
| `GET /api/audit` | đã đăng nhập (người thường chỉ thấy của mình) |

Lưu ý: hiện kết nối vẫn là HTTP thường trong mạng nội bộ. Trước khi mở ra Internet cần HTTPS/WSS (giai đoạn 3 của lộ trình).

## 3. Firmware ESP32-S3

1. Sao chép `include\config.example.h` thành `include\config.h` rồi sửa `WIFI_SSID`, `WIFI_PASSWORD` (Wi-Fi 2.4 GHz), `WS_HOST` (IP LAN của máy AI worker, không dùng `localhost`, không có `ws://`), `WS_PORT=3000`, `WS_TOKEN` (trùng `DEVICE_TOKEN`).
2. Giữ `MIC_SHIFT = 17` (đi cùng `VAD_RMS=325`). Giá trị 16 làm tiếng bị méo khi nói gần micro.
3. Cắm ESP32-S3 vào cổng USB native, mở thư mục repo bằng VS Code + PlatformIO, chọn environment `esp32-s3-n16r8`, **Build** rồi **Upload**. Lệnh tương đương:

```powershell
pio run -e esp32-s3-n16r8
pio run -e esp32-s3-n16r8 -t upload --upload-port COM6
pio device monitor --baud 115200
```

Thay `COM6` bằng cổng thực tế (Device Manager → Ports). Nếu không vào chế độ nạp: giữ BOOT, nhấn rồi thả RESET, thả BOOT rồi Upload lại. Lưu ý: mở Serial Monitor trên cổng USB native sẽ làm board khởi động lại. Nếu board chỉ có cầu USB-UART, đổi `ARDUINO_USB_CDC_ON_BOOT` thành `0` trong `platformio.ini`.

Firmware đọc cả hai kênh I2S của INMP441 và tự chọn kênh có tín hiệu; backend in `microphone slot N` khi nhận được.

**Đổi Wi-Fi/IP không cần nạp lại:** giữ nút **BOOT (GPIO 0) 3 giây** (hoặc để ESP32 tự vào chế độ này khi không nối được Wi-Fi sau 25 giây). OLED hiện `CAU HINH WI-FI` và phát Wi-Fi `AIoT_Smart_Room`. Dùng điện thoại kết nối vào, trang cấu hình tự mở (hoặc vào `192.168.4.1`), chọn Wi-Fi, nhập mật khẩu và IP máy AI worker, bấm **LƯU VÀ KẾT NỐI**. Cấu hình lưu trong flash.

## 4. Đấu dây và nguồn điện

Các module và ESP32 phải nối chung GND.

| Module | Chân module | GPIO ESP32-S3 |
| --- | --- | --- |
| DHT22 | DATA | 10 |
| OLED SSD1306 128×64 I2C | SDA / SCL | 8 / 9 |
| WS2812B | DIN | 11 |
| INMP441 | WS / SCK / SD | 4 / 5 / 6 |
| MAX98357A | LRC / BCLK / DIN | 15 / 16 / 17 |

- INMP441 cấp 3.3 V, L/R nối GND. **Lỗ thu âm nằm ở mặt dưới bo** — không cắm úp sát breadboard, hướng lỗ về phía người nói, nói cách 5–30 cm.
- DHT22 cấp 3.3 V; cảm biến rời cần điện trở kéo lên 4.7–10 kΩ ở DATA.
- OLED 3.3 V, địa chỉ `0x3C` (sửa cấu hình nếu là `0x3D`).
- MAX98357A thường cấp 5 V; loa nối giữa OUT+ và OUT− (không nối loa xuống GND).
- WS2812B: nguồn đủ dòng; với 5 V nên có chuyển mức logic 3.3→5 V.

**Nguồn điện (quan trọng):** khi cấp nguồn chỉ từ cổng USB laptop, ESP32 từng tự khởi động lại ngay sau khi loa phát (sụt áp do MAX98357A) và micro bị nhiễu ù ~85 Hz. Nên dùng củ sạc 5 V ≥ 2 A, thêm tụ 470–1000 µF sát nguồn MAX98357A, tụ 100 nF + 10 µF sát VDD–GND của INMP441, dây micro ngắn và đặt xa ampli. Backend tự giảm âm lượng (`SPEAKER_VOLUME=0.5`) và lọc tiếng ù dưới 120 Hz; log `Device ... rebooted` báo khi ESP32 bị reset.

Đây chưa phải công tắc đèn điện lưới; điều khiển đèn phòng cần module relay và đấu nối riêng.

## 5. Sử dụng

- Khi OLED hiện `Listen`, thử: "Xin chào em", "Bật đèn lên", "Tắt đèn đi", "Nhiệt độ trong phòng bao nhiêu", "Kể chuyện cười đi", "Làm thơ về mùa thu", "Ba cộng bốn bằng mấy", "Hello".
- AI làm ngay yêu cầu, không hỏi lại; chỉ hỏi lại khi câu nghe sai đến mức không đoán được ý, hoặc với câu phủ định về đèn ("Đừng tắt đèn").
- Hủy lượt đang xử lý hoặc dừng nói/nhạc: **nhấn rồi thả BOOT** khi board đang chạy (không nhấn RESET).
- Nhạc: thêm file WAV PCM16 mono 16 kHz (≤ 10 MB) vào `backend/music` và khai báo trong `backend/music/catalog.json` (hoặc đặt file `.mp4` trong `backend/music/mp4`). Chuyển đổi: `ffmpeg -i input.mp3 -ac 1 -ar 16000 -c:a pcm_s16le backend/music/song.wav`. Thư viện trống thì AI nói thật là chưa có bài.
- **MQTT** (broker nhúng cổng 1883, đăng nhập bằng tài khoản; xem mục Tài khoản và phân quyền), dùng được với IoT MQTT Panel, MQTT Dash, MQTT Explorer:
  - `aiot/device/<MAC>/led/set`: gửi `on`/`off`.
  - `aiot/device/<MAC>/command`: `{"action":"led","state":"on"}` hoặc `{"action":"text","text":"Nhiệt độ phòng?"}`.
  - `aiot/device/<MAC>/sensor`, `.../state`, `.../chat`: nhận cảm biến, trạng thái, hội thoại.
  - Thử nhanh (tài khoản chủ nhà/quản trị): `$env:MQTT_USER='...'; $env:MQTT_PASS='...'; node backend/scripts/mqtt-client-demo.js [on|off|ask|monitor]`.
  - Broker ngoài (`MQTT_BROKER_URL`) không được backend kiểm soát quyền; hãy cấu hình quyền trên broker đó.

## 6. Xử lý sự cố

| Hiện tượng | Cách xử lý |
| --- | --- |
| `Port 3000 is already in use` / `A local voice bridge is already running` | Backend cũ còn chạy: `Get-CimInstance Win32_Process \| Where-Object { $_.CommandLine -like '*dist/src/main.js*' -or $_.CommandLine -like '*local-voice-bridge.py*' } \| ForEach-Object { Stop-Process -Id $_.ProcessId -Force }` |
| `Local voice Python is missing` | Sai `LOCAL_VOICE_PYTHON` trong `backend/.env` (xem bước 5) |
| `Whisper model directory is incomplete` | Chưa chạy `scripts\setup-phowhisper.py`, hoặc sai `LOCAL_WHISPER_MODEL` |
| `FFmpeg is required` | Cài FFmpeg (bước 1) hoặc đặt `FFMPEG_EXE` trỏ tới `ffmpeg.exe` |
| AI trả lời "đang suy nghĩ hơi chậm" | Ollama chưa chạy: `ollama serve`, kiểm tra `ollama list` có `qwen2.5:3b` |
| Giọng đọc chậm, log `Edge-TTS failed` | Edge TTS (miễn phí) đang chập chờn; hệ thống tự dùng giọng "Microsoft An" trong 5 phút. Cần cài giọng ở bước 3 |
| ESP32 không kết nối | Cùng mạng 2.4 GHz; `WS_HOST` đúng IP máy AI worker; token trùng; mở tường lửa (bước 8) |
| ESP32 tự khởi động lại khi đang nói (`Device ... rebooted`) | Nguồn yếu: xem mục Nguồn điện; tạm giảm `SPEAKER_VOLUME` xuống `0.3` |
| Nhận dạng ra chữ vô nghĩa / "em nghe chưa rõ" | Nói gần micro hơn (5–30 cm), lỗ micro không bị che, giảm nhiễu nguồn. Log `Voice capture: ... peak=` nên đạt ~3000–15000; `peak=32767` là quá to (méo) |
| Thu nhầm tiếng nền liên tục | Tăng `VAD_RMS` (ví dụ 450) trong `backend/.env` |

## Giao thức backend ↔ ESP32

Firmware dùng **WebSocket RFC 6455 thuần** qua `ws://HOST:PORT/aiot`, header `Authorization: Bearer <WS_TOKEN>` (thư viện `ws`, không dùng Socket.IO, không có wrapper `{event,data}`). Kết nối chưa mã hóa — chỉ dùng trong LAN tin cậy, không mở cổng ra Internet. Khi một thiết bị kết nối lại (ví dụ sau khi khởi động lại), kết nối mới thay thế kết nối cũ ngay.

Sau khi kết nối, thiết bị gửi:

```json
{"type":"hello","device_id":"MAC","audio":{"format":"pcm_s16le","sample_rate":16000,"channels":1},"max_audio_chunk_bytes":4096,"led_enabled":true}
```

Khi ở trạng thái `Listen`, thiết bị gửi binary **PCM signed 16-bit LE, mono, 16 kHz**, tối đa 256 mẫu mỗi gói. Backend lọc tiếng ù (high-pass 120 Hz), gom câu bằng ngưỡng RMS (`VAD_RMS`), kết thúc sau `VAD_SILENCE_MS` im lặng hoặc tối đa `VAD_MAX_MS`, gửi WAV cho voice bridge nhận dạng rồi đưa chữ qua Qwen. Mỗi 2 giây thiết bị gửi:

```json
{"type":"sensor","valid":true,"temperature":28.5,"humidity":65.0,"uptime_ms":12345,"mic_slot":0,"mic_scores":[181994,0]}
```

DHT22 lỗi thì `valid=false` và hai giá trị là `null`. `uptime_ms` giảm nghĩa là thiết bị vừa khởi động lại.

Server gửi (mỗi dòng là một message riêng):

```json
{"type":"command","id":"unique-command-id","device":"led","action":"on"}
{"type":"command","device":"led","action":"color","r":0,"g":80,"b":255}
{"type":"chat","reply":"Xin chào"}
{"type":"transcript","text":"Nhiệt độ trong phòng bao nhiêu?","language":"vi"}
{"type":"status","state":"thinking"}
{"type":"status","state":"listening"}
{"type":"audio_start","id":"...","mode":"speech"}
{"type":"audio_end","id":"..."}
{"type":"audio_stop"}
```

ACK lệnh LED phải có cùng `id`, `device`, `action` và `enabled` trong 3 giây thì backend mới xác nhận thành công (trạng thái phần mềm firmware báo, không phải đo ánh sáng thật). ESP32 gửi `{"type":"playback_done","id":"..."}` khi loa phát hết; backend mới gửi `listening`. Message `display` chứa bitmap OLED (`batch`, `index`, `total` 1–32, `bitmap` base64 768 byte, 128×48 row-major, bit cao trước) nằm dưới 16 pixel header nhiệt độ/độ ẩm/trạng thái.

Âm thanh trả về là binary **PCM16 LE mono 16 kHz**, 640 byte mỗi 20 ms (firmware không giải mã MP3/WAV). Mỗi message có số byte chẵn, tối đa 4096 byte, không fragmentation. Mic tạm tắt khi server bận hoặc đang phát để tránh tự nghe lại.

## Kiểm thử

- `cd backend; npm.cmd test`: VAD, lọc high-pass, âm lượng loa, WAV/resampling, bitmap OLED, xác thực, ACK, kết nối lại, lịch sử, nhạc, phân loại ý định Qwen (giả lập), phép tính nói, giọng dự phòng không bị cache, và một vòng WebSocket đầy đủ với AI giả lập.
- `npm.cmd run build`: kiểm tra TypeScript; `pio run`: kiểm tra firmware.
- `npx.cmd tsx scripts/preview-oled.ts` (trong `backend`): tạo ảnh xem trước OLED.
- Test đơn vị không gọi Ollama/Gemini thật. Độ chính xác nhận dạng phụ thuộc micro, khoảng cách và nguồn điện: hãy thử bằng giọng thật trên board sau khi cài.

Chế độ Gemini (tùy chọn, cần Internet): đặt `AI_PROVIDER=gemini` và `GEMINI_API_KEY` trong `backend/.env`. Lỗi 400/404 kiểm tra model, 401/403 kiểm tra key, 429 kiểm tra quota. Tham khảo: [Gemini audio](https://ai.google.dev/gemini-api/docs/generate-content/audio), [Gemini TTS](https://ai.google.dev/gemini-api/docs/generate-content/speech-generation), [PlatformIO ESP32](https://docs.platformio.org/en/latest/platforms/espressif32.html).
