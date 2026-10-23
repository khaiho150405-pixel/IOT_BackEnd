# Sườn báo cáo tiến độ dự án AIoT

**Tên đề tài:** Trợ lý phòng thông minh điều khiển bằng giọng nói dùng ESP32 và Local AI (Ollama) / MQTT  
**Người thực hiện:** [Tên sinh viên/nhóm]  
**Lớp / giảng viên:** [Điền thông tin]  
**Mốc báo cáo:** 21/10/2026

## 1. Mở đầu

- **Vấn đề:** Muốn theo dõi điều kiện phòng và điều khiển thiết bị theo cách tự nhiên bằng giọng nói tiếng Việt, không phụ thuộc API key trả phí của bên thứ 3 (Gemini), đồng thời có thể giám sát từ xa qua điện thoại và laptop.
- **Mục tiêu:** Xây dựng mô hình AIoT nhận yêu cầu bằng giọng nói, đọc cảm biến nhiệt độ/độ ẩm DHT22, bật/tắt LED WS2812B (có ACK), trả lời bằng văn bản tiếng Việt trên OLED và giọng nói mượt mà qua loa MAX98357A. Hệ thống xưng "em" và gọi người dùng là "đại ca" thân thiện, lễ phép. Hỗ trợ giao thức MQTT và giao diện Web Mobile cho điện thoại.
- **Phạm vi bản demo:** Điều khiển LED WS2812B trên testboard; đo nhiệt độ/độ ẩm phòng thật; chưa điều khiển bóng đèn điện lưới 220V.

## 2. Kiến trúc tổng thể

Trình bày luồng chính:

```text
Người dùng nói
      ↓
Micro INMP441 → ESP32-S3 → Wi-Fi/WebSocket → Backend NestJS
      ↑                                      ↓
Loa MAX98357A ← ESP32 ← PCM giọng nói ← EdgeTTS / Local ASR + Ollama
                     ↕
       DHT22 ──→ nhiệt độ, độ ẩm
       OLED  ←── số đo, câu hỏi và câu trả lời
       WS2812B ←─ lệnh bật/tắt có xác nhận ACK

Laptop: chạy backend và dashboard điều khiển/giám sát trong mạng demo
```

- ESP32 thu âm, đọc cảm biến, điều khiển LED, cập nhật OLED và phát âm thanh.
- Backend chạy Local AI (Ollama Qwen 2.5 3B, Whisper/Vosk tiếng Việt, Edge TTS) hoàn toàn không cần Gemini API Key; tích hợp nhúng sẵn MQTT Broker (TCP 1883).
- Dashboard trên máy tính và trang Web Mobile `/mobile` trên smartphone hiển thị thiết bị, số liệu cảm biến thời gian thực, trạng thái LED và điều khiển tức thì.

## 3. Phần cứng và công nghệ

| Thành phần | Vai trò |
| --- | --- |
| ESP32-S3 N16R8 | Bộ điều khiển, Wi-Fi, xử lý I/O và âm thanh |
| DHT22 | Đo nhiệt độ và độ ẩm |
| OLED SSD1306 128×64 | Hiển thị số đo, trạng thái và hội thoại |
| WS2812B | Đèn demo bật/tắt |
| INMP441 | Thu âm giọng nói |
| MAX98357A và loa | Khuếch đại/phát câu trả lời |
| PlatformIO / Arduino, NestJS, WebSocket, Local AI (Ollama Qwen 2.5), MQTT | Nền tảng phần mềm và kết nối |

## 4. Chức năng đã triển khai

