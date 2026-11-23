# Trợ lý giọng nói AI + ESP32-S3 N16R8 (AIoT Smart Room)

ESP32-S3 thu âm, hiển thị OLED, bật/tắt LED và đo nhiệt độ/độ ẩm. Toàn bộ phần AI chạy trên **máy AI worker** (laptop/PC Windows chạy backend):

```
ESP32-S3 ──WebSocket (PCM 16 kHz)──▶ Backend NestJS (cổng 3100)
                                      ├─ Voice bridge Python (127.0.0.1:8010)
                                      │    ├─ Nhận dạng tiếng Việt: PhoWhisper-base (VinAI), CPU int8
                                      │    ├─ Nhận biết + nhận dạng tiếng Anh: Whisper base
                                      │    └─ Giọng đọc: Edge TTS (Internet) → giọng Windows "Microsoft An" (offline) khi Edge lỗi
                                      ├─ Ollama + Qwen 2.5 3B (127.0.0.1:11434): hiểu câu nói, phân loại ý định, trò chuyện
                                      ├─ Dashboard /dashboard (PWA, HTTPS :3443, aiot.local), Web Mobile /mobile
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
| `scripts/fix-hotspot-firewall.ps1` | Mở TCP 3100, 3443, 1883 và UDP 5353 cho thiết bị trên Mobile Hotspot của Windows |
| `models/` | Model đã chuyển đổi (tạo ra trên máy, không commit) |
| `backend/data/` | Tài khoản (SQLite), khóa ký token, CA và chứng chỉ HTTPS (không commit, cần sao lưu) |
| `backend/src/auth/`, `backend/src/network/` | Tài khoản (một loại) và chế độ khách; HTTPS nội bộ, mDNS, kênh live, PWA |

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
[AIoT] Server is listening at http://0.0.0.0:3100
```

Cấp nguồn ESP32: log hiện `Device hello accepted: <MAC>`, OLED hiện `Listen` là có thể nói.

**Lần đầu tiên:** mở `http://localhost:3100/dashboard` **trên chính máy AI worker** và tạo **tài khoản đầu tiên** (chỉ làm được từ máy này, và chỉ khi chưa có tài khoản nào). Sau đó dùng khu "Tài khoản" để tạo thêm tài khoản; người không đăng nhập vẫn xem được nhiệt độ, độ ẩm và trạng thái đèn.

### Kiểm tra máy AI worker đã giống hệ thống gốc

| Kiểm tra | Kết quả mong đợi |
| --- | --- |
| `cd backend; npm.cmd test` | toàn bộ test `pass`, `fail 0` |
| `http://localhost:3100/health` | `{"status":"ok",...}` |
| `http://localhost:3100/dashboard` | chưa đăng nhập: thấy ESP32 online, nhiệt độ/độ ẩm, trạng thái đèn; đăng nhập: thêm nút bật/tắt LED, chat AI |
| Nói "Bật đèn lên" | log `[Qwen] ... intent=led_on`, LED bật, ESP32 nói "Em đã bật đèn, đại ca." |
| Nói "Một cộng một bằng mấy" | ESP32 trả lời "1 cộng 1 bằng 2" |

Trên điện thoại cùng mạng: xem mục **Dùng trên điện thoại** bên dưới.

## Dùng trên điện thoại (HTTPS, aiot.local, cài thành ứng dụng)

Backend chạy song song hai cổng:

| Cổng | Dùng cho |
| --- | --- |
| `3100` HTTP | ESP32 (`ws://…/aiot`), trang `/trust`, tải `/ca.crt`, truy cập ngay trên laptop (`localhost`) |
| `3443` HTTPS | Trình duyệt trên điện thoại/máy khác: `https://aiot.local:3443/dashboard` |

