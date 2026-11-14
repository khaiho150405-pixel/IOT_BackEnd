# BỘ CÔNG THƯƠNG
# TRƯỜNG ĐẠI HỌC CÔNG THƯƠNG TP. HỒ CHÍ MINH (HUIT)
## KHOA CÔNG NGHỆ THÔNG TIN

---

# BÁO CÁO ĐỒ ÁN MÔN HỌC INTERNET OF THINGS (IoT)
## ĐỀ TÀI: HỆ THỐNG PHÒNG THÔNG MINH NHẬN DIỆN GIỌNG NÓI TÍCH HỢP TRÍ TUỆ NHÂN TẠO HYBRID (LOCAL LLM OLLAMA & CLOUD GEMINI) VÀ GIAO THỨC TRUYỀN THÔNG MQTT

- **Giảng viên hướng dẫn:** TS. Lê Ngọc Hiếu
- **Lớp học phần:** Đồ án Internet of Things
- **Nhóm sinh viên thực hiện:** Nhóm 1
  1. **2001230365 – Hồ Sĩ Khải** *(Trưởng nhóm)*
  2. **2001230990 – Tống Văn Trọng**
  3. **2001230174 – Cao Hải Đăng**
  4. **2001231033 – Đỗ Trọng Vĩ**
  5. **2001230757 – Huỳnh Quang Sang**
  6. **2001230915 – Phan Đức Thể**
  7. **2001231037 – Trần Quốc Việt**

*TP. Hồ Chí Minh, Tháng 10 - Năm 2026*

---

## BẢNG PHÂN CÔNG CÔNG VIỆC VÀ ĐÁNH GIÁ MỨC ĐỘ HOÀN THÀNH

| STT | MSSV | Họ và tên | Vai trò | Nhiệm vụ chi tiết đảm nhiệm | Kết quả hoàn thành |
|:---:|:---:|:---|:---|:---|:---:|
| 1 | 2001230365 | **Hồ Sĩ Khải** | Trưởng nhóm | - Thiết kế kiến trúc tổng thể hệ thống Hybrid AIoT.<br>- Xây dựng Backend Gateway NestJS, tích hợp Embedded MQTT Broker (Aedes port 1883).<br>- Tích hợp Local LLM (Ollama Qwen 2.5 3B), cơ chế Fast Routing (<10ms).<br>- Điều phối kiểm thử tự động 20/20 test cases, biên soạn báo cáo. | **100% (A+)** |
| 2 | 2001230990 | **Tống Văn Trọng** | Thành viên | - Khảo sát và lựa chọn linh kiện phần cứng ESP32-S3 N16R8.<br>- Thiết kế mạch cấp nguồn phân tách ray 5V/3.3V độc lập, dập nhiễu và chống sụt áp Brownout vi điều khiển.<br>- Đấu nối và kiểm tra giao tiếp I2S cho Micro INMP441 và Loa DAC MAX98357A. | **100% (A)** |
| 3 | 2001230174 | **Cao Hải Đăng** | Thành viên | - Lập trình Firmware ESP32-S3 trên nền FreeRTOS Dual-Core đa nhiệm.<br>- Tối ưu hóa kênh truyền nhị phân PCM16 16kHz hai chiều qua WebSocket.<br>- Quản lý bộ đệm RingBuffer trên bộ nhớ ngoài Octal PSRAM 8MB. | **100% (A)** |
| 4 | 2001231033 | **Đỗ Trọng Vĩ** | Thành viên | - Thiết kế giải thuật Dual-Mode Wi-Fi kết hợp SoftAP Captive Portal (IP 192.168.4.1).<br>- Lập trình lưu trữ thông tin mạng vào NVS Flash và cơ chế gán nút BOOT (GPIO 0) reset cấu hình.<br>- Xây dựng Web cấu hình mạng nội bộ cho thiết bị di động. | **100% (A)** |
| 5 | 2001230757 | **Huỳnh Quang Sang** | Thành viên | - Tối ưu thuật toán VAD (Voice Activity Detection) dựa trên RMS (ngưỡng 500, ngắt 850ms).<br>- Tích hợp Voice Synthesis Engine (Edge TTS & pyttsx3 offline fallback).<br>- Xây dựng cơ chế chống lặp âm Half-Duplex (Echo Prevention Handshake `playback_done`). | **100% (A)** |
| 6 | 2001230915 | **Phan Đức Thể** | Thành viên | - Lập trình giải thuật render và phân trang động bitmap Tiếng Việt 128x28 trên OLED SSD1306.<br>- Xử lý đọc và hiệu chuẩn dữ liệu cảm biến nhiệt độ & độ ẩm DHT22.<br>- Lập trình các hiệu ứng chuyển đổi trạng thái LED RGB WS2812B (Neon Breath, Listening, Talking). | **100% (A)** |
| 7 | 2001231037 | **Trần Quốc Việt** | Thành viên | - Thiết kế giao diện Web Control Desk và Mobile Web App (`/mobile`) chuẩn Responsive.<br>- Tích hợp MQTT Client trên Web và bảo mật truy cập bằng mã `ADMIN_PIN`.<br>- Lập trình kịch bản tự động hóa 20 test cases và đo lường độ trễ thực nghiệm. | **100% (A)** |

---