- Firmware ESP32 đọc DHT22 định kỳ, cập nhật OLED và điều khiển WS2812B.
- ESP32 gửi dữ liệu cảm biến và âm thanh lên backend qua WebSocket; backend gửi lệnh và âm thanh phản hồi về thiết bị.
- Backend dùng Local AI (Ollama Qwen 2.5 3B, Whisper/Vosk) để phân tích giọng nói hoặc văn bản tiếng Việt và tạo câu trả lời; Edge TTS tạo âm thanh phản hồi mượt mà.
- Các ý định chính gồm bật/tắt LED, hỏi nhiệt độ/độ ẩm, phát/dừng nhạc và trò chuyện ngữ cảnh thông minh. Backend chỉ xác nhận lệnh LED sau khi nhận ACK từ ESP32.
- Dashboard máy tính và Web Mobile (`/mobile`) có trạng thái kết nối, giá trị nhiệt độ/độ ẩm, biểu đồ 30 lần đo gần nhất, điều khiển LED tức thì và ô nhập câu thoại.
- Hoàn toàn loại bỏ Gemini API key, không phụ thuộc chi phí hay hạn mức của cloud. Phong cách xưng hô được thiết lập chuẩn mực: trợ lý luôn xưng "em" và gọi người dùng là "đại ca".
- Có xử lý kết nối lại, trạng thái bận/nghe, ngắt lượt bằng nút BOOT và giới hạn thời gian cho một số bước xử lý.

## 5. Tiến độ và bằng chứng hiện có

| Hạng mục | Tiến độ có thể báo cáo | Bằng chứng / lưu ý |
| --- | --- | --- |
| Nạp firmware | Đã nạp thành công ít nhất một lần | Log PlatformIO có `Hash of data verified` và `SUCCESS` |
| ESP32 khởi động | Đã thấy log hoạt động và PSRAM khoảng 8,38 MB | Log `AIoT alive`; đây là xác nhận firmware chạy, không tự chứng minh mọi ngoại vi hoạt động |
| Wi-Fi và WebSocket | Đã từng kết nối trong phiên demo | Đã có log Wi-Fi connected và WebSocket connected; cần kiểm tra lại trước buổi báo cáo |
| Gemini | Đã nhận được phản hồi từ mô hình trong lần thử trước | Kết quả phụ thuộc Internet, API key, quyền model và quota |
| Nhiều lượt hội thoại / timeout | Đã có các lần gặp lỗi trễ hoặc không nhận câu tiếp theo; firmware/backend đã được chỉnh để quản lý lượt và timeout | Cần thử lại liên tục trên phần cứng và ghi thời gian thực tế |
| Dashboard | Đã có giao diện web tối giản và biểu đồ cảm biến | Mã giao diện và API hiện trả HTTP 200; tại lúc soạn sườn, API thiết bị trả `devices: []`, nên chưa có dữ liệu board trực tiếp trên dashboard |
| Đèn và cảm biến vật lý | Đường điều khiển, ACK và hiển thị số liệu đã có trong mã | Trước khi khẳng định hoàn tất, cần demo lại LED WS2812B thật và đối chiếu DHT22; không đồng nhất LED testboard với đèn phòng |
| Ứng dụng điện thoại & MQTT | Đã hoàn thành cơ chế MQTT & Web Mobile | Đã tích hợp MQTT Broker nhúng (port 1883), hỗ trợ app IoT MQTT Panel/MQTT Explorer và giao diện Web Mobile /mobile cho smartphone trong mạng LAN |

**Cách trình bày trung thực:** phân biệt chức năng “đã có trong mã”, chức năng “đã thử trên thiết bị” và chức năng “cần kiểm tra lại”. Không đồng nhất LED testboard với đèn điện lưới 220V.

## 6. Kịch bản demo trước lớp