1. **Cài chứng chỉ (mỗi điện thoại một lần):** điện thoại vào cùng Wi-Fi, mở `http://<IP laptop>:3100/trust` → tải `aiot-smart-room-ca.crt` → làm theo hướng dẫn trên trang (Android: *Cài đặt chứng chỉ CA*; iPhone: cài hồ sơ rồi bật *Cài đặt tin cậy chứng nhận*). Backend tự tạo CA riêng trong `backend/data/tls` lần chạy đầu; chứng chỉ máy chủ tự cấp lại khi IP laptop đổi, **CA không đổi nên không phải cài lại**.
2. **Mở dashboard:** `https://aiot.local:3443/dashboard` (hoặc `https://<IP laptop>:3443/dashboard`). Mở bằng HTTP từ máy khác sẽ tự chuyển sang HTTPS; nếu chưa cài CA, trang hiện dải cảnh báo kèm link `/trust`.
3. **Cài thành ứng dụng:** Android (Chrome) bấm nút **⬇ Cài ứng dụng** trên dashboard hoặc *⋮ → Cài đặt ứng dụng*; iPhone (Safari) *Chia sẻ → Thêm vào MH chính*. Ứng dụng mở thẳng dashboard, toàn màn hình, có biểu tượng riêng; khung giao diện được lưu để mở nhanh, dữ liệu luôn lấy trực tiếp.
4. **Cập nhật tức thì:** dashboard nhận trạng thái thiết bị qua WebSocket `/api/live` (chấm xanh cạnh giờ cập nhật, trễ ≤ 0,5 s); mất kết nối thì tự kết nối lại và tạm hỏi định kỳ 2 giây.

Ghi chú:
- Tên `aiot.local` dùng mDNS: iPhone, macOS, Windows 10+ và phần lớn Android 12+ phân giải được; nếu không, dùng IP laptop. Đổi tên bằng `MDNS_NAME`.
- Windows Firewall: cho phép Node.js trên mạng **Private** khi được hỏi; với Mobile Hotspot chạy `scripts\fix-hotspot-firewall.ps1` (Admin) để mở TCP 3100, 3443, 1883 và UDP 5353 chỉ cho dải hotspot.
- Đây là HTTPS **trong mạng nội bộ**. Truy cập từ ngoài nhà là giai đoạn 3.

## Tài khoản và phân quyền

Chỉ có **một loại tài khoản** và **khách không cần tài khoản**:

| | Xem nhiệt độ, độ ẩm, trạng thái đèn | Bật/tắt đèn | Chat với AI | Tạo/khóa/xóa tài khoản | Đặt tên thiết bị, phòng | Nhật ký | MQTT |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Có tài khoản** | ✅ | ✅ mọi thiết bị | ✅ | ✅ | ✅ | ✅ tất cả | ✅ |
| **Khách** (không đăng nhập) | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

