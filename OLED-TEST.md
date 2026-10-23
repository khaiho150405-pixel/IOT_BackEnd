# Kiểm tra màn hình OLED 128×64

Mẫu kiểm tra độc lập ở `src/oled_test.cpp` dùng SDA=GPIO8, SCL=GPIO9 và tự dò địa chỉ I²C `0x3C`/`0x3D`. Nó hiển thị nền đen/trắng và caro đảo chiều, quét một vạch qua từng hàng/cột để tìm điểm ảnh chết hoặc kẹt sáng, rồi hiện lưới, bốn góc và chữ. Khi chạy, màn hình không kết nối Wi-Fi và không điều khiển đèn.

Đóng Serial Monitor đang giữ COM6, rồi nạp firmware kiểm tra:

```powershell
& "$env:USERPROFILE\.platformio\penv\Scripts\platformio.exe" run -e oled-test -t upload --upload-port COM6
& "$env:USERPROFILE\.platformio\penv\Scripts\platformio.exe" device monitor -e oled-test --port COM6 --baud 115200
```

Màn hình tốt sẽ có nền trắng/đen đều; caro không thiếu ô; vạch quét không đứt; lưới có đủ hàng/cột, bốn góc và chữ `OLED TEST OK`. Một chấm sáng trên nền đen có thể là điểm ảnh kẹt sáng; chấm tối cố định trên nền trắng có thể là điểm ảnh chết/kẹt tắt. Serial báo địa chỉ OLED tìm được. Nếu báo không tìm thấy, kiểm tra nguồn 3V3, GND, SDA GPIO8, SCL GPIO9 và dây nối trước khi kết luận panel hỏng.

Firmware kiểm tra thay thế chương trình AIoT khi nạp. Sau khi kiểm tra xong, đóng monitor và nạp lại chương trình chính:

```powershell
& "$env:USERPROFILE\.platformio\penv\Scripts\platformio.exe" run -e esp32-s3-n16r8 -t upload --upload-port COM6
```

Môi trường `oled-test` đã biên dịch thành công; chưa nạp đè lên firmware AIoT đang chạy.
