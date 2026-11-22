# Khởi động thủ công hệ thống AIoT Smart Room

Cài đặt máy mới: xem [README.md](README.md), mục 1. Hệ thống gồm 3 phần chạy trên laptop và 1 thiết bị ESP32:

| Thành phần | Vai trò | Cổng |
| --- | --- | --- |
| Ollama + `qwen2.5:3b` | Hiểu câu nói, phân loại ý định | 11434 (chỉ máy này) |
| Backend NestJS | WebSocket cho ESP32, dashboard, MQTT, HTTPS cho điện thoại, mDNS `aiot.local` | 3000, 3443, 1883, UDP 5353 |
| Voice bridge (Python, backend tự bật) | PhoWhisper nhận dạng giọng nói, Edge TTS / giọng Windows "An" đọc câu trả lời | 8010 (chỉ máy này) |
| ESP32-S3 | Micro, loa, OLED, LED, DHT22 | kết nối tới `ws://<IP laptop>:3000/aiot` |

## Cách 1 – Một lệnh (khuyên dùng)

Mở PowerShell tại `E:\AIoT\Code`:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\start-local-xiaozhi.ps1"
```

Script kiểm tra cấu hình, tự bật Ollama nếu chưa chạy, rồi chạy backend. Chỉ kiểm tra mà không chạy: thêm `-CheckOnly`. Dừng: `Ctrl+C`.

## Cách 2 – Từng bước

**Bước 1. Bật Ollama** (bỏ qua nếu biểu tượng Ollama đã có ở khay hệ thống):

```powershell
ollama serve
```

Kiểm tra: `curl http://127.0.0.1:11434/api/tags` phải liệt kê `qwen2.5:3b`. Chưa có model thì chạy `ollama pull qwen2.5:3b`.

**Bước 2. Chạy backend** (cửa sổ PowerShell khác):

```powershell
cd E:\AIoT\Code\backend
npm.cmd run build      # chỉ cần sau khi sửa code
npm.cmd start
```

Khi sẵn sàng sẽ thấy lần lượt (mất khoảng 5–90 giây tuỳ máy đã nạp model chưa):

```
Local Whisper model ../models/phowhisper-base-ct2 ready.   (đường dẫn theo LOCAL_WHISPER_MODEL)
Local voice bridge ready at http://127.0.0.1:8010
Local LLM ready; kept loaded for the demo.
[AIoT] Server is listening at http://0.0.0.0:3000
```

**Bước 3. Bật ESP32**: cấp nguồn 5 V. ESP32 tự kết nối Wi‑Fi và backend; log backend hiện
`Device hello accepted: <MAC>` và OLED hiện `Listen`. Lúc này có thể nói.

**Bước 4. Kiểm tra**

- `http://localhost:3000/health` → `{"status":"ok",...}`
- `http://localhost:3000/dashboard` → chưa đăng nhập vẫn thấy ESP32 online, nhiệt độ/độ ẩm, trạng thái đèn; đăng nhập để bật/tắt LED và chat AI (lần đầu: tạo **tài khoản đầu tiên**, chỉ làm được trên máy này; sau đó tài khoản nào cũng tạo thêm được tài khoản)
- Điện thoại cùng mạng: `http://<IP laptop>:3000/mobile`

## Dừng hệ thống

`Ctrl+C` trong cửa sổ backend (voice bridge tự tắt theo). Nếu cửa sổ đã đóng mà cổng vẫn bận:

```powershell
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*dist/src/main.js*' -or $_.CommandLine -like '*local-voice-bridge.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

## Lỗi thường gặp

| Hiện tượng | Cách xử lý |
| --- | --- |
| `Port 3000 is already in use` | Backend cũ còn chạy: dùng lệnh dừng ở trên rồi chạy lại. |
| `A local voice bridge is already running` | Bridge cũ còn ở cổng 8010: dùng lệnh dừng ở trên. |
| `Whisper model directory is incomplete` | Chưa tạo model PhoWhisper: chạy `py -3.12 scripts\setup-phowhisper.py` (xem README, bước 6) và kiểm tra `LOCAL_WHISPER_MODEL` trong `backend/.env`; tạm thời có thể đặt `LOCAL_WHISPER_MODEL=small`. |
| ESP32 không kết nối | Laptop và ESP32 phải cùng mạng 2.4 GHz; `WS_HOST` trong `include/config.h` (hoặc trang cấu hình Wi‑Fi `AIoT_Smart_Room`) phải là IP laptop; cho phép Node qua Windows Firewall (`scripts\fix-hotspot-firewall.ps1`, chạy bằng quyền Admin khi dùng hotspot). |
| `WebSocket rejected ... wrong device token` | Token ESP32 gửi khác `DEVICE_TOKEN` trong `backend/.env`. Token nhập ở trang cấu hình Wi‑Fi `AIoT_Smart_Room` được lưu trên ESP32 và **ưu tiên hơn** `WS_TOKEN` trong `include/config.h`: vào lại trang đó nhập đúng token, hoặc đặt `DEVICE_TOKEN` bằng token đã lưu trên thiết bị. |
| ESP32 ngắt kết nối khi loa phát | Thường do nguồn yếu: dùng củ sạc 5 V ≥ 2 A. |
| Giọng đọc chậm | Edge TTS đang lỗi; hệ thống chờ tối đa 3 giây rồi dùng giọng offline "An" trong 5 phút. Chỉnh bằng `EDGE_TTS_BUDGET_S` / `EDGE_TTS_COOLDOWN_S` trong `backend/.env`. |
| ESP32 tự khởi động lại khi đang nói | Log `Device ... rebooted`: nguồn yếu; tạm giảm `SPEAKER_VOLUME` (mặc định 0.5) xuống 0.3. |
| AI trả lời "đang suy nghĩ hơi chậm" | Ollama chưa chạy hoặc quá tải: kiểm tra Bước 1. |