- Mở `/dashboard` (hoặc `/mobile`) là thấy ngay chế độ khách: tên thiết bị, online/offline, nhiệt độ, độ ẩm, đèn bật/tắt, cập nhật trực tiếp. Khách **không** thấy mã MAC, phòng, nhật ký hay danh sách tài khoản. Bấm **🔑 Đăng nhập** để điều khiển.
- Tài khoản đầu tiên tạo trên máy chạy backend. Sau đó **tài khoản nào cũng tạo thêm được tài khoản** (khu "Tài khoản" trên dashboard), và tài khoản mới có đúng quyền như tài khoản tạo ra nó.
- Để không ai bị khóa ngoài hệ thống: **tài khoản đầu tiên** không thể bị khóa hoặc xóa, và chỉ chính nó đổi được mật khẩu của nó; không ai tự khóa hay tự xóa tài khoản mình đang dùng. Các tài khoản khác đặt lại mật khẩu cho nhau được.
- Tài khoản "Thành viên"/"Khách" từ bản cũ được tự chuyển thành tài khoản đầy đủ khi khởi động (quyền theo thiết bị cũ bị bỏ; các phiên đăng nhập cũ phải đăng nhập lại).
- Lệnh bằng **giọng nói** tại chỗ vẫn hoạt động không cần tài khoản (người nói ở trong phòng) và được ghi nhật ký với nguồn "Giọng nói".
- Đăng nhập cấp **access token 15 phút** và **refresh token 30 ngày** (xoay vòng; dùng lại token cũ sẽ thu hồi cả phiên). Đổi mật khẩu hoặc khóa tài khoản làm mọi phiên cũ mất hiệu lực. Sai mật khẩu 5 lần trong 15 phút: khóa đăng nhập 5 phút.
- Mật khẩu băm bằng scrypt; dữ liệu nằm trong `backend/data/aiot.sqlite` (hoặc PostgreSQL nếu đặt `DATABASE_URL`), khóa ký token trong `backend/data/auth-secret`. **Sao lưu thư mục `backend/data/`**, không commit nó (đã có trong `.gitignore`).
- **MQTT:** đăng nhập bằng cùng tên/mật khẩu; mọi tài khoản dùng được mọi topic (`aiot/#`, `aiot/device/<MAC>/led/set`, `.../command`…). Không có tài khoản thì broker từ chối. Topic dữ liệu (`.../sensor`, `.../state`) chỉ backend được gửi: gói giả mạo bị bỏ (không ngắt kết nối) và ghi nhật ký "Bị từ chối".
- **Nhật ký** ghi: ai, lúc nào, nguồn (Web, App, Giọng nói, MQTT), thao tác, thiết bị, kết quả.
- **Tự khởi động khi đăng nhập Windows (khuyên dùng):** chạy một lần `powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -StartNow` (không cần quyền Admin). Tác vụ "AIoT Smart Room" chạy `scripts\aiot-supervisor.ps1` ẩn: chờ Ollama, chạy backend (cổng 3100) và **tự chạy lại khi backend thoát/lỗi**, chạy đường hầm riêng của AIoT và tự chạy lại nó. Log ở `backend\logs` (`supervisor.log`, `backend-<ngày>.log`, `tunnel.log`); địa chỉ Internet hiện tại ở `backend\logs\public-url.txt`. Gỡ bằng `install-autostart.ps1 -Uninstall`. Trình giám sát không đụng tới dịch vụ khác (cổng 3000, dịch vụ `Cloudflared`).
- **Tên miền cố định cho AIoT:** `powershell -ExecutionPolicy Bypass -File scripts\setup-named-tunnel.ps1 -Hostname aiot.<tên-miền-của-bạn>`. Lần đầu mở trình duyệt để đăng nhập Cloudflare. Script tạo một tunnel **mới** `aiot-smart-room` (cấu hình riêng trong `backend\data\cloudflared`), chỉ tạo bản ghi DNS nếu tên đó còn trống (không ghi đè bản ghi có sẵn), không sửa tunnel/dịch vụ cũ. Sau đó khởi động lại trình giám sát (đăng xuất/đăng nhập, hoặc dừng tiến trình `aiot-supervisor` rồi chạy lại tác vụ) để chuyển từ Quick Tunnel sang tên miền này.
- **Đưa AIoT ra Internet (đường hầm riêng):** (không dùng trình giám sát) chạy `powershell -ExecutionPolicy Bypass -File scripts\start-public-tunnel.ps1` sau khi backend đã chạy. Script mở một Cloudflare Quick Tunnel **riêng** cho AIoT (tiến trình cloudflared riêng, không cần tài khoản, không đụng dịch vụ `Cloudflared` hay tên miền của dự án khác) và in địa chỉ `https://<tên-ngẫu-nhiên>.trycloudflare.com`. Địa chỉ đổi mỗi lần chạy lại; muốn tên miền cố định thì tạo **một named tunnel mới** trong tài khoản Cloudflare với một hostname chưa dùng cho dự án nào, trỏ về `http://localhost:3100`. Backend AIoT dùng cổng **3100** (cổng 3000 thuộc dịch vụ khác trên máy này).
- **Khi đưa ra Internet qua đường hầm** (cloudflared, ngrok…): tạo tài khoản đầu tiên **trước**. Việc tạo tài khoản đầu tiên chỉ nhận yêu cầu gõ trực tiếp trên laptop (`localhost`, không qua proxy), nên đường hầm không tạo được; trang `/api/network` không cho người ngoài mạng LAN biết IP nội bộ. Backend đọc địa chỉ thật của người truy cập từ `CF-Connecting-IP`/`X-Forwarded-For` (chỉ với kết nối từ chính laptop; tắt bằng `TRUST_PROXY=false`), để một người gõ sai mật khẩu không khóa luôn người khác. Mỗi địa chỉ sai 20 lần trong 15 phút (với bất kỳ tên đăng nhập nào) bị chặn 15 phút. Kênh trực tiếp dành tối đa `LIVE_MAX_GUESTS` (30) chỗ cho khách, mỗi địa chỉ tối đa `LIVE_MAX_PER_IP` (5) kết nối chưa đăng nhập; kết nối im lặng bị đóng sau 5 giây. Nếu mở cổng trực tiếp trên router (không dùng đường hầm): chỉ mở HTTPS (3443), **không** mở 3100 (HTTP, token thiết bị đi dạng chưa mã hóa) và 1883 (MQTT). Đường hầm Cloudflare thì khác: Cloudflare đã mã hóa HTTPS phía Internet và chỉ nối vào `localhost:3100` trên máy này, nên trỏ vào 3100 là đúng.
- Quên mật khẩu tài khoản đầu tiên: dừng backend, đổi tên `backend/data/aiot.sqlite` (dữ liệu cũ được giữ lại để tra cứu), khởi động lại và tạo tài khoản mới.