1. Khởi chạy backend trên laptop; mở Serial Monitor và dashboard.
2. Cho xem ESP32 đã khởi động, PSRAM, Wi-Fi/WebSocket và số liệu nhiệt độ/độ ẩm.
3. Nói “Bật đèn”, xác nhận LED WS2812B đổi trạng thái và backend nhận ACK.
4. Nói “Tắt đèn”, xác nhận LED tắt và trạng thái hiển thị đúng.
5. Hỏi “Nhiệt độ và độ ẩm trong phòng là bao nhiêu?”, đối chiếu câu trả lời với DHT22, OLED và dashboard.
6. Nói một câu trò chuyện ngắn; cho xem câu trả lời trên OLED và nghe loa nếu API/TTS/mạng đang hoạt động.
7. Nếu kết nối Gemini hoặc loa gặp lỗi, trình bày log thực tế và dùng dashboard để minh họa phần điều khiển/giám sát có sẵn.

**Câu demo dự phòng:** chuẩn bị sẵn ảnh/log đã che thông tin bí mật. Không công khai API key, token, mật khẩu Wi-Fi hoặc dữ liệu cấu hình riêng.

## 7. Kết quả, giới hạn và rủi ro hiện tại

- Chất lượng và thời gian phản hồi phụ thuộc Wi-Fi, dịch vụ Gemini, quota và TTS; không nên cam kết mọi phản hồi luôn dưới 10 giây.
- Hệ thống hội thoại hiện hoạt động theo từng lượt; cần đợi thiết bị phát xong rồi mới nói tiếp. Chưa có wake word và khử tiếng vọng đầy đủ.
- Biểu đồ dashboard dùng các mẫu cảm biến nhận trong phiên trình duyệt; chưa phải hệ thống lưu lịch sử dài hạn.
- Bản demo điều khiển LED WS2812B, không điều khiển trực tiếp điện lưới.
- WebSocket hiện dùng `ws://` trong mạng tin cậy. Chưa nên mở trực tiếp ra Internet; bản triển khai thật cần bảo mật và phân quyền phù hợp.
- Kiểm thử tự động của backend dùng mô phỏng API; không thay cho kiểm tra Gemini thật, âm thanh và cảm biến trên board.

## 8. Công việc tiếp theo

1. Kiểm tra lại toàn bộ kết nối trong cùng một buổi: Wi-Fi, WebSocket, DHT22, OLED, mic và loa.
2. Chạy liên tiếp các ca bật/tắt đèn, hỏi cảm biến, hội thoại; ghi lại kết quả, số lần thành công và thời gian phản hồi.
3. Xác nhận trạng thái LED trên dashboard chỉ đổi sau ACK, đồng thời so với LED thật.
4. Chuẩn hóa hướng dẫn nạp firmware, cấu hình mạng và khởi chạy backend để nhóm khác tái hiện demo.
5. Bàn giao giao thức và yêu cầu cho đội ứng dụng; bổ sung API điện thoại, xác thực người dùng, phân quyền và lịch sử thiết bị.
6. Nếu phát triển thành sản phẩm, bổ sung bảo mật kết nối, kiểm tra nguồn/phần cứng và relay cách ly phù hợp trước khi điều khiển đèn điện lưới.

## 9. Kết luận

“Đến thời điểm hiện tại, nhóm đã xây dựng được nguyên mẫu AIoT gồm ESP32-S3, cảm biến môi trường, giao tiếp giọng nói với Gemini qua backend và dashboard giám sát trên máy tính. Một số luồng đã được nạp và thử thực tế; bước tiếp theo là kiểm thử ổn định toàn bộ phần cứng, ghi nhận số liệu demo và bàn giao giao thức cho nhóm phát triển ứng dụng điện thoại.”

## Gợi ý phân bổ thời gian báo cáo 5 phút

| Thời lượng | Nội dung |
| --- | --- |
| 30 giây | Đề tài và vấn đề cần giải quyết |
| 1 phút | Mục tiêu, kiến trúc và phần cứng |
| 1 phút | Các chức năng đã xây dựng |
| 1 phút 30 giây | Demo các nghiệp vụ cơ bản |
| 45 giây | Kết quả, giới hạn và lỗi còn cần xử lý |
| 15 giây | Kế hoạch tiếp theo và kết luận |
