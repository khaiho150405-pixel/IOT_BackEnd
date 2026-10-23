# Nạp, chẩn đoán và bàn giao AIoT

## Những gì đã xác nhận

Log cũ có `Hash of data verified` và `SUCCESS`: đã ghi flash thành công.
Header `Terminal on COM6` chỉ xác nhận mở cổng; không xác nhận ứng dụng chạy.
`ClearCommError ... Reconnecting` nghĩa là handle USB bị ngắt; chưa đủ kết luận do reset, nguồn, driver hay firmware.
Không suy ra chức năng hai cổng USB chỉ từ vị trí trên ảnh. Giữ cổng từng nạp thành công; xác nhận qua tên thiết bị/Hardware IDs trong Device Manager.

## 1. Kiểm tra USB độc lập

Ngắt USB và nguồn ngoài trước khi tháo dây. Tạm tháo toàn bộ dây GPIO/nguồn ngoại vi, chỉ cấp USB cho ESP32. Rút riêng 3V3/GND không bảo đảm an toàn vì dây tín hiệu vẫn có thể cấp nguồn ngược. Chưa đấu tải điện lưới khi thử.

Đóng các terminal đang monitor. Mở PowerShell tại E:\AIoT\Code:

```powershell
$pio = "$env:USERPROFILE\.platformio\penv\Scripts\platformio.exe"
& $pio device list
Get-PnpDevice -PresentOnly | Where-Object { $_.Class -eq 'Ports' } | Format-Table Status,FriendlyName,InstanceId -AutoSize
```

Giữ BOOT, nhấn-thả RST, thả BOOT; chạy lại device list. Dùng COM thực tế, không cố định COM6 nếu Windows đổi số.

Chương trình chẩn đoán sau thay firmware hiện tại trên board; không sửa main.cpp và có thể nạp lại ứng dụng ở bước 2. Không dùng PSRAM, WiFi, Gemini hay ngoại vi. Cấu hình 8MB DIO bảo thủ chỉ dành cho bài test này, không phải kết luận về dung lượng board.

```powershell
$port = 'COM6' # thay bằng COM thực tế
& $pio run -e usb-diagnostic -t upload --upload-port $port
```

Sau SUCCESS: thả BOOT hoàn toàn, nhấn-thả RST một lần để thoát download mode, đợi Windows nhận lại USB. Chạy `& $pio device list` và cập nhật `$port` nếu đổi. Sau đó:

```powershell
& $pio device monitor -e usb-diagnostic --port $port --baud 115200
```

Không reset liên tục khi đang monitor. Đợi 10 giây; mong đợi `USB TEST OK` lặp mỗi giây. Ctrl+C để thoát; nếu không được, đóng terminal monitor trước khi nạp tiếp.

- Có USB TEST OK: đường USB và chạy firmware tối thiểu đã hoạt động; sang bước 2.
- Không có COM: xem Device Manager, Other devices và Hardware IDs trước khi chọn driver. Thử cáp dữ liệu/cổng máy khác. Không cài driver CH340/CP210x theo phỏng đoán.
- COM ổn định nhưng im lặng: nhấn Enter một lần; thử đóng/mở monitor. Lưu log nạp diagnostic và Hardware IDs để kiểm tra đúng USB native hay cầu UART.
- COM liên tục mất/kết nối dù không nhấn nút: kiểm tra cáp, nguồn, breadboard; thử board tách khỏi breadboard khi đã ngắt nguồn.

## 2. Nạp ứng dụng

Kiểm tra include/config.h: WiFi 2.4GHz, WS_HOST là IPv4 LAN hiện tại của máy backend (không phải localhost), WS_PORT/WS_PATH đúng, WS_TOKEN trùng DEVICE_TOKEN trong backend/.env. Không chia sẻ nội dung secrets.

```powershell
& $pio run -e esp32-s3-n16r8 -t upload --upload-port $port
```

Sau SUCCESS, thả BOOT và nhấn RST trước khi mở monitor; kiểm tra lại COM:

```powershell
& $pio device list
& $pio device monitor -e esp32-s3-n16r8 --port $port --baud 115200
```