API chính (gửi `Authorization: Bearer <accessToken>`; app di động gửi thêm `X-Client: app`):

| API | Ai dùng được |
| --- | --- |
| `GET /api/public/devices` | khách (tên, online, nhiệt độ, độ ẩm, trạng thái đèn; không có MAC) |
| `GET /api/auth/status`, `POST /api/auth/login`, `/refresh`, `/logout` | công khai |
| `POST /api/auth/setup` | chỉ từ máy chạy backend, khi chưa có tài khoản |
| `GET /api/auth/me`, `POST /api/auth/password`, `GET /api/devices`, `GET /api/rooms` | có tài khoản |
| `POST /api/devices/:id/led` · `POST /api/devices/:id/text` | có tài khoản |
| `GET/POST /api/users`, `PATCH/DELETE /api/users/:id` | có tài khoản |
| `PATCH /api/devices/:id`, `POST/DELETE /api/rooms`, `GET /api/audit` | có tài khoản |
| WebSocket `/api/live` | gửi `{"type":"auth","token":…}` (đầy đủ) hoặc `{"type":"guest"}` (chế độ khách) |

Trình duyệt trên máy khác dùng HTTPS nội bộ (cổng 3443, xem mục Dùng trên điện thoại). Trước khi mở ra Internet cần thêm giai đoạn 3 (đường hầm bảo mật, tên miền).

## 3. Firmware ESP32-S3

1. Sao chép `include\config.example.h` thành `include\config.h` rồi sửa `WIFI_SSID`, `WIFI_PASSWORD` (Wi-Fi 2.4 GHz), `WS_HOST` (IP LAN của máy AI worker, không dùng `localhost`, không có `ws://`), `WS_PORT=3100`, `WS_TOKEN` (trùng `DEVICE_TOKEN`).
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

Chân được chọn theo vị trí trên breadboard để **không dây nào bắt chéo** (đặt bo với cổng USB bên trái: hàng chân dưới có `5VIN G13 G14 G21 … G2 G1 GND`, hàng chân trên có `3V3 … G17 G16 G15 … G6 G5 G4 EN 3V3 GND`):

| Module (vị trí) | Chân module | GPIO ESP32-S3 | Hàng chân |
| --- | --- | --- | --- |
| OLED SSD1306 128×64 I2C (dưới, bên trái) | SCL / SDA | 13 / 14 | dưới, đầu trái |
| DHT22 (rời, phía dưới trái) | DATA | 21 | dưới, cạnh OLED |
| WS2812B (dưới, bên phải) | DIN | 1 | dưới, đầu phải (cạnh GND) |
| MAX98357A (trên, giữa) | LRC / BCLK / DIN | 17 / 16 / 15 | trên, giữa (trái → phải đúng thứ tự chân ampli) |
| INMP441 (rời, phía trên phải) | WS / SCK / SD | 4 / 5 / 6 | trên, đầu phải (cạnh 3V3, GND) |

Nguồn qua hai thanh nguồn của breadboard, đi vòng mép trái bo (phía USB) nên không cắt ngang dây tín hiệu:
- **Thanh nguồn dưới:** `+` = 3V3, `−` = GND (lấy GND ở chân GND cuối hàng dưới). Cấp cho OLED, DHT22, WS2812B.
- **Thanh nguồn trên:** `+` = 5VIN, `−` = GND (chân GND cuối hàng trên). Cấp cho MAX98357A.
- INMP441 (6 chân): SD → G6, SCK → G5, WS → G4, VDD → 3V3, GND → GND, **L/R → GND** (kênh trái), lấy ngay ở cuối hàng chân trên.
- MAX98357A (7 chân): LRC → G17, BCLK → G16, DIN → G15, GND → GND, VIN → 5V; **GAIN và SD để trống** (SD trống = bật, GAIN trống = 9 dB). Loa vào cầu đấu `+` `−`.
- OLED (4 chân): VCC → 3V3, GND → GND, SCL → G13, SDA → G14.
- DHT22 module 3 chân: VCC → 3V3, DATA → G21, GND → GND (loại 4 chân trần: chân 3 để trống, thêm điện trở 10 kΩ giữa DATA và VCC).
- WS2812B: VCC → 3V3, DIN → G1, GND → GND; **DOUT để trống**.
- Tránh các chân G0, G3, G45, G46 (chân khởi động), G19/G20 (USB), G35–G37 (PSRAM của bản N16R8), G43/G44 (log Serial), G48 (LED RGB trên bo).

