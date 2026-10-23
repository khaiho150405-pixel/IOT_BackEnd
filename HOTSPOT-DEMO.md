# Demo qua Mobile hotspot cua laptop

## Sua loi da tim thay

Windows co luat TCP Query User chan node.exe tren Private/Public. Block uu tien hon Allow TCP3000. Vi vay localhost/health OK khong chung minh dien thoai truy cap duoc.

Mo PowerShell **Run as administrator**, chay:

```powershell
Set-Location E:\AIoT\Code
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\fix-hotspot-firewall.ps1
```

Script chi loai cong 3000 khoi luat TCP Query User Block cua dung Node hien tai, giu Block cac cong khac va UDP. Them Allow cho dung Node, TCP3000, IP laptop 192.168.137.1, client 192.168.137.0/24. Khong tat firewall. Neu doi ban Node, chay lai script.

## Moi lan demo

1. Laptop co Internet. Bat Settings > Network & Internet > Mobile hotspot; share qua Wi-Fi, band 2.4 GHz, ten AIOT va mat khau trung include/config.h. Tat tu dong tat hotspot khi khong co client neu co tuy chon.
2. Xem ipconfig: adapter Microsoft Wi-Fi Direct phai co 192.168.137.1. Neu IP khac, can cap nhat WS_HOST va pham vi firewall; script hien danh cho 192.168.137.0/24.
3. Chay backend trong terminal thuong:

```powershell
Set-Location E:\AIoT\Code\backend
npm.cmd run build
npm.cmd start
```

4. Dien thoai noi AIOT: mo http://192.168.137.1:3000/health, phai thay status ok. Endpoint nay chi bao backend song, chua kiem tra Gemini.
5. ESP32 noi AIOT; monitor phai co WiFi=connected, WS=connected. Backend phai co WebSocket connected va Device hello accepted. Khong can nap lai neu config.h tren board da dung.
6. Kiem tra Gemini that (2 request API, co the su dung quota tai khoan):

```powershell
Set-Location E:\AIoT\Code\backend
node scripts/check-gemini.cjs
```

7. Noi qua micro ESP32: "Tat den", "Bat den", "Nhiet do va do am trong phong?", "Xin chao". Xac nhan LED doi that, so cam bien hop ly, OLED hien chu, loa phat tra loi. Doi tra loi xong moi noi cau tiep theo.

Dien thoai truy cap health khong dong nghia da co ung dung dieu khien. Backend hien co giao thuc thiet bi /aiot; API dang nhap va dieu khien danh cho app chua duoc trien khai. Khong dua DEVICE_TOKEN hay Gemini key vao app.

## Gioi han xac nhan

Kiem tra ngay 2026-10-01: firmware build OK, backend 12/12 tests OK. Gemini 3.8 Flash tra HTTP503 (high demand), nen .env demo chuyen GEMINI_MODEL=gemini-2.5-flash va GEMINI_API_STYLE=legacy. Giu TTS model hien co: da thu API that tao giong noi, gui audio do de phan tich va nhan environment/vi thanh cong. Day la ket qua tai thoi diem thu, quota/dich vu co the thay doi.

Cap nhat 2026-10-02: TTS doi sang gemini-2.5-flash-preview-tts; VAD_SILENCE_MS=500; Flash tat thinking. Mot lan thu API that: phan tich 3432ms, tong phan tich + audio tra loi san sang 8901ms (chua gom 500ms VAD va mang/loa). 14 tests dat, gom API treo va giu hoi thoai khi TTS timeout. Backend dung cho audio dau tien sau 9 giay; qua han thong bao timeout, khong cam ket moi yeu cau Gemini thanh cong duoi 10 giay. OLED can nap firmware moi; xem README.md.

Ban sua nhieu luot: 16 tests dat, gom bat den -> tat den -> hoi so do ngay sau listening, ACK phat am thanh va cache TTS. Da nap COM6 va WS noi lai. Khong can reset/nhan BOOT giua cac cau. Doi loa noi xong va trang thai Listen roi noi cau tiep. Neu can ngat cau dang phat, nhan-tha BOOT mot lan, khong giu nut hay nhan RST.

OLED hien cau tra loi da xac nhan truoc khi cho TTS, sau do gui audio ngay khi co; qua han/TTS loi thi hien notice. DEMO_FAST_CONFIRMATIONS=true tao san hai cau LED bang Gemini, xac nhan LED sau ACK va doc sensor thuc. Khong suy ra loa vat ly da phat dung chi tu test gia lap: can nghe truc tiep va kiem tra tung luot tren board.

Cap nhat 2026-10-04: sua timer de chi ap dung den luc co cau tra loi dau tien; khi OLED da co cau tra loi, TTS co cua so rieng 2,2 giay roi dung giong noi ngan da cache (cho toi da 0,7 giay). Neu Gemini phan tich qua 8 giay, hien thong bao tren OLED va tra micro ve nghe; neu Gemini/TTS timeout thi khong de ESP32 bi ket o trang thai busy. Sau khi cap nhat backend, khoi dong lai backend; khong can nap firmware neu `src/main.cpp` khong doi.

Da sua request REST o che do current: responseFormat.text.mimeType phai la APPLICATION_JSON, schema nam trong responseFormat.text.schema. Khong dung application/json tai truong enum nay.

Kiem tra health va WebSocket tu laptop (khong thay the kiem tra tu dien thoai): `cd backend` roi `node scripts/check-backend.cjs`.

Build/test tu dong va loopback WebSocket khong thay cho thu tren dien thoai/ESP32 that. Chi coi demo dat khi buoc 4, 5 va 7 dat. Gemini can Internet, key va quota cua ca model nhan dang lan TTS.

Cap nhat 2026-10-19: backend demo hien chon `AI_PROVIDER=ollama`, dung Qwen 2.5 3B local va Vosk tieng Viet; Edge TTS van can Internet. Firmware duoc nap lai qua COM6 va da boot, nhung luc cap nhat hotspot AIOT dang tat nen WiFi/WebSocket chua ket noi. Bat hotspot 2.4 GHz de hoan tat thu tren board.