Mong đợi AIoT boot hoặc AIoT alive lặp 5 giây. PSRAM phải khác 0; board đúng N16R8 thường báo 8388608 byte. FATAL lặp lại giúp đọc lỗi dù mở monitor muộn. Diagnostic chạy nhưng ứng dụng không chạy: kiểm tra mã module N16R8 và cấu hình flash/PSRAM, ghi lại log Init/FATAL. Không coi SUCCESS là hoàn thành demo.

## 3. Backend và phần cứng

Trong terminal riêng:

```powershell
Set-Location E:\AIoT\Code\backend
npm.cmd run build
npm.cmd start
```

Giữ .env hiện có. GET http://localhost:3000/health chỉ kiểm tra server sống, không kiểm tra Gemini. Điện thoại và ESP32 cùng LAN phải truy cập được http://IP-MAY-BACKEND:3000/health. Kiểm tra firewall TCP3000 và AP isolation nếu LAN không truy cập được. Không mở cổng ra Internet để demo.

Ngắt mọi nguồn trước khi đấu lại từng module. Chân theo yêu cầu: DHT22=10; OLED SDA8/SCL9; WS2812 DATA11; INMP441 WS4/BCLK5/SD6 (L/R chọn kênh trái); MAX98357A LRC15/BCLK16/DIN17. Kiểm tra điện áp/nguồn theo module; GPIO ESP32 không chịu tín hiệu 5V. Không đấu ngoại vi GPIO19/20 khi dùng USB native.

## 4. Tiêu chí demo

| Thử | Kết quả cần quan sát |
| --- | --- |
| Khởi động | AIoT alive, PSRAM hợp lệ, uptime tăng |
| Kết nối | WiFi=connected và WS=connected |
| Cảm biến | OLED hiển thị nhiệt độ/độ ẩm hợp lý, không DHT read error |
| “Tắt đèn”, “Bật đèn” | LED WS2812 ngoài GPIO11 đổi trạng thái; backend nhận ACK |
| “Nhiệt độ và độ ẩm trong phòng?” | Trả số đo mới, không số tự suy đoán |
| Trò chuyện tiếng Việt/Anh | Transcript/reply và OLED; loa trả lời nếu TTS thành công |
| Mất mạng rồi nối lại | Kết nối phục hồi, lệnh mới có ACK |
| Nhạc tùy chọn | WAV PCM16 mono16k có trong catalog; BOOT dừng phát khi firmware đang chạy |

LED nguồn trên board không phải đèn điều khiển GPIO11. Micro bị mute lúc phát nên dùng BOOT ngắt lời/nhạc; không giữ BOOT khi reset. Demo local hiện dùng Qwen 2.5 3B + Vosk tiếng Việt, Edge TTS cần Internet; chọn Gemini nếu cần nhận dạng giọng nói đa ngôn ngữ. Mọi font/ngôn ngữ/TTS vẫn cần thử trên board.

## 5. Bàn giao cho đội điện thoại

Đọc backend/README.md để dùng giao thức ESP32–server `/aiot`: raw WebSocket, không phải Socket.IO. PCM16LE mono16k, hello/sensor/command/ack/display/audio đã có. Chế độ Ollama local không cần API key; Gemini key chỉ ở backend khi chọn `AI_PROVIDER=gemini`. `ASSISTANT_STYLE` đọc từ .env, cần restart backend.

Hiện backend CHƯA có API điều khiển dành cho điện thoại. Không kết nối app như một ESP32 hoặc nhúng DEVICE_TOKEN vào app. Đội app/backend cần bổ sung: đăng nhập, phân quyền sở hữu thiết bị, danh sách online/offline, cảm biến kèm timestamp, endpoint lệnh LED, requestId/ACK/timeout, stream trạng thái, API lịch sử. Nên tái sử dụng đường command/ACK hiện tại và phân xử lệnh app với lượt giọng nói đang chạy.

Gói bàn giao gồm firmware + backend + .env.example/config.example.h (không secrets), sơ đồ đấu dây thực tế, mã module, phiên bản build, MAC/device_id, log demo từng ca, thiết lập DB và hướng dẫn khởi chạy. Đánh dấu rõ ca chưa thử; kiểm thử tự động dùng API giả lập không xác nhận key/quota Gemini thật.