**Màn OLED bị sọc ngang:** do nhiễu trên dây I2C (dây dài chạy cạnh dây I2S của ampli, tiếp xúc breadboard lỏng) làm hỏng cấu hình bên trong SSD1306. Firmware chạy I2C ở 100 kHz và gửi lại cấu hình màn hình mỗi 5 giây, nên vệt sọc tự hết; dây OLED nên ngắn, cắm chặt và không đi song song với dây ampli.

- INMP441 cấp 3.3 V, L/R nối GND. **Lỗ thu âm nằm ở mặt dưới bo** — không cắm úp sát breadboard, hướng lỗ về phía người nói, nói cách 5–30 cm.
- DHT22 cấp 3.3 V; cảm biến rời cần điện trở kéo lên 4.7–10 kΩ ở DATA.
- OLED 3.3 V, địa chỉ `0x3C` (sửa cấu hình nếu là `0x3D`).
- MAX98357A thường cấp 5 V; loa nối giữa OUT+ và OUT− (không nối loa xuống GND).
- WS2812B: nguồn đủ dòng; với 5 V nên có chuyển mức logic 3.3→5 V.

**Nguồn điện (quan trọng):** khi cấp nguồn chỉ từ cổng USB laptop, ESP32 từng tự khởi động lại ngay sau khi loa phát (sụt áp do MAX98357A) và micro bị nhiễu ù ~85 Hz. Nên dùng củ sạc 5 V ≥ 2 A, thêm tụ 470–1000 µF sát nguồn MAX98357A, tụ 100 nF + 10 µF sát VDD–GND của INMP441, dây micro ngắn và đặt xa ampli. Backend tự giảm âm lượng (`SPEAKER_VOLUME=0.5`) và lọc tiếng ù dưới 120 Hz; log `Device ... rebooted` báo khi ESP32 bị reset.

Đây chưa phải công tắc đèn điện lưới; điều khiển đèn phòng cần module relay và đấu nối riêng.

## 5. Sử dụng

- **Thanh trạng thái OLED** (dòng giữa màn hình) cho biết hệ thống đang làm gì. Nền sáng = đang bận với bạn, khung viền = đang rảnh:

  | Hiển thị | Ý nghĩa |
  | --- | --- |
  | `Goi: Tro ly oi` (khung viền) | Đang rảnh, chờ gọi tên |
  | `NGHE LENH 9s` (nền sáng, vạch dưới ngắn dần) | Đã gọi tên/vừa trả lời: nói lệnh tiếp, không cần tên |
  | `DANG THU AM...` (vạch dưới nhảy theo giọng) | Micro đang thu giọng bạn |
  | `DANG XU LY...` | Đang nhận dạng giọng nói và hiểu lệnh |
  | `DANG TRA LOI...` / `PHAT NHAC...` | Loa đang phát câu trả lời / nhạc |
  | `CO LOI - NOI LAI` | Lượt vừa rồi lỗi, nói lại |

  Góc phải: `D:BAT`/`D:TAT` là trạng thái đèn.