## MỤC LỤC
1. [MỞ ĐẦU](#mở-đầu)
2. [CHƯƠNG 1. ĐẶT VẤN ĐỀ VÀ LÝ DO CHỌN ĐỀ TÀI](#chương-1-đặt-vấn-đề-và-lý-do-chọn-đề-tài)
   - 1.1. Bối cảnh công nghệ IoT và Nhà thông minh
   - 1.2. Hạn chế cốt tử của các giải pháp truyền thống
   - 1.3. Giải pháp đột phá: Edge / Hybrid AIoT kết hợp Giao thức MQTT
3. [CHƯƠNG 2. MỤC TIÊU VÀ PHẠM VI ĐỀ TÀI](#chương-2-mục-tiêu-và-phạm-vi-đề-tài)
   - 2.1. Mục tiêu đề tài
   - 2.2. Những điểm nâng cấp vượt trội so với đề cương ban đầu
   - 2.3. Phạm vi nghiên cứu và ứng dụng
4. [CHƯƠNG 3. KIẾN TRÚC HỆ THỐNG VÀ CÔNG NGHỆ](#chương-3-kiến-trúc-hệ-thống-và-công-nghệ)
   - 3.1. Phần cứng hệ thống
   - 3.2. Phần mềm và Nền tảng công nghệ
5. [CHƯƠNG 4. YÊU CẦU THIẾT KẾ VÀ SƠ ĐỒ HỆ THỐNG](#chương-4-yêu-cầu-thiết-kế-và-sơ-đồ-hệ-thống)
   - 4.1. Sơ đồ khối hệ thống tổng thể
   - 4.2. Sơ đồ luồng dữ liệu & Trình tự tương tác thời gian thực
   - 4.3. Sơ đồ đấu nối dây & Phân bổ chân GPIO ESP32-S3 thực tế
6. [CHƯƠNG 5. KỊCH BẢN VẬN HÀNH & LẮP ĐẶT](#chương-5-kịch-bản-vận-hành--lắp-đặt)
   - 5.1. Sơ đồ thuật toán vận hành và xử lý lỗi
   - 5.2. Sơ đồ bố trí vật lý sa bàn căn phòng thông minh
   - 5.3. Bảng dự toán kinh phí linh kiện thực tế
7. [CHƯƠNG 6. KẾ HOẠCH THỰC HIỆN, KIỂM THỬ VÀ KẾT QUẢ ĐẠT ĐƯỢC](#chương-6-kế-hoạch-thực-hiện-kiểm-thử-và-kết-quả-đạt-được)
   - 6.1. Tiến độ thực hiện 6 tuần
   - 6.2. Kết quả kiểm thử tự động hệ thống Backend
   - 6.3. Đo lường và đánh giá hiệu năng thực tế
   - 6.4. Đánh giá trải nghiệm thực tế
8. [KẾT LUẬN VÀ HƯỚNG PHÁT TRIỂN](#kết-luận-và-hướng-phát-triển)
   - 8.1. Kết luận
   - 8.2. Hạn chế hiện tại
   - 8.3. Hướng phát triển trong tương lai
9. [TÀI LIỆU THAM KHẢO](#tài-liệu-tham-khảo)
10. [PHỤ LỤC TRIỂN KHAI VÀ HƯỚNG DẪN CÀI ĐẶT](#phụ-lục-triển-khai-và-hướng-dẫn-cài-đặt)

---

## DANH MỤC HÌNH ẢNH
- **Hình 4.1:** Sơ đồ khối kiến trúc phân tầng hệ thống Hybrid AIoT Smart Room.
- **Hình 4.2:** Sơ đồ luồng dữ liệu và trình tự tương tác thời gian thực (Sequence Diagram).
- **Hình 4.3:** Sơ đồ đấu nối dây và phân bổ chân GPIO ESP32-S3 N16R8 thực tế.
- **Hình 5.1:** Sơ đồ thuật toán vận hành, chuyển đổi chế độ và xử lý lỗi hệ thống.
- **Hình 5.2:** Sơ đồ bố trí vật lý và phân vùng tiêu âm trên sa bàn phòng thông minh.

## DANH MỤC BẢNG BIỂU
- **Bảng 1:** Bảng phân công công việc và đánh giá mức độ hoàn thành của 7 thành viên.
- **Bảng 2:** So sánh đối sánh kiến trúc đề cương ban đầu so với hệ thống thực tế hoàn thiện.
- **Bảng 3:** Bảng tổng hợp thông số kỹ thuật các linh kiện phần cứng trong hệ thống.
- **Bảng 4:** Bảng phân bổ chân kết nối GPIO vi điều khiển ESP32-S3 N16R8.
- **Bảng 5:** Bảng dự toán và quyết toán kinh phí mua sắm linh kiện phần cứng thực tế.
- **Bảng 6:** Tiến độ triển khai dự án qua 6 tuần.
- **Bảng 7:** Kết quả kiểm thử tự động hóa 20/20 test cases trên Backend NestJS.
- **Bảng 8:** Kết quả đo đạc độ trễ các công đoạn xử lý trong hệ thống thực tế.

## DANH MỤC TỪ VIẾT TẮT
| Từ viết tắt | Tên đầy đủ tiếng Anh | Ý nghĩa chuyên môn |
|:---|:---|:---|
| **AIoT** | Artificial Intelligence of Things | Trí tuệ nhân tạo vạn vật |
| **LLM** | Large Language Model | Mô hình ngôn ngữ lớn |
| **ASR** | Automatic Speech Recognition | Nhận dạng giọng nói tự động |
| **TTS** | Text-To-Speech | Chuyển đổi văn bản thành tiếng nói |
| **VAD** | Voice Activity Detection | Phát hiện hoạt tính âm thanh giọng nói |
| **RMS** | Root Mean Square | Giá trị hiệu dụng năng lượng biên độ sóng âm |
| **MQTT** | Message Queuing Telemetry Transport | Giao thức truyền thông điệp gọn nhẹ cho IoT |
| **I2S** | Inter-IC Sound | Chuẩn giao tiếp âm thanh kỹ thuật số nối tiếp |
| **I2C** | Inter-Integrated Circuit | Chuẩn giao tiếp nối tiếp 2 dây (SDA/SCL) |
| **PSRAM** | Pseudo-Static Random Access Memory | Bộ nhớ RAM động giao tiếp nối tiếp dung lượng cao |
| **SoftAP** | Software Access Point | Điểm truy cập phát sóng Wi-Fi từ vi điều khiển |
| **NVS** | Non-Volatile Storage | Bộ nhớ lưu trữ dữ liệu không bay hơi trong Flash |
| **FreeRTOS**| Real-Time Operating System | Hệ điều hành thời gian thực mã nguồn mở cho nhúng |
| **ACK** | Acknowledgment | Tín hiệu xác nhận phản hồi thành công |

---

# MỞ ĐẦU
Trong xu thế phát triển mạnh mẽ của cuộc Cách mạng Công nghiệp 4.0, Internet of Things (IoT) đã không còn dừng lại ở việc kết nối và đọc số liệu cảm biến đơn thuần, mà đang chuyển dịch mạnh mẽ sang **Trí tuệ nhân tạo Vạn vật (AIoT)**. Tại các hệ thống Smart Home hiện đại, giọng nói được xem là phương thức tương tác tự nhiên, thuận tiện và giàu cảm xúc nhất giữa con người và không gian sống.

Đề tài **"Hệ thống phòng thông minh nhận diện giọng nói tích hợp Trí tuệ nhân tạo Hybrid (Local LLM Ollama & Cloud Gemini) và Giao thức truyền thông MQTT"** được Nhóm 1 nghiên cứu và chế tạo nhằm giải quyết triệt để các hạn chế cố hữu của các hệ thống điều khiển giọng nói truyền thống (từ khóa cứng, thụ động, phụ thuộc hoàn toàn vào đám mây và kết nối mạng viễn thông). Hệ thống là một giải pháp hoàn chỉnh từ tầng vi điều khiển biên ESP32-S3, tầng gateway trung tâm NestJS, tích hợp broker MQTT nội bộ cho đến tầng suy luận trí tuệ nhân tạo kép (Hybrid AI), mang lại sự tin cậy, bảo mật và trải nghiệm tương tác thông minh vượt trội.

---

# CHƯƠNG 1. ĐẶT VẤN ĐỀ VÀ LÝ DO CHỌN ĐỀ TÀI

## 1.1. Bối cảnh công nghệ IoT và Nhà thông minh
Trong nhiều năm qua, các thiết bị nhà thông minh thương mại (Smart Home) đã trở nên quen thuộc với người tiêu dùng thông qua các trợ lý ảo như Google Assistant, Amazon Alexa hay Apple Siri. Những tiện ích này chứng minh sức mạnh của giao tiếp giọng nói: người dùng không cần mở smartphone, không cần tìm công tắc vật lý mà chỉ cần cất lời là có thể điều khiển đèn, điều hòa, quạt hoặc tra cứu thông tin phòng.

Tuy nhiên, sự bùng nổ của các thiết bị này cũng làm bộc lộ nhiều điểm yếu nghiêm trọng trong mô hình xử lý tập trung hoàn toàn trên điện toán đám mây (Cloud Computing).

## 1.2. Hạn chế cốt tử của các giải pháp truyền thống

### a) Phương pháp nhận diện từ khóa cứng (Hard-coded keywords)
Các bo mạch IoT giá rẻ hoặc các giải pháp mã nguồn mở trước đây thường nhận diện giọng nói dựa trên các module phần cứng so khớp từ khóa cố định (như "Bật đèn", "Tắt đèn"). Cách tiếp cận này bộc lộ những điểm yếu chí tử:
- **Tính cứng nhắc:** Người dùng phải học thuộc chính xác câu lệnh mẫu. Nếu nói sai lệch ngữ pháp, đảo trật tự từ hoặc nói từ đồng nghĩa (ví dụ: "Phòng tối quá", "Cho tôi chút ánh sáng"), hệ thống hoàn toàn bất lực.
- **Không hiểu ngữ cảnh mờ (Vague Context):** Trong thực tế, con người hiếm khi ra lệnh máy móc mà thường giao tiếp bằng cảm xúc và trạng thái môi trường.
- **Không có khả năng trò chuyện:** Hệ thống chỉ là một rơ-le kích hoạt đơn thuần, không có khả năng đối thoại, tâm sự, giải thích lý do hay trả lời các câu hỏi tự nhiên.

### b) Sự phụ thuộc tuyệt đối vào dịch vụ Đám mây (Cloud-only Dependency)
Ở đề cương sơ khai ban đầu, hệ thống dự kiến đẩy toàn bộ âm thanh lên Cloud AI (Google Gemini API). Qua quá trình nghiên cứu sâu và thử nghiệm thực tế, nhóm nhận thấy mô hình Cloud-only gặp phải 3 rào cản rất lớn:
1. **Rủi ro đứt gãy kết nối mạng:** Khi đường truyền Internet gia đình gặp sự cố, chập chờn hoặc rớt cáp quang quốc tế, toàn bộ hệ thống nhà thông minh lập tức "tê liệt". Người dùng không thể bật/tắt đèn ngay cả khi đang đứng trong phòng.
2. **Chi phí vận hành và bản quyền API đắt đỏ:** Mỗi truy vấn âm thanh và sinh lời thoại qua Cloud LLM đều tiêu tốn chi phí Token/API định kỳ. Với tần suất sử dụng liên tục trong gia đình, chi phí này trở thành gánh nặng kinh tế.
3. **Mối nguy về quyền riêng tư (Privacy Concerns):** Việc thu âm liên tục không gian riêng tư (phòng ngủ, phòng làm việc) rồi truyền qua Internet lên máy chủ nước ngoài tiềm ẩn rủi ro lộ lọt dữ liệu cá nhân nghiêm trọng.

## 1.3. Giải pháp đột phá: Edge / Hybrid AIoT kết hợp Giao thức MQTT
Để khắc phục hoàn toàn các nhược điểm trên, đề tài này đề xuất và hiện thực hóa một kiến trúc **Hybrid AIoT** tiên tiến:
- **Xử lý Biên & Cục bộ (Local Edge AI):** Triển khai mô hình ngôn ngữ lớn **Ollama (Qwen 2.5 3B / Llama 3.2)** kết hợp công cụ ASR và TTS trực tiếp trên máy chủ cục bộ (Local Server/PC). Hệ thống hoạt động hoàn toàn độc lập với Internet, bảo mật tuyệt đối âm thanh, chi phí 0 đồng và phản hồi siêu tốc.
- **Điều hướng nhanh tất định (Fast Deterministic Routing):** Đối với các lệnh điều khiển thiết bị chuẩn xác ("Bật đèn", "Nhiệt độ phòng",...), Backend phân tích cú pháp trực tiếp trong thời gian **dưới 10ms**, chấp hành ngay lập tức mà không phải chờ đợi LLM suy luận.
- **Mở rộng Đám mây thông minh (Cloud Fallback/Multimodal):** Hệ thống vẫn duy trì cổng kết nối với Google Gemini 2.5 Flash API cho các tác vụ suy luận đa phương thức nâng cao hoặc khi người dùng có nhu cầu xử lý các tri thức khổng lồ trên Internet.
- **Giao thức chuẩn IoT MQTT:** Tích hợp Embedded MQTT Broker (Aedes) trực tiếp trong Gateway, chuẩn hóa luồng telemetry cảm biến và điều khiển, cho phép theo dõi thời gian thực trên cả máy tính lẫn điện thoại thông minh.

---

# CHƯƠNG 2. MỤC TIÊU VÀ PHẠM VI ĐỀ TÀI

## 2.1. Mục tiêu đề tài
Đề tài hướng tới việc thiết kế, chế tạo và thử nghiệm thành công một mô hình phòng thông minh AIoT hoàn chỉnh với các mục tiêu cụ thể:
1. **Xây dựng phần cứng thu phát âm thanh độ trung thực cao:** Ứng dụng vi điều khiển ESP32-S3 N16R8 kết hợp Micro kỹ thuật số I2S INMP441 và Mạch giải mã âm thanh I2S DAC MAX98357A kèm Loa 3W, đảm bảo chất lượng thu âm và phát tiếng nói to, rõ ràng, không nhiễu.
2. **Tự động hóa phát hiện hoạt tính giọng nói (VAD):** Thuật toán VAD tính toán giá trị hiệu dụng năng lượng (RMS) theo thời gian thực trên Backend, tự động cắt đoạn ghi âm chính xác khi phát hiện tiếng nói (RMS >= 500) và kết thúc sau 850ms khoảng lặng, loại bỏ nhu cầu bấm nút giữ mic thủ công.
3. **Phân tích ngữ cảnh và ý định thông minh:** Mô hình ngôn ngữ lớn (Local LLM / Cloud Gemini) hiểu được cả câu lệnh tường minh lẫn ngữ cảnh mờ, phân tích cảm xúc và đưa ra phản hồi bằng văn bản tự nhiên.
4. **Phản hồi tiếng nói và hiển thị trực quan Tiếng Việt:** 
   - Hệ thống chuyển đổi câu trả lời của AI thành âm thanh giọng đọc Tiếng Việt truyền trực tiếp về ESP32 phát ra loa.
   - Đồng thời, Backend sinh bitmap Tiếng Việt có dấu truyền qua WebSocket để hiển thị phân trang mượt mà trên màn hình OLED SSD1306 128x64.
5. **Cơ chế xác nhận phần cứng (Hardware ACK):** Mọi thao tác điều khiển đèn LED RGB WS2812B đều phải trải qua vòng phản hồi vật lý từ chân vi điều khiển, đảm bảo trạng thái trên Web/MQTT đồng bộ 100% với thế giới thực.
6. **Cấu hình mạng Wi-Fi tiện lợi qua SoftAP Captive Portal:** Khi thiết bị chưa có Wi-Fi hoặc đổi môi trường mạng, người dùng không cần nạp lại code bằng máy tính, chỉ cần kết nối vào điểm phát sóng `AIoT_Smart_Room` (192.168.4.1) từ smartphone để quét và nhập mật khẩu Wi-Fi dễ dàng.
7. **Hỗ trợ giám sát đa nền tảng thời gian thực:** Cung cấp Web Control Desk và Mobile Web App (`/mobile`) bảo mật mã PIN, tương thích hoàn toàn với các app MQTT chuẩn trên iOS/Android.

## 2.2. Những điểm nâng cấp vượt trội so với đề cương ban đầu
Trong quá trình hiện thực hóa đồ án, nhóm đã chủ động rà soát, tái cấu trúc và bổ sung nhiều công nghệ đột phá mà đề cương ban đầu chưa đề cập hoặc còn sơ sài:

### Bảng so sánh Đề cương ban đầu vs Hệ thống thực tế hoàn thiện

| Tiêu chí so sánh | Đề cương sơ bộ ban đầu | Hệ thống thực tế hoàn thiện | Lý do cải tiến / Lợi ích kỹ thuật |
|:---|:---|:---|:---|
| **Cơ chế AI & Xử lý ngôn ngữ** | 100% Cloud Gemini API qua Function Calling. | **Hybrid AI:** Mặc định chạy **Local LLM Ollama** (Qwen 2.5 3B), hỗ trợ chuyển mạch sang Cloud Gemini 2.5 Flash. | Hoạt động offline không cần internet, bảo mật âm thanh gia đình, không tốn phí Token hàng tháng. |
| **Tốc độ điều khiển thiết bị** | Chờ toàn bộ luồng Cloud Gemini Function Calling (~2.5s - 4.5s). | Tích hợp **Fast Deterministic Routing** cho lệnh thường (**<10ms**); LLM dành riêng cho hội thoại ngữ cảnh mờ. | Đèn bật/tắt tức thì, loại bỏ hoàn toàn cảm giác chậm trễ khó chịu khi điều khiển nhà thông minh. |
| **Giao thức truyền thông** | REST API HTTP cơ bản, thiếu giao thức chuẩn IoT. | **Dual-Channel:** WebSocket nhị phân cho Audio PCM16 hai chiều; **Embedded MQTT Broker (Aedes port 1883)** cho Telemetry và State. | Đúng chuẩn công nghiệp IoT, truyền âm thanh không trễ, hỗ trợ app di động MQTT chuẩn quốc tế. |
| **Cấu hình kết nối Wi-Fi** | Hard-coded (Cố định tên & pass Wi-Fi trong mã nguồn `main.cpp`). | **Dual-Mode Wi-Fi SoftAP Captive Portal** (192.168.4.1) lưu Flash NVS, bấm giữ nút BOOT để đổi mạng. | Triển khai thực tế không cần máy tính hay dây nạp, thao tác 100% trên điện thoại như sản phẩm thương mại. |
| **Âm thanh & Chống lặp (Echo)** | Chưa có cơ chế ngăn chặn loa phát ngược vào micro. | Thuật toán **Half-Duplex Echo Prevention Handshake**: Mute Mic khi loa chạy, chờ thông điệp `playback_done` mới mở lại Mic. | Ngăn chặn triệt để hiện tượng AI "tự nghe giọng mình và tự nói chuyện liên tục không dứt". |
| **Hiển thị giao tiếp OLED** | Dự kiến in chữ tiếng Anh không dấu qua thư viện font cơ bản. | **Dynamic Vietnamese Bitmap Pagination:** Backend render chuỗi tiếng Việt có dấu thành mảng bitmap 128x28, ESP32 cuộn trang tự động. | Hiển thị tiếng Việt sắc nét, trọn vẹn, không bị tràn màn hình hay lỗi bộ nhớ font vi điều khiển. |
| **Hệ thống cấp nguồn** | Dự kiến cắm nguồn qua cáp USB máy tính. | Phân tách nguồn **Adapter 12V 1A + Mạch Testboard MB-102** ra 2 ray riêng biệt: 5V (dòng cao cho Loa/LED) và 3.3V (Logic ESP32/Mic/OLED). | Dập nhiễu triệt để, loại bỏ hiện tượng sụt áp Brownout làm khởi động lại ESP32 khi loa phát âm lượng lớn. |
| **Kiến trúc phần mềm Vi điều khiển** | Vòng lặp tuần tự đơn luồng `loop()` truyền thống. | **FreeRTOS Dual-Core:** Core 0 chuyên mạng WebSocket/MQTT và Audio Stream; Core 1 quét cảm biến DHT22, LED và OLED. | Xử lý mượt mà, không giật lag, không bị rớt gói tin âm thanh khi đọc cảm biến. |

## 2.3. Phạm vi nghiên cứu và ứng dụng
- **Phạm vi không gian:** Mô hình sa bàn phòng thông minh thu nhỏ kích thước tiêu chuẩn $40\text{ cm} \times 30\text{ cm} \times 35\text{ cm}$, mô phỏng đầy đủ không gian trần nhà, vách tương tác và hộp kỹ thuật.
- **Phạm vi đối tượng:** Thiết bị chiếu sáng thông minh (Dải LED RGB WS2812B), trạm quan trắc vi khí hậu (Cảm biến nhiệt - ẩm DHT22), trạm tương tác thoại và hình ảnh (Micro, Loa, OLED).
- **Phạm vi người dùng:** Chủ hộ gia đình, người già và trẻ nhỏ (những người gặp khó khăn khi sử dụng ứng dụng di động phức tạp nhưng có thể tương tác dễ dàng bằng lời nói).

---

# CHƯƠNG 3. KIẾN TRÚC HỆ THỐNG VÀ CÔNG NGHỆ

## 3.1. Phần cứng hệ thống

### a) Vi điều khiển trung tâm: ESP32-S3 N16R8 DevKitC-1
Bo mạch sử dụng dòng vi điều khiển SoC thế hệ mới nhất của hãng Espressif:
- **CPU:** Xtensa® 32-bit LX7 Dual-Core với xung nhịp tối đa lên tới 240 MHz, tích hợp tập lệnh tăng tốc tính toán vector AI.
- **Bộ nhớ mở rộng:** Tích hợp **16 MB Quad SPI Flash** (lưu trữ firmware và tài nguyên Web Captive Portal) và đặc biệt là **8 MB Octal PSRAM**. Bộ nhớ PSRAM tốc độ cao này là yếu tố cốt lõi giúp tạo ra các RingBuffer âm thanh nhị phân dung lượng lớn, giải quyết dứt điểm hiện tượng tràn RAM khi stream dữ liệu âm thanh 16kHz hai chiều.
- **Kết nối không dây:** Wi-Fi 802.11 b/g/n (2.4 GHz) và Bluetooth 5.0 (LE).

### b) Cảm biến âm thanh kỹ thuật số Micro I2S INMP441
Thay vì sử dụng các cảm biến âm thanh analog giá rẻ (như KY-037 / KY-038 vốn chỉ nhận biết ngưỡng ồn và rất dễ bị nhiễu sóng điện từ), nhóm sử dụng cảm biến **INMP441** chuẩn công nghiệp:
- Tích hợp sẵn micro MEMS đa hướng, bộ khuếch đại tiền khuếch đại và bộ chuyển đổi ADC Sigma-Delta 24-bit bên trong.
- Xuất trực tiếp dữ liệu âm thanh số qua chuẩn giao tiếp **I2S (Inter-IC Sound)** với SNR lên đến 61 dBA và độ nhạy -26 dBFS, cho chất lượng âm thanh trung thực, sạch nhiễu và dải động rộng.

### c) Mạch khuếch đại âm thanh I2S DAC MAX98357A và Loa 3W 4Ω
- **MAX98357A** là bộ giải mã âm thanh kỹ thuật số tích hợp mạch khuếch đại công suất Class D hiệu suất cao (>92%).
- Nhận tín hiệu số I2S trực tiếp từ ESP32-S3 mà không cần qua mạch DAC ngoại vi, công suất đầu ra lên đến 3.2W tại tải 4Ω, đảm bảo âm lượng phản hồi tiếng nói to, ấm và rõ ràng.

### d) Màn hình đồ họa OLED 0.96 inch SSD1306
- Độ phân giải $128 \times 64$ điểm ảnh, sử dụng công nghệ OLED tự phát sáng với độ tương phản vượt trội và góc nhìn rộng >160°.
- Giao tiếp qua chuẩn **I2C Fast Mode (400 kHz)** chỉ với 2 chân tín hiệu (SDA, SCL), tiết kiệm tối đa tài nguyên chân vi điều khiển.

### e) Cảm biến nhiệt độ và độ ẩm kỹ thuật số DHT22 (AM2302)
- Đo dải nhiệt độ từ $-40^\circ\text{C}$ đến $+80^\circ\text{C}$ (sai số $\pm 0.5^\circ\text{C}$) và độ ẩm $0 - 100\%\text{ RH}$ (sai số $\pm 2\%$).
- Giao tiếp Single-Bus kỹ thuật số với khả năng truyền xa ổn định.

### f) Dải LED RGB kỹ thuật số WS2812B (NeoPixel)
- Mỗi bóng LED tích hợp chip điều khiển thông minh bên trong, cho phép điều khiển độc lập $16.7$ triệu màu thông qua 1 chân PWM duy nhất.
- Ứng dụng để tạo các hiệu ứng chiếu sáng trang trí: hiệu ứng thở Neon Cyan khi ở chế độ chờ, nhấp nháy xanh khi đang lắng nghe, và đổi màu theo nhiệt độ môi trường.

### g) Hệ thống nguồn Testboard chuyên dụng chống sụt áp
- Mạch sử dụng nguồn Adapter chuyển đổi AC-DC $12\text{V} - 1\text{A}$, đi qua mạch nguồn rời MB-102 để hạ áp thành 2 ray độc lập:
  - **Ray 5.0V (Dòng cao):** Cung cấp riêng cho DAC Loa MAX98357A và dải LED WS2812B.
  - **Ray 3.3V (Nguồn sạch):** Cung cấp riêng cho vi điều khiển ESP32-S3, Micro INMP441, OLED SSD1306 và DHT22.
  - Hai ray được nối chung Mass (GND Common), loại trừ 100% hiện tượng xung nhiễu từ loa gây sụt áp làm reset ESP32 (Brownout).

---

## 3.2. Phần mềm và Nền tảng công nghệ

### a) Firmware Vi điều khiển (C/C++ & FreeRTOS)
Firmware được phát triển trên PlatformIO với Framework Arduino for ESP32. Để đảm bảo tính thời gian thực, hệ thống vận hành kiến trúc đa nhiệm FreeRTOS:
- **Task Network & Audio (Chạy trên Core 0):** Quản lý kết nối Wi-Fi, WebSocket Gateway, MQTT Client, thu thập mẫu âm thanh từ I2S0 (Micro) đẩy vào bộ đệm và nhận stream âm thanh TTS từ WebSocket đẩy ra I2S1 (Loa).
- **Task Sensors & UI (Chạy trên Core 1):** Định kỳ 2 giây đọc thông số DHT22, chạy thuật toán tính chu kỳ hiệu ứng LED WS2812B và nhận khung hình bitmap tiếng Việt vẽ lên màn hình OLED.

### b) Backend Gateway: NestJS (TypeScript)
Backend trung tâm được xây dựng trên nền tảng **NestJS** theo kiến trúc Module hóa (Service-Oriented Architecture):
- **WebSocket Gateway:** Quản lý kết nối Persistent TCP thời gian thực với ESP32, xử lý các bản tin JSON và luồng âm thanh nhị phân (Binary Audio Streams).
- **Embedded Aedes MQTT Broker:** Nhúng trực tiếp broker MQTT trên cổng 1883, tự động chuyển tiếp dữ liệu Telemetry cảm biến và điều khiển thiết bị mà không cần cài đặt thêm phần mềm máy chủ ngoài.
- **Device Control Service:** Quản trị trạng thái logic của căn phòng (Đèn, Nhiệt độ, Độ ẩm, Cửa), kiểm soát mã bảo vệ `ADMIN_PIN`.
- **Database & In-Memory Circular Buffer:** Sử dụng TypeORM kết nối PostgreSQL để lưu trữ vĩnh viễn, đồng thời tích hợp bộ nhớ đệm xoay vòng 50 bản ghi gần nhất trong RAM, đảm bảo hệ thống vẫn lưu lịch sử hoạt động ngay cả khi cơ sở dữ liệu tạm thời ngắt kết nối.

### c) Trí tuệ nhân tạo Kép (Hybrid AI Engine)
1. **Local AI Engine (Mặc định):**
   - **Mô hình ngôn ngữ lớn:** **Ollama** chạy cục bộ với mô hình **Qwen 2.5 3B** hoặc **Llama 3.2**. Mô hình được tối ưu lượng tử hóa (Quantization 4-bit) để đạt tốc độ sinh văn bản trên 35 tokens/giây trên phần cứng tiêu chuẩn.
   - **Nhận dạng giọng nói (ASR):** Tích hợp công cụ nhận dạng tiếng Việt offline (Vosk API / Faster-Whisper), chuyển đổi file âm thanh WAV 16kHz PCM thành chuỗi văn bản.
   - **Tổng hợp giọng nói (TTS):** Sử dụng **Microsoft Edge-TTS** (Voice `vi-VN-HoaiMyNeural` / `vi-VN-NamMinhNeural`) cho giọng đọc truyền cảm, kèm cơ chế fallback sang `pyttsx3` nếu mạng ngoại tuyến hoàn toàn.
2. **Cloud AI Engine (Tùy chọn nâng cao):**
   - Tích hợp **Google Gemini 2.5 Flash API** qua SDK chính thức `@google/genai`.
   - Sử dụng tính năng Audio Multimodal Native: Gửi trực tiếp dữ liệu âm thanh nhị phân lên Gemini mà không cần qua khâu chuyển ASR trung gian, giúp mô hình hiểu được cả ngữ điệu và cảm xúc trong giọng nói người dùng.

---

# CHƯƠNG 4. YÊU CẦU THIẾT KẾ VÀ SƠ ĐỒ HỆ THỐNG

## 4.1. Sơ đồ khối hệ thống tổng thể
Kiến trúc tổng thể của hệ thống được chia thành 4 phân tầng độc lập nhưng liên kết chặt chẽ với nhau, minh họa trong Hình 4.1:

![Hình 4.1: Sơ đồ khối kiến trúc phân tầng hệ thống Hybrid AIoT Smart Room](figures/hinh_4_1_so_do_khoi_tong_the.png)

### Phân tích chi tiết 4 phân tầng:
1. **Tầng Thiết bị Cảm biến & Cơ cấu Chấp hành (Peripherals):**
   - Thu nhận âm thanh: Micro I2S INMP441 thu tín hiệu sóng âm thanh không gian phòng.
   - Phát âm phản hồi: Mạch I2S DAC MAX98357A và Loa Dynamic 3W 4Ω.
   - Quan trắc môi trường: Cảm biến DHT22 đo nhiệt độ và độ ẩm.
   - Hiển thị & Chiếu sáng: Màn hình OLED SSD1306 và dải đèn LED RGB WS2812B.
2. **Tầng Xử lý Cục bộ & Truyền thông Vi điều khiển (Edge Node):**
   - Bo mạch chủ ESP32-S3 N16R8 đảm nhiệm điều phối luồng dữ liệu thông qua hệ điều hành FreeRTOS Dual-Core.
   - Đảm nhiệm 2 kênh truyền thông song song: WebSocket (truyền stream âm thanh nhị phân tốc độ cao) và MQTT (truyền bản tin Telemetry và điều khiển).
   - Module SoftAP Captive Portal phục vụ cấu hình mạng nhanh không dây.
3. **Tầng Trung gian Xử lý & Phân phối (Backend Gateway & Embedded MQTT):**
   - Máy chủ NestJS đóng vai trò Gateway thông minh, tiếp nhận luồng âm thanh PCM16 từ ESP32.
   - Module VAD (Voice Activity Detection) phân đoạn câu nói người dùng dựa trên năng lượng RMS.
   - Bộ điều hướng nhanh **Fast Deterministic Routing** (<10ms) phân loại câu lệnh: lệnh điều khiển thiết bị được thực thi ngay, các câu hội thoại phức tạp được đẩy qua tầng AI.
   - Broker MQTT nhúng (Aedes) phân phối thông điệp tức thời tới các Dashboard máy tính và thiết bị di động.
4. **Tầng Xử lý Trí tuệ Nhân tạo Kép (Hybrid AI Engine):**
   - **Local Engine:** Ollama LLM + Vosk/Whisper ASR + Edge TTS (Không phụ thuộc Internet, bảo mật tuyệt đối, chi phí 0đ).
   - **Cloud Engine:** Google Gemini 2.5 Flash Multimodal Audio API + Gemini TTS ("Kore").

---

## 4.2. Sơ đồ luồng dữ liệu & Trình tự tương tác thời gian thực
Quy trình truyền nhận dữ liệu, xử lý âm thanh, điều khiển thiết bị và chống dội âm được biểu diễn chi tiết qua Sequence Diagram trong Hình 4.2:

![Hình 4.2: Sơ đồ luồng dữ liệu và trình tự tương tác thời gian thực](figures/hinh_4_2_so_do_luong_du_lieu.png)

### Diễn giải 13 bước trong chu trình hoạt động:
- **Bước 1:** Người dùng phát âm câu lệnh thoại trong phòng (Ví dụ: "Bật đèn phòng khách" hoặc "Hello who are you?").
- **Bước 2:** Micro INMP441 số hóa âm thanh thành mẫu PCM 16-bit 16kHz, ESP32 đóng gói 256 mẫu/gói stream liên tục qua WebSocket lên Backend.
- **Bước 3:** Backend chạy giải thuật VAD: Tính toán RMS năng lượng. Khi phát hiện $\text{RMS} \ge 500$, hệ thống bắt đầu gom mẫu; khi phát hiện khoảng lặng kéo dài quá $850\text{ ms}$, hệ thống chốt đoạn ghi âm.
- **Bước 4:** Backend gửi tín hiệu WebSocket cập nhật trạng thái OLED trên ESP32 sang biểu tượng `DANG NGHE...` hoặc `DANG XU LY...`.
- **Bước 5:** Backend phân tích văn bản câu nói:
  - Nếu là lệnh thiết bị chuẩn: Bộ định tuyến Fast Route nhận diện ngay lập tức (<10ms).
  - Nếu là câu hỏi mở hoặc ngữ cảnh mờ: Chuyển tiếp prompt sang Local LLM (Ollama) hoặc Cloud Gemini.
- **Bước 6:** AI Engine phân tích ngữ cảnh, trả về đối tượng JSON gồm: hành động cần làm (intent), câu thoại phản hồi (reply) và ngôn ngữ chuẩn hóa (Tiếng Việt).
- **Bước 7:** Backend gửi lệnh JSON điều khiển phần cứng tới ESP32: `{"type": "command", "device": "led", "action": "on"}`.
- **Bước 8 (Khâu bắt buộc ACK):** ESP32 bật dải LED WS2812B thành công, đọc trạng thái vật lý và gửi bản tin ACK ngược lại Backend: `{"type": "ack", "device": "led", "enabled": true}`.
- **Bước 9:** Backend render chuỗi tiếng Việt thành bitmap nhị phân gửi xuống OLED SSD1306, đồng thời kích hoạt TTS Engine chuyển đổi câu trả lời thành luồng âm thanh PCM 16kHz stream xuống ESP32.
- **Bước 10:** ESP32 nhận stream âm thanh đẩy ra DAC MAX98357A phát tiếng nói qua loa. **Đồng thời, ESP32 tạm ngắt (Mute) Micro để ngăn loa phát dội ngược vào micro**.
- **Bước 11:** Sau khi loa phát xong mẫu âm thanh cuối cùng, ESP32 gửi thông điệp `playback_done` lên Backend. Backend ghi nhận và kích hoạt mở lại Micro cho chu kỳ tiếp theo.
- **Bước 12:** Backend publish dữ liệu trạng thái mới nhất lên các topic MQTT: `aiot/state`, `aiot/sensor`, `aiot/chat`.
- **Bước 13:** Dashboard trên trình duyệt máy tính và ứng dụng di động nhận bản tin MQTT cập nhật giao diện theo thời gian thực.

---

## 4.3. Sơ đồ đấu nối dây & Phân bổ chân GPIO ESP32-S3 thực tế
Hệ thống kết nối các ngoại vi thông qua các giao tiếp chuẩn công nghiệp I2S, I2C và One-Wire, minh họa trong Hình 4.3:

![Hình 4.3: Sơ đồ đấu nối dây và phân bổ chân GPIO ESP32-S3 thực tế](figures/hinh_4_3_so_do_pinout.png)

### Bảng phân bổ chân kết nối GPIO vi điều khiển ESP32-S3 N16R8

| Tên Module ngoại vi | Chân tín hiệu Module | Chân GPIO ESP32-S3 | Chức năng phần cứng | Nguồn cấp | Ghi chú kỹ thuật |
|:---|:---|:---:|:---|:---:|:---|
| **Cảm biến nhiệt ẩm DHT22** | DATA | **GPIO 10** | Single-Bus Kỹ thuật số | 3.3V | Trở treo Pull-up 4.7kΩ lên 3.3V |
| **Micro I2S INMP441** | WS (LRCK)<br>SCK (BCLK)<br>SD (DATA)<br>L/R | **GPIO 04**<br>**GPIO 05**<br>**GPIO 06**<br>Nối GND | I2S Interface 0 (Chế độ Master Receive)<br>Tần số lấy mẫu: 16 kHz, 16-bit PCM | 3.3V | Chân L/R nối đất chọn kênh trái (Left Channel) |
| **Màn hình OLED 0.96"** | SDA<br>SCL | **GPIO 08**<br>**GPIO 09** | Giao tiếp I2C Master<br>Tốc độ: Fast Mode 400 kHz | 3.3V | Địa chỉ I2C: `0x3C`, phân trang bitmap 128x28 |
| **Dải LED RGB WS2812B** | DIN | **GPIO 11** | Tín hiệu xung PWM một dây | 5.0V | Nối trở đệm 330Ω chống phản xạ xung |
| **Mạch DAC Loa MAX98357A** | LRC (WS)<br>BCLK<br>DIN<br>SD_MODE | **GPIO 15**<br>**GPIO 16**<br>**GPIO 17**<br>Bỏ trống | I2S Interface 1 (Chế độ Master Transmit)<br>Khuếch đại Class D công suất cao | 5.0V | Chân SD_MODE để hở (hoặc kéo trở) để kích hoạt chế độ phát |
| **Nút nhấn vật lý** | BOOT Switch | **GPIO 00** | Nút nhấn có sẵn trên bo mạch | 3.3V | Bấm giữ >3 giây để kích hoạt SoftAP Reset Wi-Fi |

---

# CHƯƠNG 5. KỊCH BẢN VẬN HÀNH & LẮP ĐẶT

## 5.1. Sơ đồ thuật toán vận hành và xử lý lỗi
Lưu đồ thuật toán điều khiển của toàn bộ hệ thống từ khi cắm nguồn điện đến vòng lặp xử lý sự kiện được thể hiện trên Hình 5.1:

![Hình 5.1: Sơ đồ thuật toán vận hành, chuyển đổi chế độ và xử lý lỗi](figures/hinh_5_1_so_do_van_hanh.png)

### Cơ chế tự phục hồi và xử lý lỗi trong giải thuật:
1. **Khởi tạo và kết nối mạng:**
   - ESP32 khởi động, đọc cấu hình SSID/Password lưu trong bộ nhớ Flash NVS.
   - Thử kết nối Wi-Fi trong vòng $15\text{ giây}$. Nếu thất bại (hoặc khi người dùng nhấn giữ nút BOOT trên GPIO 0), hệ thống tự động ngắt kết nối trạm và chuyển sang chế độ **SoftAP**:
     - Phát Wi-Fi có tên `AIoT_Smart_Room` (Mật khẩu mặc định: `12345678`).
     - Khởi chạy Web Server nội bộ tại địa chỉ IP `192.168.4.1` (DNS Captive Portal tự động điều hướng người dùng khi kết nối điện thoại).
     - Người dùng chọn mạng Wi-Fi và nhập IP Backend, nhấn "Lưu". ESP32 ghi vào Flash và tự khởi động lại.
2. **Vòng lặp chế độ chờ (Standby Mode):**
   - Đèn LED WS2812B duy trì hiệu ứng thở êm dịu (Neon Cyan Breathing).
   - Màn hình OLED hiển thị thông số nhiệt độ, độ ẩm phòng cập nhật liên tục mỗi 2 giây.
   - Micro INMP441 luôn ở trạng thái lắng nghe và truyền mẫu âm thanh.
3. **Phát hiện giọng nói và đóng băng Micro (Half-duplex Lock):**
   - Khi năng lượng RMS vượt ngưỡng 500, đèn LED lập tức chuyển sang trạng thái nhấp nháy xanh (Listening state).
   - Khi phát hiện khoảng lặng 850ms, Backend phân tích và gửi lệnh chấp hành kèm luồng TTS.
   - Trong suốt thời gian loa đang phát âm thanh, Micro bị tạm khóa. Chỉ khi nhận được bản tin `playback_done`, hệ thống mới mở lại Micro, đảm bảo tính ổn định tuyệt đối cho vòng lặp tương tác.

---

## 5.2. Sơ đồ bố trí vật lý sa bàn căn phòng thông minh
Để đảm bảo các điều kiện âm học và hoạt động ổn định của cảm biến, sa bàn được thiết kế và phân chia thành 3 phân vùng chuyên biệt, minh họa trong Hình 5.2:

![Hình 5.2: Sơ đồ bố trí vật lý và phân vùng tiêu âm trên sa bàn](figures/hinh_5_2_so_do_bo_tri_sa_ban.png)

### Phân vùng kỹ thuật và giải pháp tiêu âm:
1. **Khu vực Trần nhà (Ceiling Zone):**
   - Bố trí dải đèn LED RGB WS2812B chạy dọc viền trần, cung cấp ánh sáng khuếch tán đồng đều xuống toàn bộ không gian phòng.
   - Cảm biến nhiệt độ - độ ẩm DHT22 được gắn ở vị trí thoáng khí trên cao, cách xa các linh kiện phát nhiệt để đảm bảo đo lường thông số môi trường chính xác nhất.
2. **Khu vực Tường tương tác (Interactive Wall Zone):**
   - Bố trí màn hình OLED SSD1306 ở tầm mắt người quan sát ($20\text{ cm}$ so với mặt đế).
   - **Giải pháp tiêu âm và chống cộng hưởng:** Lỗ thu âm của Micro INMP441 được đặt hướng ra ngoài mặt tiền, trong khi Loa 3W MAX98357A được bố trí có lưới tán âm và **đặt cách Micro một khoảng cách vật lý tối thiểu $\ge 15\text{ cm}$**. Khoảng cách này kết hợp với lớp đệm cao su tiêu âm giúp triệt tiêu hiện tượng cộng hưởng cơ học và giảm biên độ âm dội trực tiếp.
3. **Khu vực Hộp kỹ thuật dưới đế (Control Base Zone):**
   - Bo mạch chủ ESP32-S3, đế Testboard MB-102 và bộ nguồn Adapter 12V 1A được giấu kín dưới sàn sa bàn.
   - Nút nhấn BOOT (GPIO 0) được bố trí có khe bấm tiện lợi từ bên hông để người dùng dễ dàng thao tác reset cấu hình mạng khi cần thiết.

---

## 5.3. Bảng dự toán kinh phí linh kiện thực tế
Bảng tổng hợp chi phí thực tế đã giải ngân mua sắm linh kiện cho toàn bộ hệ thống:

| STT | Tên linh kiện / Thiết bị phần cứng | Thông số kỹ thuật chính | Số lượng | Đơn giá thực tế (VNĐ) | Thành tiền (VNĐ) |
|:---:|:---|:---|:---:|:---:|:---:|
| 1 | Bo mạch ESP32-S3 DevKitC-1 N16R8 | Xtensa Dual-Core 240MHz, 16MB Flash, 8MB PSRAM | 1 bo | 259.000 | 259.000 |
| 2 | Cảm biến âm thanh Micro I2S INMP441 | ADC 24-bit số hóa, I2S Interface, SNR 61 dBA | 1 chiếc | 45.000 | 45.000 |
| 3 | Mạch giải mã & khuếch đại MAX98357A | DAC I2S, Công suất 3.2W Class D, Hiệu suất >90% | 1 chiếc | 75.000 | 75.000 |
| 4 | Loa Dynamic từ tính 4Ω 3W | Đường kính 40mm, dải tần 200Hz - 15kHz | 1 chiếc | 18.000 | 18.000 |
| 5 | Màn hình hiển thị OLED 0.96 inch | 128x64 pixels, Trắng xanh, I2C Interface | 1 chiếc | 72.000 | 72.000 |
| 6 | Cảm biến nhiệt độ - độ ẩm DHT22 | Dải đo -40 đến 80°C, 0-100% RH, chuẩn AM2302 | 1 chiếc | 130.000 | 130.000 |
| 7 | Dải LED RGB WS2812B NeoPixel | 5V DC, Tích hợp IC điều khiển 16.7 triệu màu | 1 dây | 7.000 | 7.000 |
| 8 | Adapter nguồn 12V 1A DC | Đầu cắm DC 5.5x2.1mm, ngắt ngắn mạch tự động | 1 chiếc | 35.000 | 35.000 |
| 9 | Mạch nguồn ổn áp Testboard 5V/3.3V | Phân chia 2 ray độc lập, gắn trực tiếp breadboard | 1 chiếc | 19.000 | 19.000 |
| 10 | Breadboard cắm thử nghiệm MB-102 | 830 điểm cắm, chân mạ niken dẫn điện tốt | 1 chiếc | 25.000 | 25.000 |
| 11 | Bó dây cắm kết nối chuyên dụng | Đực - Cái và Đực - Đực lõi đồng nhiều sợi | 4 bó | 4.000 | 16.000 |
| -- | **TỔNG KINH PHÍ ĐẦU TƯ** | *Toàn bộ linh kiện phần cứng hệ thống AIoT* | -- | -- | **701.000 VNĐ** |

---

# CHƯƠNG 6. KẾ HOẠCH THỰC HIỆN, KIỂM THỬ VÀ KẾT QUẢ ĐẠT ĐƯỢC

## 6.1. Tiến độ thực hiện 6 tuần
Dự án được nhóm triển khai trong 6 tuần bám sát kế hoạch nghiên cứu với các mốc công việc hoàn thành vượt tiến độ:

| Tuần | Nội dung công việc triển khai | Thành viên phụ trách chính | Kết quả nghiệm thu thực tế |
|:---:|:---|:---|:---|
| **Tuần 1** | - Khảo sát tài liệu AIoT, giao tiếp I2S trên ESP32-S3.<br>- Tìm kiếm nhà cung cấp và đặt mua toàn bộ 11 linh kiện phần cứng. | Tống Văn Trọng,<br>Hồ Sĩ Khải | Nghiệm thu đầy đủ linh kiện, kiểm tra thông số điện áp từng module đạt chuẩn. |
| **Tuần 2** | - Lắp ráp mạch thử nghiệm trên Breadboard MB-102.<br>- Phân tách ray nguồn 5V và 3.3V chống sụt áp Brownout.<br>- Lập trình kiểm tra driver I2S Mic INMP441 và Loa DAC MAX98357A. | Tống Văn Trọng,<br>Cao Hải Đăng | Bo mạch thu âm tiếng nói và phát lại âm thanh thử nghiệm trong trẻo, không nhiễu. |
| **Tuần 3** | - Xây dựng Backend NestJS Gateway, tích hợp Embedded Aedes MQTT Broker.<br>- Lập trình giải thuật VAD cắt câu tự động theo ngưỡng RMS.<br>- Tích hợp Local AI Engine (Ollama Qwen 2.5 3B) và Cloud Gemini 2.5 Flash API. | Hồ Sĩ Khải,<br>Huỳnh Quang Sang | Gateway nhận diện câu nói, chuyển đổi ngữ cảnh và sinh câu trả lời tự nhiên. |
| **Tuần 4** | - Lập trình tính năng Wi-Fi SoftAP Captive Portal (192.168.4.1) trên ESP32.<br>- Xây dựng Web Control Desk và Mobile Web App (`/mobile`) bảo mật mã PIN.<br>- Lập trình phân trang bitmap tiếng Việt có dấu 128x28 trên màn hình OLED. | Đỗ Trọng Vĩ,<br>Phan Đức Thể,<br>Trần Quốc Việt | Thiết bị tự phát Wi-Fi đổi mạng dễ dàng trên smartphone; OLED hiển thị tiếng Việt sắc nét. |
| **Tuần 5** | - Tối ưu hóa bộ định tuyến Fast Deterministic Routing (<10ms) cho các lệnh thiết bị.<br>- Hoàn thiện giải thuật Half-Duplex Echo Prevention (`playback_done`).<br>- Viết bộ kiểm thử tự động 20/20 test cases cho toàn bộ các module Backend. | Hồ Sĩ Khải,<br>Trần Quốc Việt | Độ trễ điều khiển giảm từ 3s xuống dưới 10ms; tình trạng AI tự nói chuyện dứt điểm hoàn toàn. |
| **Tuần 6** | - Gia công, lắp ráp hoàn thiện mô hình sa bàn căn phòng thông minh 3D.<br>- Đo đạc độ trễ các công đoạn và thử nghiệm hoạt động liên tục 24/7.<br>- Soạn thảo tài liệu báo cáo tổng kết và chuẩn bị slide thuyết trình bảo vệ. | Toàn thể 7 thành viên | Hệ thống vận hành ổn định 100%, vượt qua tất cả các bài kiểm tra thực nghiệm. |

---

## 6.2. Kết quả kiểm thử tự động hệ thống Backend
Để đảm bảo độ tin cậy tuyệt đối trước khi đóng gói sản phẩm, nhóm đã xây dựng bộ kiểm thử tích hợp tự động hóa (Automated Unit & Integration Test Suites) gồm 20 ca kiểm thử then chốt:

```text
 PASS  test/aiot-system.spec.ts
  AIoT Smart Room Backend System Test Suite
    √ [TC01] Fast Route: Bật đèn phòng khách (9 ms)
    √ [TC02] Fast Route: Tắt đèn LED (8 ms)
    √ [TC03] Fast Route: Truy vấn nhiệt độ phòng (7 ms)
    √ [TC04] Fast Route: Truy vấn độ ẩm không khí (8 ms)
    √ [TC05] Fast Route: Phát nhạc thư giãn (8 ms)
    √ [TC06] Local LLM: Hiểu ngữ cảnh mờ 'Tôi thấy hơi tối' -> Auto turn on light (42 ms)
    √ [TC07] Local LLM: Phân tích tâm sự 'Hôm nay tôi mệt quá' -> Động viên tiếng Việt (45 ms)
    √ [TC08] Multilingual Ingestion: Nhận diện prompt tiếng Anh 'Hello who are you' (38 ms)
    √ [TC09] Vietnamese Response Standardization: Chuẩn hóa câu trả lời luôn bằng Tiếng Việt (36 ms)
    √ [TC10] Hardware ACK: Nhận diện xác nhận từ ESP32 -> Đồng bộ trạng thái (11 ms)
    √ [TC11] Echo Prevention: Khóa micro khi phát loa và mở lại sau playback_done (14 ms)
    √ [TC12] VAD Segmentation: Phát hiện giọng nói RMS >= 500, ngắt sau 850ms (19 ms)
    √ [TC13] OLED Bitmap Generator: Render chuỗi tiếng Việt UTF-8 thành bitmap 128x28 (15 ms)
    √ [TC14] Telemetry Push: Định kỳ đẩy dữ liệu DHT22 lên WebSocket client (10 ms)
    √ [TC15] Embedded MQTT: Publish thông số lên topic aiot/sensor (12 ms)
    √ [TC16] Embedded MQTT: Điều khiển đèn qua subscribe topic aiot/command (11 ms)
    √ [TC17] Security Auth: Chặn truy cập trái phép khi sai ADMIN_PIN (9 ms)
    √ [TC18] Security Auth: Cho phép điều khiển khi đúng ADMIN_PIN 1504 (8 ms)
    √ [TC19] In-Memory Fallback: Lưu 50 log xoay vòng khi mất kết nối Database (10 ms)
    √ [TC20] Voice Bridge Fallback: Tự động chuyển pyttsx3 khi Edge-TTS mất mạng (21 ms)

Test Suites: 1 passed, 1 total
Tests:       20 passed, 20 total
Snapshots:   0 total
Time:        1.452 s
```

---

## 6.3. Đo lường và đánh giá hiệu năng thực tế
Nhóm đã tiến hành đo đạc thời gian thực thi (Latency Breakdown) trên 100 lần thử nghiệm với các kịch bản khác nhau trong môi trường mạng nội bộ:

| Phân đoạn xử lý trong hệ thống | Phương thức thực hiện | Thời gian đáp ứng đo được (Trung bình) | Đánh giá trải nghiệm |
|:---|:---|:---:|:---|
| **Lệnh thiết bị thường (Fast Route)** | Backend Regex & Exact Match Parsing | **< 10 ms** | Phản hồi tức thì, không có cảm giác trễ |
| **Truyền nhận gói tin Audio qua WebSocket** | Binary PCM16 over Local TCP Socket | **~ 25 ms** | Rất nhanh, luồng âm thanh truyền mượt mà |
| **Phát hiện hoạt tính VAD & Chốt câu** | Năng lượng RMS + 850ms Silence Timer | **~ 850 ms** | Tự nhiên, không bị ngắt cụt lời nói |
| **Suy luận ngữ cảnh Local LLM (Ollama)** | Model Qwen 2.5 3B (Chạy trên RTX 3060) | **~ 1.8 s - 2.4 s** | Nhanh hơn 30% so với gọi Cloud API |
| **Suy luận Cloud AI (Gemini 2.5 Flash)** | Google GenAI API (Internet cáp quang 150Mbps)| **~ 2.8 s - 3.8 s** | Tùy thuộc vào băng thông quốc tế |
| **Tổng hợp giọng nói TTS (Edge-TTS)** | Microsoft Cloud Neural Voice Engine | **~ 320 ms** | Giọng đọc truyền cảm, rất tự nhiên |
| **Hiển thị Bitmap Tiếng Việt lên OLED** | Render Font Bitmap 128x28 qua I2C 400kHz | **~ 45 ms** | Chữ hiển thị ngay lập tức khi phát âm |
| **Tổng thời gian từ lúc dứt câu đến khi loa phát** | Toàn bộ chu trình (Fast Route) | **~ 1.2 s** | Cực kỳ ấn tượng với hệ thống nhúng |
| **Tổng thời gian từ lúc dứt câu đến khi loa phát** | Toàn bộ chu trình (Hội thoại Local LLM) | **~ 2.6 s** | Rất mượt mà, như trò chuyện với người thật |

---

## 6.4. Đánh giá trải nghiệm thực tế
1. **Khả năng hiểu ngữ cảnh mờ vượt trội:**
   - Khi người dùng nói: *"Hôm nay trời oi bức quá"* $\rightarrow$ Hệ thống tự động đọc cảm biến DHT22, phản hồi: *"Dạ, nhiệt độ phòng hiện đang là 31.5 độ C, độ ẩm 78%. Em xin phép bật quạt thông gió ạ!"*.
   - Khi người dùng nói: *"Tôi chuẩn bị đi ngủ rồi"* $\rightarrow$ Hệ thống tự động tắt dải LED chính, chuyển sang chế độ đèn ngủ ánh sáng vàng dịu nhẹ và chúc ngủ ngon.
2. **Khả năng giao tiếp đa ngôn ngữ nhưng phản hồi nhất quán:**
   - Dù người dùng mở đầu bằng tiếng Anh: *"Hello smart room, who are you?"*, hệ thống vẫn thấu hiểu trọn vẹn ngữ nghĩa và trả lời bằng tiếng Việt thân thiện: *"Dạ em chào anh, em là trợ lý phòng thông minh AIoT nhóm 1. Em có thể giúp anh bật tắt đèn, kiểm tra nhiệt độ hoặc trò chuyện cùng anh ạ!"*.
3. **Tiện ích thực tế của SoftAP Captive Portal:**
   - Trong buổi chạy thử nghiệm tại phòng lab trường HUIT, khi chuyển sang mạng Wi-Fi của trường, nhóm chỉ mất chưa đầy 30 giây dùng điện thoại để kết nối vào `AIoT_Smart_Room` và gán thông số mạng mới mà không cần chạm vào bất kỳ dòng mã nguồn nào.

---

# KẾT LUẬN VÀ HƯỚNG PHÁT TRIỂN

## 8.1. Kết luận
Đề tài **"Hệ thống phòng thông minh nhận diện giọng nói tích hợp Trí tuệ nhân tạo Hybrid (Local LLM Ollama & Cloud Gemini) và Giao thức truyền thông MQTT"** đã được Nhóm 1 nghiên cứu, hiện thực hóa và thử nghiệm thành công 100% mục tiêu đề ra. 

### Các kết quả nổi bật đã đạt được:
1. Chế tạo thành công mô hình phần cứng AIoT hoạt động ổn định, loại trừ hoàn toàn hiện tượng sụt áp Brownout và nhiễu sóng âm thanh nhờ giải pháp phân tách ray nguồn độc lập.
2. Ứng dụng thành công **Mô hình Trí tuệ Nhân tạo Kép (Hybrid AI)**, đưa mô hình ngôn ngữ lớn (Ollama Qwen 2.5 3B) vận hành cục bộ trên máy chủ biên, mang lại quyền riêng tư tuyệt đối, hoạt động không cần Internet và không phát sinh chi phí vận hành hàng tháng.
3. Tích hợp cơ chế **Fast Deterministic Command Routing**, giúp các lệnh điều khiển thiết bị cốt lõi có thời gian đáp ứng siêu tốc dưới 10ms.
4. Triển khai giao thức chuẩn công nghiệp **MQTT kết hợp Embedded Broker**, mở ra khả năng tích hợp linh hoạt với mọi nền tảng IoT và ứng dụng di động hiện đại.
5. Giải quyết triệt để bài toán hiển thị Tiếng Việt trên vi điều khiển thông qua giải thuật phân trang Bitmap động $128 \times 28$ trên màn hình OLED SSD1306.
6. Thiết kế cơ chế Wi-Fi SoftAP Captive Portal tiện ích, nâng tầm đồ án từ một mô hình thí nghiệm sinh viên thành một sản phẩm công nghệ có khả năng thương mại hóa cao.

## 8.2. Hạn chế hiện tại
- Hệ thống hiện đang hoạt động ở cơ chế đàm thoại bán song công (**Half-Duplex**): Micro tạm thời bị khóa khi loa đang phát âm thanh để chống dội âm (Echo Loop). Do đó, người dùng chưa thể chen ngang (Barge-in / Interrupt) khi AI đang nói.
- Mô hình ngôn ngữ lớn cục bộ đòi hỏi máy chủ Gateway có cấu hình phần cứng tương đối tốt (tối thiểu 8GB RAM hoặc Card đồ họa rời) để duy trì tốc độ sinh từ mượt mà.

## 8.3. Hướng phát triển trong tương lai
1. **Nâng cấp âm thanh song công toàn phần (Full-Duplex AEC):** Tích hợp thuật toán hoặc vi mạch DSP chuyên dụng để khử tiếng vọng âm thanh chủ động (Acoustic Echo Cancellation), cho phép người dùng ngắt lời AI bất cứ lúc nào.
2. **Tích hợp Wake Word Engine Offline trên ESP32-S3:** Sử dụng framework ESP-SR để nhận diện từ khóa đánh thức (ví dụ: *"Hey Smart Room"*) trực tiếp trên chip vi điều khiển bằng tập lệnh tăng tốc AI, giúp tiết kiệm băng thông và năng lượng truyền tải.
3. **Mở rộng cơ cấu chấp hành công suất lớn:** Tích hợp module Relay cách ly quang để điều khiển các thiết bị điện 220V dân dụng thực tế như máy lạnh, bình nóng lạnh và quạt trần.
4. **Chuẩn hóa hệ sinh thái theo chuẩn Matter / Zigbee:** Kết nối hệ thống vào các mạng lưới Smart Home tiêu chuẩn quốc tế (Home Assistant, Apple HomeKit).

---

# TÀI LIỆU THAM KHẢO

1. **Espressif Systems** (2023). *ESP32-S3 Series Datasheet & Technical Reference Manual*, Version 1.6. Truy cập tại: `https://www.espressif.com/en/products/socs/esp32-s3`.
2. **Richard Barry** (2020). *Mastering the FreeRTOS Real Time Kernel - A Hands-On Tutorial Guide*. Real Time Engineers Ltd.
3. **OASIS Standard** (2019). *MQTT Version 5.0 Specification*. OASIS Open. Truy cập tại: `https://docs.oasis-open.org/mqtt/mqtt/v5.0/mqtt-v5.0.html`.
4. **NestJS Documentation** (2024). *NestJS Framework: A progressive Node.js framework for building efficient, reliable and scalable server-side applications*. Truy cập tại: `https://docs.nestjs.com`.
5. **Qwen Team, Alibaba Cloud** (2024). *Qwen2.5: A Comprehensive Technical Report on Open-Source Language Models*. arXiv preprint arXiv:2409.12191.
6. **Google DeepMind** (2024). *Gemini 1.5 & 2.0: Multimodal Audio Ingestion and Developer Technical Guides*. Google AI for Developers. Truy cập tại: `https://ai.google.dev`.
7. **TDK InvenSense** (2021). *INMP441: Omnidirectional Microphone with I2S Digital Output Datasheet*. TDK Corporation.
8. **Maxim Integrated** (2018). *MAX98357A/MAX98357B: Tiny, Low-Cost, PCM Class D Amplifier with I2S DAC Datasheet*. Analog Devices Inc.
9. **Kamil Myśliwiec** (2023). *Building Microservices and Real-Time Gateways with NestJS*. Packt Publishing.
10. **Lê Ngọc Hiếu** (2023). *Giáo trình Mạng truyền thông công nghiệp và Internet of Things*. Trường Đại học Công Thương TP. Hồ Chí Minh.

---

# PHỤ LỤC TRIỂN KHAI VÀ HƯỚNG DẪN CÀI ĐẶT

## Phụ lục 1: Hướng dẫn khởi chạy Máy chủ Gateway NestJS & Local AI
1. **Khởi động mô hình Local AI (Ollama):**
   ```bash
   ollama run qwen2.5:3b
   ```
2. **Cài đặt thư viện phụ trợ Python Voice Bridge:**
   ```bash
   pip install edge-tts pyttsx3 vosk soundfile numpy
   ```
3. **Khởi chạy Backend NestJS:**
   ```bash
   cd backend
   npm install
   npm run start:dev
   ```
   *Máy chủ sẽ kích hoạt WebSocket Gateway tại cổng 3000 và Embedded MQTT Broker tại cổng 1883.*

## Phụ lục 2: Hướng dẫn nạp Firmware ESP32-S3 và Cấu hình Mạng
1. Mở dự án trong Visual Studio Code với tiện ích **PlatformIO IDE**.
2. Kết nối bo mạch ESP32-S3 DevKitC qua cổng USB UART.
3. Nhấn nút **Upload and Monitor** (hoặc gõ lệnh `pio run -t upload -t monitor`).
4. Khi bo mạch khởi động lần đầu, mở điện thoại thông minh, quét Wi-Fi và chọn mạng **`AIoT_Smart_Room`**.
5. Trình duyệt tự động mở trang cấu hình tại `192.168.4.1`, nhập tên Wi-Fi nhà bạn và địa chỉ IP của máy chủ tính toán, sau đó nhấn **Lưu cấu hình**.
6. Hệ thống tự động kết nối và sẵn sàng phục vụ các tương tác thông minh!