- **Gọi tên trước khi ra lệnh:** "Trợ lý ơi, bật đèn lên" (tên đặt ở cuối câu cũng được: "Tắt đèn đi trợ lý ơi"). Câu không có tên được coi là người trong phòng nói chuyện với nhau và bị bỏ qua lặng lẽ (không trả lời, không ghi log nội dung). Chỉ gọi "Trợ lý ơi" thì AI đáp "Dạ, em nghe đây đại ca" và chờ câu tiếp.
- **Nói tiếp không cần gọi lại tên** trong 10 giây sau mỗi câu trả lời; OLED đếm ngược "Em đang nghe đại ca... Còn 9 giây", hết giờ thì hiện lại gợi ý gọi tên. Đổi tên/thời gian bằng `WAKE_WORDS` (nhiều tên cách nhau dấu phẩy; để trống = luôn nghe như trước) và `WAKE_FOLLOWUP_MS` trong `backend/.env`. Lệnh gõ trên dashboard và MQTT không cần tên.
- Khi OLED hiện `Listen`, thử: "Trợ lý ơi, xin chào", "Trợ lý ơi, bật đèn lên", "Tắt đèn đi trợ lý", "Trợ lý ơi, nhiệt độ trong phòng bao nhiêu", "Trợ lý ơi, kể chuyện cười đi", "Trợ lý ơi, ba cộng bốn bằng mấy".
- AI làm ngay yêu cầu, không hỏi lại; chỉ hỏi lại khi câu nghe sai đến mức không đoán được ý, hoặc với câu phủ định về đèn ("Đừng tắt đèn").
- Hủy lượt đang xử lý hoặc dừng nói/nhạc: **nhấn rồi thả BOOT** khi board đang chạy (không nhấn RESET).
- Nhạc: thêm file WAV PCM16 mono 16 kHz (≤ 10 MB) vào `backend/music` và khai báo trong `backend/music/catalog.json` (hoặc đặt file `.mp4` trong `backend/music/mp4`). Chuyển đổi: `ffmpeg -i input.mp3 -ac 1 -ar 16000 -c:a pcm_s16le backend/music/song.wav`. Thư viện trống thì AI nói thật là chưa có bài.
- **MQTT** (broker nhúng cổng 1883, đăng nhập bằng tài khoản; xem mục Tài khoản và phân quyền), dùng được với IoT MQTT Panel, MQTT Dash, MQTT Explorer:
  - `aiot/device/<MAC>/led/set`: gửi `on`/`off`.
  - `aiot/device/<MAC>/command`: `{"action":"led","state":"on"}` hoặc `{"action":"text","text":"Nhiệt độ phòng?"}`.
  - `aiot/device/<MAC>/sensor`, `.../state`, `.../chat`: nhận cảm biến, trạng thái, hội thoại.
  - Thử nhanh (bằng một tài khoản bất kỳ): `$env:MQTT_USER='...'; $env:MQTT_PASS='...'; node backend/scripts/mqtt-client-demo.js [on|off|ask|monitor]`.
  - Broker ngoài (`MQTT_BROKER_URL`) không được backend kiểm soát quyền; hãy cấu hình quyền trên broker đó.

## 6. Xử lý sự cố

| Hiện tượng | Cách xử lý |
| --- | --- |
| `Port 3100 is already in use` / `A local voice bridge is already running` | Backend cũ còn chạy: `Get-CimInstance Win32_Process \| Where-Object { $_.CommandLine -like '*dist/src/main.js*' -or $_.CommandLine -like '*local-voice-bridge.py*' } \| ForEach-Object { Stop-Process -Id $_.ProcessId -Force }` |
| `Local voice Python is missing` | Sai `LOCAL_VOICE_PYTHON` trong `backend/.env` (xem bước 5) |
| `Whisper model directory is incomplete` | Chưa chạy `scripts\setup-phowhisper.py`, hoặc sai `LOCAL_WHISPER_MODEL` |
| `FFmpeg is required` | Cài FFmpeg (bước 1) hoặc đặt `FFMPEG_EXE` trỏ tới `ffmpeg.exe` |
| AI trả lời "đang suy nghĩ hơi chậm" | Ollama chưa chạy: `ollama serve`, kiểm tra `ollama list` có `qwen2.5:3b` |
| Giọng đọc chậm, log `Edge-TTS failed` | Edge TTS (miễn phí) đang chập chờn; hệ thống tự dùng giọng "Microsoft An" trong 5 phút, lỗi liên tiếp thì giãn dần tới 60 phút. Cần cài giọng ở bước 3 |
| Nói mà AI không phản ứng | Chưa gọi tên: bắt đầu bằng "Trợ lý ơi" (xem `WAKE_WORDS`). Log `Voice capture` không xuất hiện thì nói to/gần hơn |
| Bấm đèn trên dashboard báo quá thời gian / phản hồi chậm | Bật `DEVICE_DEBUG=1` trong `backend/.env`: log `Device ... loop N ms` (vòng lặp mạng ESP32, bình thường vài ms) và `LED on ack after N ms`. Vòng lặp hàng giây là ESP32 bị nghẽn mạng: đặt ESP32 cách laptop ≥ 1 m, kiểm tra hotspot |
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
