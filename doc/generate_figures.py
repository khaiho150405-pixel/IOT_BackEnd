"""
Meticulous High-Detail Diagram Generator for AIoT Smart Room
Generates 5 publication-grade engineering diagrams at 300 DPI:
- Figure 4.1: Sơ đồ khối kiến trúc hệ thống chi tiết (Overall Architecture & Subsystems)
- Figure 4.2: Sơ đồ luồng dữ liệu & Sequence Diagram chi tiết (Data Flow & Payload Timeline)
- Figure 4.3: Sơ đồ đấu nối dây Pinout mạch điện tử chi tiết (Wiring Schematic & Pinout)
- Figure 5.1: Sơ đồ thuật toán vận hành & Xử lý lỗi chi tiết (Full Operation State Machine Flowchart)
- Figure 5.2: Sơ đồ bố trí vật lý sa bàn & Phân vùng tiêu âm chi tiết (Physical Layout & Acoustic Map)

No top titles on images (captions handled by Word).
High contrast, large fonts (10pt-14pt), rich technical parameters.
"""

import os
import matplotlib.pyplot as plt
import matplotlib.patches as patches
from matplotlib.path import Path

fig_dir = r'e:\AIoT\Code\doc\figures'
os.makedirs(fig_dir, exist_ok=True)

plt.rcParams['font.sans-serif'] = ['Segoe UI', 'Arial', 'DejaVu Sans']
plt.rcParams['axes.unicode_minus'] = False

# =============================================================================
# FIGURE 4.1: SƠ ĐỒ KHỐI KIẾN TRÚC HỆ THỐNG CHI TIẾT
# =============================================================================
def generate_fig_4_1():
    fig, ax = plt.subplots(figsize=(16, 11), dpi=300)
    ax.set_xlim(0, 100)
    ax.set_ylim(0, 100)
    ax.axis('off')
    fig.patch.set_facecolor('#ffffff')
    ax.set_facecolor('#ffffff')

    # -------------------------------------------------------------------------
    # TẦNG 1: NGOẠI VI & CẢM BIẾN (PERIPHERALS LAYER) - Top-Left
    # -------------------------------------------------------------------------
    ax.add_patch(patches.FancyBboxPatch((2, 52), 43, 46, boxstyle="round,pad=1.0",
                                        edgecolor='#0284c7', facecolor='#f0f9ff', lw=2.2))
    ax.text(23.5, 96, "TẦNG CẢM BIẾN & NGOẠI VI (PERIPHERALS)", 
            ha='center', va='center', fontsize=12, fontweight='bold', color='#0369a1')

    # Peripheral sub-boxes
    periphs = [
        ("Micro I2S INMP441 (MEMS Audio In)", 
         "• ADC 24-bit Sigma-Delta, SNR 61 dB, Độ nhạy -26 dBFS\n• Bus I2S0: SCK (GPIO 5), WS (GPIO 4), SD (GPIO 6)\n• Nguồn 3.3V DC, L/R nối GND (Kênh trái 16kHz PCM16)", 86.5, '#0284c7'),
        ("DAC MAX98357A & Loa 3W 4Ω (Audio Out)", 
         "• Mạch khuếch đại Class D 3.2W, Hiệu suất >92%\n• Bus I2S1: LRC (GPIO 17), BCLK (GPIO 16), DIN (GPIO 15)\n• Nguồn 5.0V DC (thanh nguồn 5VIN), Loa dynamic 4Ω dải 200Hz-15kHz", 73.5, '#d97706'),
        ("Màn hình OLED SSD1306 0.96\" (Visual UI)", 
         "• Độ phân giải 128x64 pixels, Giao tiếp I2C 100kHz (chống sọc)\n• Chân: SCL (GPIO 13), SDA (GPIO 14), Địa chỉ 0x3C, Nguồn 3.3V\n• Giải thuật nén bitmap Tiếng Việt có dấu phân trang 128x28", 60.5, '#4f46e5'),
        ("Cảm biến nhiệt ẩm DHT22 & Dải LED WS2812B", 
         "• DHT22: Single-Bus GPIO 21 (Trở kéo 4.7-10kΩ), Đọc chu kỳ 2s\n• WS2812B NeoPixel: DIN GPIO 1, Nguồn 3.3V\n• Hiệu ứng: Thở Cyan (chưa kết nối), nhấp nháy khi loa nói", 47.5, '#059669'),
    ]
    for p_title, p_desc, py, p_col in periphs:
        ax.add_patch(patches.FancyBboxPatch((3.5, py-5.0), 40, 10, boxstyle="round,pad=0.4",
                                            edgecolor=p_col, facecolor='#ffffff', lw=1.2))
        ax.text(5, py+2.5, p_title, ha='left', va='center', fontsize=10, fontweight='bold', color=p_col)
        ax.text(5, py-1.6, p_desc, ha='left', va='center', fontsize=8.2, color='#1e293b')

    # -------------------------------------------------------------------------
    # TẦNG 2: VI ĐIỀU KHIỂN BIÊN ESP32-S3 (EDGE CONTROLLER) - Bottom-Left
    # -------------------------------------------------------------------------
    ax.add_patch(patches.FancyBboxPatch((2, 2), 43, 47, boxstyle="round,pad=1.0",
                                        edgecolor='#2563eb', facecolor='#eff6ff', lw=2.2))
    ax.text(23.5, 46.5, "TẦNG VI ĐIỀU KHIỂN BIÊN: ESP32-S3 N16R8", 
            ha='center', va='center', fontsize=12, fontweight='bold', color='#1d4ed8')

    # CPU & FreeRTOS Dual Core
    ax.add_patch(patches.FancyBboxPatch((3.5, 33), 40, 10.5, boxstyle="round,pad=0.4",
                                        edgecolor='#1d4ed8', facecolor='#ffffff', lw=1.2))
    ax.text(23.5, 41, "Xtensa® Dual-Core 32-bit LX7 (Xung nhịp 240 MHz)", 
            ha='center', va='center', fontsize=10, fontweight='bold', color='#1e3a8a')
    ax.text(23.5, 36.5, "Core 0: Task Audio Network (WebSocket ws/wss, cổng thu âm, I2S)\nCore 1: Task Sensors & UI (Đọc DHT22 2s, FastLED, OLED Bitmap)", 
            ha='center', va='center', fontsize=8.4, color='#334155')

    # Memory Subsystem
    ax.add_patch(patches.FancyBboxPatch((3.5, 20), 40, 10.5, boxstyle="round,pad=0.4",
                                        edgecolor='#2563eb', facecolor='#ffffff', lw=1.2))
    ax.text(23.5, 28, "HỆ THỐNG BỘ NHỚ TỐC ĐỘ CAO (HI-SPEED MEMORY)", 
            ha='center', va='center', fontsize=9.8, fontweight='bold', color='#1e40af')
    ax.text(23.5, 23.5, "• 8 MB Octal PSRAM: RingBuffer cấp phát động âm thanh nhị phân\n• 16 MB Quad SPI Flash: NVS lưu Wi-Fi & Gateway IP, Firmware\n• 512 KB Internal SRAM: Ngăn xếp FreeRTOS & Bộ nhớ đệm DMA", 
            ha='center', va='center', fontsize=8.2, color='#1e293b')

    # Dual-Mode Wi-Fi & Power
    ax.add_patch(patches.FancyBboxPatch((3.5, 4), 40, 14, boxstyle="round,pad=0.4",
                                        edgecolor='#dc2626', facecolor='#ffffff', lw=1.2))
    ax.text(23.5, 15.5, "NGUỒN ĐIỆN & CẤU HÌNH WI-FI SOFTAP", 
            ha='center', va='center', fontsize=9.8, fontweight='bold', color='#b91c1c')
    ax.text(23.5, 10.5, "• Nguồn USB 5V: thanh 3V3 (Logic/Mic/OLED/LED) & 5VIN (Loa)\n• SoftAP 'AIoT_Smart_Room' (192.168.4.1) bật khi 60s không vào được\n  backend; giữ nút BOOT (GPIO 0) 3s để xóa cấu hình", 
            ha='center', va='center', fontsize=8.2, color='#1e293b')

    # -------------------------------------------------------------------------
    # KÊNH TRUYỀN THÔNG KÉP (COMMUNICATION BUS) - Middle (x: 45 to 55)
    # -------------------------------------------------------------------------
    buses = [
        (82, "WebSocket (Port 3100 / wss)\nStream PCM16 16kHz", '#2563eb'),
        (56, "MQTT Broker (Port 1883)\nTelemetry & Command", '#7c3aed'),
        (25, "Web HTTP 3100 / HTTPS\nDesk & Mobile App", '#059669')
    ]
    for by, b_txt, b_col in buses:
        ax.annotate("", xy=(55, by), xytext=(45, by),
                    arrowprops=dict(arrowstyle="<->", color=b_col, lw=2.5))
        ax.text(50, by+3.2, b_txt, ha='center', va='bottom', fontsize=8.8, fontweight='bold', color=b_col,
                bbox=dict(boxstyle="round,pad=0.25", facecolor="#ffffff", edgecolor=b_col, lw=1))

    # -------------------------------------------------------------------------
    # TẦNG 3: GATEWAY & EMBEDDED MQTT (NESTJS) - Top-Right (x: 55 to 98)
    # -------------------------------------------------------------------------
    ax.add_patch(patches.FancyBboxPatch((55, 52), 43, 46, boxstyle="round,pad=1.0",
                                        edgecolor='#059669', facecolor='#f0fdf4', lw=2.2))
    ax.text(76.5, 96, "TẦNG TRUNG TÂM: BACKEND GATEWAY & MQTT (NESTJS)", 
            ha='center', va='center', fontsize=11.5, fontweight='bold', color='#065f46')

    gw_items = [
        ("WebSocket Gateway (Streaming Server)", 
         "• Nhận luồng PCM16 16kHz quanh tiếng nói (cổng thu âm ESP32)\n• Cơ chế Half-Duplex Echo Prevention: Nhận 'playback_done' mở lại Mic\n• Điều phối Bitmap Tiếng Việt 128x28 truyền xuống OLED SSD1306", 86.5, '#059669'),
        ("VAD Engine (Voice Activity Detection)", 
         "• Tính năng lượng sóng âm RMS theo thời gian thực\n• Ngưỡng phát hiện tiếng nói: RMS >= 160 (sau lọc 120Hz)\n• Chốt câu khi im lặng >= 1200ms; gọi tên 'Trợ lý ơi' + 10s nghe tiếp", 73.5, '#047857'),
        ("Qwen hiểu ý định + Code kiểm chứng quyết định", 
         "• Đèn chỉ đổi khi có động từ bật/tắt; số đo lấy từ cảm biến thật\n• Bắt buộc ACK phần cứng (tự gửi lại lệnh) trước khi cập nhật State", 60.5, '#b45309'),
        ("Embedded Aedes MQTT Broker (Port 1883)", 
         "• Nhúng trực tiếp trong Gateway, quản lý Topic: aiot/sensor, aiot/state,\n  aiot/chat, aiot/command; TypeORM + Fallback Circular 50 logs", 47.5, '#6d28d9'),
    ]
    for g_title, g_desc, gy, g_col in gw_items:
        ax.add_patch(patches.FancyBboxPatch((56.5, gy-5.0), 40, 10, boxstyle="round,pad=0.4",
                                            edgecolor=g_col, facecolor='#ffffff', lw=1.2))
        ax.text(58, gy+2.5, g_title, ha='left', va='center', fontsize=9.8, fontweight='bold', color=g_col)
        ax.text(58, gy-1.6, g_desc, ha='left', va='center', fontsize=8.2, color='#1e293b')

    # -------------------------------------------------------------------------
    # TẦNG 4: TRÍ TUỆ NHÂN TẠO KÉP (HYBRID AI ENGINE) - Bottom-Right (x: 55 to 98)
    # -------------------------------------------------------------------------
    ax.add_patch(patches.FancyBboxPatch((55, 2), 43, 47, boxstyle="round,pad=1.0",
                                        edgecolor='#d97706', facecolor='#fffbeb', lw=2.2))
    ax.text(76.5, 46.5, "TẦNG TRÍ TUỆ NHÂN TẠO KÉP (HYBRID AI ENGINE)", 
            ha='center', va='center', fontsize=11.5, fontweight='bold', color='#92400e')

    # Sub-block A: Local AI
    ax.add_patch(patches.FancyBboxPatch((56.5, 23), 40, 20.5, boxstyle="round,pad=0.4",
                                        edgecolor='#d97706', facecolor='#ffffff', lw=1.5))
    ax.text(76.5, 41, "1. LOCAL AI ENGINE (CHẾ ĐỘ MẶC ĐỊNH - 100% OFFLINE)", 
            ha='center', va='center', fontsize=9.8, fontweight='bold', color='#b45309')
    ax.text(76.5, 32.5, "• Local LLM: Ollama Qwen 2.5 3B trên GPU (~0,6s/câu khi đã làm nóng)\n• ASR Offline: PhoWhisper-base (CTranslate2 int8, CPU) WAV -> Text\n• TTS Engine: Microsoft Edge-TTS (HoaiMy) khi có mạng, dự phòng\n  giọng Windows offline 'Microsoft An'\n-> Tự chủ 100%, bảo mật tuyệt đối âm thanh gia đình, chi phí vận hành 0đ", 
            ha='center', va='center', fontsize=8.2, color='#1e293b')

    # Sub-block B: Cloud AI
    ax.add_patch(patches.FancyBboxPatch((56.5, 4), 40, 16.5, boxstyle="round,pad=0.4",
                                        edgecolor='#f59e0b', facecolor='#ffffff', lw=1.2))
    ax.text(76.5, 17.5, "2. CLOUD AI ENGINE (CHẾ ĐỘ MỞ RỘNG TÙY CHỌN)", 
            ha='center', va='center', fontsize=9.8, fontweight='bold', color='#92400e')
    ax.text(76.5, 10.5, "• Google Gemini API (bật bằng AI_PROVIDER=gemini)\n• Audio Multimodal Native: Gửi trực tiếp file âm thanh WAV lên máy chủ\n• Gemini TTS Preview: Sinh tiếng nói trực tiếp model 'Kore'", 
            ha='center', va='center', fontsize=8.2, color='#1e293b')

    # Connection arrow between Gateway and AI
    ax.annotate("", xy=(76.5, 52), xytext=(76.5, 47),
                arrowprops=dict(arrowstyle="<->", color="#d97706", lw=2.5))

    plt.tight_layout()
    out_path = os.path.join(fig_dir, 'hinh_4_1_so_do_khoi_tong_the.png')
    plt.savefig(out_path, dpi=300, facecolor=fig.get_facecolor(), edgecolor='none')
    plt.close()
    print('Generated detailed Fig 4.1:', out_path)

# =============================================================================
# FIGURE 4.2: SƠ ĐỒ LUỒNG DỮ LIỆU & SEQUENCE DIAGRAM CHI TIẾT
# =============================================================================
def generate_fig_4_2():
    fig, ax = plt.subplots(figsize=(16, 11), dpi=300)
    ax.set_xlim(0, 100)
    ax.set_ylim(0, 100)
    ax.axis('off')
    fig.patch.set_facecolor('#ffffff')
    ax.set_facecolor('#ffffff')

    actors = [
        ("Người dùng\n(User)", 9, '#475569'),
        ("ESP32-S3\n(Firmware FreeRTOS)", 28, '#2563eb'),
        ("Backend Gateway\n(NestJS & VAD RMS)", 50, '#059669'),
        ("AI Engine\n(Ollama / Gemini)", 73, '#d97706'),
        ("MQTT & Dashboard\n(Mobile & Web Desk)", 92, '#7c3aed')
    ]

    for name, x, col in actors:
        ax.add_patch(patches.FancyBboxPatch((x-7.5, 91), 15, 8, boxstyle="round,pad=0.4", 
                                            edgecolor=col, facecolor=col, linewidth=1.5))
        ax.text(x, 95, name, ha='center', va='center', fontsize=10, fontweight='bold', color='#ffffff')
        ax.plot([x, x], [91, 3], color='#cbd5e1', linestyle='--', linewidth=1.5)

    steps = [
        (85, 9, 28, "1. Phát âm lệnh thoại ('Bật đèn' / 'Nhiệt độ phòng' / 'Hôm nay trời lạnh')", '#2563eb', '->'),
        (78, 28, 50, "2. INMP441 số hóa I2S -> Stream PCM16 16kHz (256 mẫu/gói = 512B) qua WebSocket", '#2563eb', '->'),
        (71, 50, 50, "3. VAD tính năng lượng RMS: RMS >= 160 gom mẫu, chốt câu sau 1200ms im lặng", '#059669', 'loop'),
        (64, 50, 28, "4. Gửi gói tin cập nhật màn hình OLED: {'type': 'oled_status', 'status': 'DANG_XU_LY'}", '#059669', '->'),
        (57, 50, 73, "5. Nhận tên \"Trợ lý ơi\", gửi yêu cầu cho Qwen 2.5 3B, code kiểm chứng quyết định", '#d97706', '->'),
        (50, 73, 50, "6. AI phân tích ngữ cảnh mờ -> Trả về JSON: {'intent': 'led_on', 'reply': 'Dạ em bật đèn rồi ạ'}", '#d97706', '->'),
        (43, 50, 28, "7. Gửi lệnh phần cứng qua WS: {'type': 'command', 'device': 'led', 'action': 'on'}", '#2563eb', '->'),
        (36, 28, 50, "8. ESP32 kích hoạt dải LED WS2812B -> Bắt buộc gửi ACK: {'type': 'ack', 'enabled': true}", '#2563eb', '->'),
        (29, 50, 28, "9. Gửi Bitmap tiếng Việt 128x28 lên OLED + Stream PCM16 âm thanh TTS xuống Loa", '#059669', '->'),
        (22, 28, 9, "10. Phát âm thanh ra Loa MAX98357A (ESP32 MUTE Micro INMP441 chống dội âm)", '#2563eb', '->'),
        (15, 28, 50, "11. Loa phát xong mẫu cuối -> ESP32 gửi 'playback_done' -> Backend mở lại Micro", '#059669', '->'),
        (8, 50, 92, "12. Publish MQTT (Port 1883): aiot/state, aiot/sensor -> Cập nhật Mobile App & Web Desk", '#7c3aed', '->'),
    ]

    for y, x1, x2, desc, col, arrow in steps:
        if arrow == '->':
            ax.annotate("", xy=(x2, y), xytext=(x1, y),
                        arrowprops=dict(arrowstyle="->", color=col, lw=2.2))
            mid_x = (x1 + x2) / 2
            ax.text(mid_x, y + 1.8, desc, ha='center', va='bottom', fontsize=8.6, fontweight='bold', color=col,
                    bbox=dict(boxstyle="round,pad=0.22", facecolor="#ffffff", edgecolor=col, alpha=0.95, lw=1))
        elif arrow == 'loop':
            ax.annotate("", xy=(x1+2, y-2), xytext=(x1+2, y+2),
                        arrowprops=dict(arrowstyle="->", connectionstyle="arc3,rad=-0.8", color=col, lw=2))
            ax.text(x1 + 4.5, y, desc, ha='left', va='center', fontsize=8.6, fontweight='bold', color=col,
                    bbox=dict(boxstyle="round,pad=0.22", facecolor="#ffffff", edgecolor=col, alpha=0.95, lw=1))

    plt.tight_layout()
    out_path = os.path.join(fig_dir, 'hinh_4_2_so_do_luong_du_lieu.png')
    plt.savefig(out_path, dpi=300, facecolor=fig.get_facecolor(), edgecolor='none')
    plt.close()
    print('Generated detailed Fig 4.2:', out_path)

# =============================================================================
# FIGURE 4.3: SƠ ĐỒ ĐẤU NỐI DÂY & PINOUT MẠCH ĐIỆN TỬ CHI TIẾT
# =============================================================================
def generate_fig_4_3():
    fig, ax = plt.subplots(figsize=(16, 11), dpi=300)
    ax.set_xlim(0, 100)
    ax.set_ylim(0, 100)
    ax.axis('off')
    fig.patch.set_facecolor('#ffffff')
    ax.set_facecolor('#ffffff')

    # 1. Power Supply Board (Left: x: 2 to 24, y: 35 to 97)
    ax.add_patch(patches.FancyBboxPatch((2, 35), 23, 62, boxstyle="round,pad=0.8", 
                                        edgecolor='#dc2626', facecolor='#fef2f2', linewidth=2))
    ax.text(13.5, 93, "NGUỒN CẤP\n(USB 5V vào ESP32)", 
            ha='center', va='center', fontsize=10.5, fontweight='bold', color='#b91c1c')
    ax.text(13.5, 87, "Củ sạc 5V >= 2A qua cổng USB\n-> Thanh nguồn 3V3 (logic, mic, OLED, LED)\n-> Thanh nguồn 5VIN (ampli MAX98357A)", 
            ha='center', va='center', fontsize=8, color='#334155')

    rails = [
        ("Ray Nguồn 3.3V DC (Nguồn sạch)", "Cấp INMP441, OLED, DHT22, LED WS2812B", 76, '#dc2626'),
        ("Ray Nguồn 5.0V DC (Dòng cao)", "Cấp ampli Loa MAX98357A", 59, '#b45309'),
        ("Ray Mass GND (Chung toàn mạch)", "Nối mass toàn bộ hệ thống chung", 43, '#334155'),
    ]
    for r_title, r_desc, ry, rcol in rails:
        ax.add_patch(patches.FancyBboxPatch((3.2, ry-5.2), 20.6, 9.8, boxstyle="round,pad=0.3", 
                                            facecolor='#ffffff', edgecolor='#cbd5e1', lw=1.2))
        ax.text(13.5, ry+1.8, r_title, ha='center', va='center', fontsize=8.8, fontweight='bold', color=rcol)
        ax.text(13.5, ry-1.8, r_desc, ha='center', va='center', fontsize=7.8, color='#64748b')

    # Draw power wires from MB-102 to ESP32
    ax.plot([25, 33], [76, 76], color='#dc2626', lw=2.5) # 3.3V
    ax.plot([25, 33], [59, 59], color='#b45309', lw=2.5) # 5.0V
    ax.plot([25, 33], [43, 43], color='#334155', lw=2.5) # GND

    # 2. Central Controller: ESP32-S3 N16R8 DevKitC-1 (x: 33 to 65, y: 3 to 97)
    ax.add_patch(patches.FancyBboxPatch((33, 3), 32, 94, boxstyle="round,pad=1.0", 
                                        edgecolor='#2563eb', facecolor='#eff6ff', linewidth=2.5))
    ax.text(49, 93.5, "ESP32-S3 N16R8 DevKitC-1\n(CPU Xtensa Dual-Core 240 MHz)", 
            ha='center', va='center', fontsize=11, fontweight='bold', color='#1e40af')

    pins = [
        ("GPIO 21", "DATA Single-Bus DHT22 (trở kéo 4.7-10kΩ)", 83.5),
        ("GPIO 04", "I2S0 WS / LRCK (Word Select 16kHz)", 75.0),
        ("GPIO 05", "I2S0 SCK / BCLK (Bit Clock)", 66.5),
        ("GPIO 06", "I2S0 SD / DATA IN (Dòng âm thanh Mic)", 58.0),
        ("GPIO 14", "I2C SDA (Data Line màn hình OLED)", 49.5),
        ("GPIO 13", "I2C SCL (Clock Line 100kHz OLED)", 41.0),
        ("GPIO 01", "DIN dữ liệu LED WS2812B", 32.5),
        ("GPIO 17", "I2S1 LRC / WS (Word Select Loa)", 24.0),
        ("GPIO 16", "I2S1 BCLK (Bit Clock phát loa)", 15.5),
        ("GPIO 15", "I2S1 DIN (Dòng dữ liệu âm thanh Loa)", 7.0),
    ]

    for p_name, p_sig, y in pins:
        ax.add_patch(patches.FancyBboxPatch((34.5, y-2.7), 29, 5.4, boxstyle="round,pad=0.25", 
                                            edgecolor='#93c5fd', facecolor='#ffffff', linewidth=1.2))
        ax.text(36.5, y, p_name, ha='left', va='center', fontsize=9.5, fontweight='bold', color='#1d4ed8')
        ax.text(50.5, y, f"[{p_sig}]", ha='center', va='center', fontsize=7.6, color='#334155')
        ax.plot([63.5, 71], [y, y], color='#64748b', lw=1.8)

    # 3. Right Peripherals Modules (x: 71 to 98)
    modules = [
        ("Cảm biến nhiệt ẩm DHT22 (AM2302)", 83.5, 
         "• Chân: Pin 1 (VCC: 3.3V), Pin 2 (DATA: GPIO 21),\n  Pin 4 (GND: Mass chung)\n• Điện trở kéo Pull-up 4.7-10kΩ nối giữa DATA và 3.3V", '#059669'),
        ("Micro kỹ thuật số I2S INMP441", 66.5, 
         "• Chân: VDD (3.3V), GND, L/R (nối GND chọn kênh trái)\n• Chân I2S: WS (GPIO 4), SCK (GPIO 5), SD (GPIO 6)\n• Tín hiệu số nguyên bản chống nhiễu điện từ", '#0284c7'),
        ("Màn hình hiển thị OLED SSD1306 0.96\"", 45.2, 
         "• Chân: VCC (3.3V), GND, SCL (GPIO 13), SDA (GPIO 14)\n• Chuẩn I2C 100kHz, Địa chỉ: 0x3C\n• Bộ đệm Bitmap tiếng Việt có dấu phân trang 128x28", '#4f46e5'),
        ("Dải Đèn LED RGB WS2812B NeoPixel", 32.5, 
         "• Chân: VCC (3.3V), GND, DIN (GPIO 1), DOUT để trống\n• Mức logic 3.3V khớp ESP32, không cần chuyển mức\n• Mô hình dùng 1 bóng làm đèn phòng", '#db2777'),
        ("Mạch DAC & Loa MAX98357A (Loa 3W 4Ω)", 15.5, 
         "• Chân: VIN (5.0V), GND, GAIN & SD để trống (bật, 9dB)\n• Chân I2S: LRC (GPIO 17), BCLK (GPIO 16), DIN (GPIO 15)\n• Đầu ra OUT+ và OUT- nối cuộn dây Loa 3W 4Ω màng rung", '#d97706'),
    ]

    for m_title, y, detail, col in modules:
        ax.add_patch(patches.FancyBboxPatch((71, y-5.4), 27, 10.8, boxstyle="round,pad=0.4", 
                                            edgecolor=col, facecolor='#ffffff', linewidth=1.5))
        ax.text(84.5, y+2.4, m_title, ha='center', va='center', fontsize=9.6, fontweight='bold', color=col)
        ax.text(84.5, y-1.8, detail, ha='center', va='center', fontsize=7.8, color='#1e293b')

    plt.tight_layout()
    out_path = os.path.join(fig_dir, 'hinh_4_3_so_do_pinout.png')
    plt.savefig(out_path, dpi=300, facecolor=fig.get_facecolor(), edgecolor='none')
    plt.close()
    print('Generated detailed Fig 4.3:', out_path)

# =============================================================================
# FIGURE 5.1: SƠ ĐỒ THUẬT TOÁN VẬN HÀNH & XỬ LÝ LỖI CHI TIẾT
# =============================================================================
def generate_fig_5_1():
    fig, ax = plt.subplots(figsize=(15, 12), dpi=300)
    ax.set_xlim(0, 100)
    ax.set_ylim(0, 100)
    ax.axis('off')
    fig.patch.set_facecolor('#ffffff')
    ax.set_facecolor('#ffffff')

    # Step 1: Start Terminal
    ax.add_patch(patches.FancyBboxPatch((32, 93), 36, 5.5, boxstyle="round,pad=0.8", 
                                        facecolor='#10b981', edgecolor='#059669', lw=2))
    ax.text(50, 95.7, "BẬT NGUỒN HỆ THỐNG", ha='center', va='center', fontsize=11.5, fontweight='bold', color='#ffffff')
    ax.annotate("", xy=(50, 87), xytext=(50, 93), arrowprops=dict(arrowstyle="->", lw=2))

    # Step 2: Init Process
    ax.add_patch(patches.Rectangle((16, 79), 68, 8, facecolor='#f1f5f9', edgecolor='#94a3b8', lw=1.5))
    ax.text(50, 83, "Khởi tạo ESP32-S3: NVS Flash, Cấp phát RingBuffer 8MB PSRAM,\nI2S Audio (Mic INMP441 & Loa MAX98357A), OLED SSD1306, DHT22, FastLED", 
            ha='center', va='center', fontsize=9.2, fontweight='bold', color='#1e293b')
    ax.annotate("", xy=(50, 72), xytext=(50, 79), arrowprops=dict(arrowstyle="->", lw=2))

    # Step 3: Wi-Fi Decision Diamond
    ax.add_patch(patches.Polygon([[50, 72], [68, 66], [50, 60], [32, 66]], closed=True, 
                                 facecolor='#fef3c7', edgecolor='#f59e0b', lw=2))
    ax.text(50, 66, "Vào được backend (60s)?\n(Giữ BOOT 3s: xóa cấu hình)", ha='center', va='center', fontsize=9.2, fontweight='bold', color='#92400e')

    # Branch No -> SoftAP Captive Portal
    ax.annotate("", xy=(22, 66), xytext=(32, 66), arrowprops=dict(arrowstyle="->", lw=2))
    ax.text(27, 67.5, "Chưa có / Sai", ha='center', va='bottom', fontsize=8.5, color='#b91c1c')
    ax.add_patch(patches.Rectangle((2, 61), 20, 10, facecolor='#fee2e2', edgecolor='#ef4444', lw=1.5))
    ax.text(12, 66, "SoftAP 'AIoT_Smart_Room'\nCaptive Portal 192.168.4.1\n(Cấu hình qua điện thoại)", 
            ha='center', va='center', fontsize=8.2, fontweight='bold', color='#991b1b')
    ax.annotate("", xy=(50, 79), xytext=(12, 71), 
                arrowprops=dict(arrowstyle="->", connectionstyle="arc3,rad=-0.4", lw=1.8, color='#ef4444'))

    # Branch Yes -> Standby
    ax.annotate("", xy=(50, 52), xytext=(50, 60), arrowprops=dict(arrowstyle="->", lw=2))
    ax.text(52, 56, "Thành công (Đạt IP)", ha='left', va='center', fontsize=8.8, fontweight='bold', color='#15803d')

    # Step 4: Standby Execution Box
    ax.add_patch(patches.Rectangle((18, 44), 64, 8, facecolor='#eff6ff', edgecolor='#3b82f6', lw=2))
    ax.text(50, 48, "CHẾ ĐỘ CHỜ: OLED hiện nhiệt ẩm + thanh trạng thái \"Goi: Tro ly oi\"\nCổng thu âm ESP32 chỉ gửi âm thanh khi có tiếng nói", 
            ha='center', va='center', fontsize=9.5, fontweight='bold', color='#1d4ed8')
    ax.annotate("", xy=(50, 37), xytext=(50, 44), arrowprops=dict(arrowstyle="->", lw=2))

    # Step 5: Sound Detected Decision Diamond
    ax.add_patch(patches.Polygon([[50, 37], [68, 31], [50, 25], [32, 31]], closed=True, 
                                 facecolor='#fef3c7', edgecolor='#f59e0b', lw=2))
    ax.text(50, 31, "Phát hiện tiếng nói?\n(Cổng thu âm + VAD RMS >= 160)", ha='center', va='center', fontsize=9.2, fontweight='bold', color='#92400e')

    # Side branch: Periodic sensor push
    ax.annotate("", xy=(84, 31), xytext=(68, 31), arrowprops=dict(arrowstyle="->", lw=1.8))
    ax.text(76, 32.5, "Định kỳ 2s", ha='center', va='bottom', fontsize=8.5, color='#64748b')
    ax.add_patch(patches.Rectangle((84, 26), 14, 10, facecolor='#f1f5f9', edgecolor='#94a3b8', lw=1.2))
    ax.text(91, 31, "Đọc DHT22\nPush MQTT &\nWebSocket", ha='center', va='center', fontsize=8.5, fontweight='bold', color='#334155')
    ax.annotate("", xy=(78, 45), xytext=(91, 36), 
                arrowprops=dict(arrowstyle="->", connectionstyle="arc3,rad=-0.3", lw=1.5, color='#64748b'))

    # Sound Detected -> Process Branch
    ax.annotate("", xy=(50, 18), xytext=(50, 25), arrowprops=dict(arrowstyle="->", lw=2))
    ax.text(52, 21.5, "Có tiếng nói (chốt câu sau 1200ms)", ha='left', va='center', fontsize=8.8, fontweight='bold', color='#15803d')

    # Step 6: Processing & Execution
    ax.add_patch(patches.Rectangle((12, 2), 76, 16, facecolor='#f5f3ff', edgecolor='#8b5cf6', lw=2))
    ax.text(50, 13.5, "XỬ LÝ: Có gọi tên \"Trợ lý ơi\" (hoặc trong 10s nghe tiếp)? -> PhoWhisper -> Qwen 2.5 3B -> code kiểm chứng\nThực thi phần cứng: Bật/Tắt LED WS2812B -> Bắt buộc ACK từ ESP32 (tự gửi lại lệnh)\nHiển thị trực quan: Render Bitmap tiếng Việt có dấu 128x28 OLED + Stream TTS ra Loa MAX98357A", 
            ha='center', va='center', fontsize=8.8, fontweight='bold', color='#5b21b6')
    ax.text(50, 6.5, "CƠ CHẾ CHỐNG LẶP ÂM HALF-DUPLEX: ESP32 Mute Micro INMP441 trong lúc phát Loa\nChỉ mở lại Micro khi nhận thông điệp 'playback_done' -> Ngăn hiện tượng tự dội âm", 
            ha='center', va='center', fontsize=8.4, color='#b91c1c')

    # Loop back to Standby
    ax.annotate("", xy=(18, 48), xytext=(12, 10), 
                arrowprops=dict(arrowstyle="->", connectionstyle="arc3,rad=0.4", lw=2, color='#3b82f6'))

    plt.tight_layout()
    out_path = os.path.join(fig_dir, 'hinh_5_1_so_do_van_hanh.png')
    plt.savefig(out_path, dpi=300, facecolor=fig.get_facecolor(), edgecolor='none')
    plt.close()
    print('Generated detailed Fig 5.1:', out_path)

# =============================================================================
# FIGURE 5.2: SƠ ĐỒ BỐ TRÍ VẬT LÝ SA BÀN & TIÊU ÂM CHI TIẾT
# =============================================================================
def generate_fig_5_2():
    fig, ax = plt.subplots(figsize=(16, 11), dpi=300)
    ax.set_xlim(0, 100)
    ax.set_ylim(0, 100)
    ax.axis('off')
    fig.patch.set_facecolor('#ffffff')
    ax.set_facecolor('#ffffff')

    # Main Sa-ban Frame (x: 4 to 96, y: 3 to 97)
    ax.add_patch(patches.FancyBboxPatch((4, 3), 92, 94, boxstyle="round,pad=1.2", 
                                        edgecolor='#334155', facecolor='#f8fafc', linewidth=2.5))
    ax.text(50, 94, "MÔ HÌNH SA BÀN PHÒNG THÔNG MINH 3D (KÍCH THƯỚC: 400mm x 300mm x 350mm)", 
            ha='center', va='center', fontsize=12, fontweight='bold', color='#0f172a')

    # Zone 1: Ceiling (Trần nhà - x: 8 to 92, y: 66 to 90)
    ax.add_patch(patches.FancyBboxPatch((8, 66), 84, 24, boxstyle="round,pad=0.8", 
                                        edgecolor='#f59e0b', facecolor='#fffbeb', linewidth=2))
    ax.text(50, 86, "PHÂN VÙNG TRẦN NHÀ (CEILING ZONE)", ha='center', va='center', fontsize=11, fontweight='bold', color='#b45309')

    # LED Strip Box
    ax.add_patch(patches.FancyBboxPatch((12, 70), 45, 13, boxstyle="round,pad=0.4", 
                                        edgecolor='#f59e0b', facecolor='#ffffff', linewidth=1.5))
    ax.text(34.5, 78, "Dải Đèn LED RGB WS2812B NeoPixel (Chiếu sáng chính)", ha='center', va='center', fontsize=9.8, fontweight='bold', color='#0f172a')
    ax.text(34.5, 73.5, "• Máng nhôm tản nhiệt âm trần kèm nắp nhựa mờ tán quang\n• Hiệu ứng ánh sáng: Thở Cyan khi chưa kết nối / Nhấp nháy khi loa nói", ha='center', va='center', fontsize=8.2, color='#475569')

    # DHT22 Box
    ax.add_patch(patches.FancyBboxPatch((60, 70), 28, 13, boxstyle="round,pad=0.4", 
                                        edgecolor='#10b981', facecolor='#ffffff', linewidth=1.5))
    ax.text(74, 78, "Cảm biến nhiệt ẩm DHT22", ha='center', va='center', fontsize=9.8, fontweight='bold', color='#047857')
    ax.text(74, 73.5, "• Đặt tại khe thoáng khí đối lưu tự nhiên\n• Cách xa máng đèn LED tránh nhiệt cục bộ", ha='center', va='center', fontsize=8.2, color='#475569')

    # Zone 2: Interactive Wall (Vách tường tương tác - x: 8 to 92, y: 35 to 63)
    ax.add_patch(patches.FancyBboxPatch((8, 35), 84, 28, boxstyle="round,pad=0.8", 
                                        edgecolor='#2563eb', facecolor='#eff6ff', linewidth=2))
    ax.text(50, 59.5, "PHÂN VÙNG VÁCH TƯỜNG TƯƠNG TÁC (INTERACTIVE WALL ZONE)", ha='center', va='center', fontsize=11, fontweight='bold', color='#1d4ed8')

    # OLED Box
    ax.add_patch(patches.Rectangle((12, 39), 24, 16, facecolor='#1e293b', edgecolor='#38bdf8', lw=2))
    ax.text(24, 49, "Màn hình OLED 0.96\"\n[Nhiệt độ - Độ ẩm]\n[Hội thoại Tiếng Việt]", ha='center', va='center', fontsize=9.2, fontweight='bold', color='#38bdf8')
    ax.text(24, 42, "Tầm mắt quan sát (180mm)", ha='center', va='center', fontsize=7.8, color='#94a3b8')

    # Mic INMP441 Box
    ax.add_patch(patches.Rectangle((42, 39), 20, 16, facecolor='#ffffff', edgecolor='#0284c7', lw=1.8))
    ax.text(52, 49, "Lỗ thu âm Micro\nINMP441", ha='center', va='center', fontsize=9.5, fontweight='bold', color='#0369a1')
    ax.text(52, 43, "Lưới chắn gió tiêu âm\nHướng thẳng 0° vào người", ha='center', va='center', fontsize=7.8, color='#334155')

    # Speaker MAX98357A Box
    ax.add_patch(patches.Rectangle((68, 39), 20, 16, facecolor='#ffffff', edgecolor='#d97706', lw=1.8))
    ax.text(78, 49, "Loa Dynamic 3W 4Ω\n+ DAC MAX98357A", ha='center', va='center', fontsize=9.5, fontweight='bold', color='#b45309')
    ax.text(78, 43, "Lưới tán âm chéo góc 45°\nĐệm cao su chống rung", ha='center', va='center', fontsize=7.8, color='#334155')

    # Acoustic isolation arrow
    ax.annotate("", xy=(42, 47), xytext=(68, 47),
                arrowprops=dict(arrowstyle="<->", color="#ef4444", lw=2.2, ls="--"))
    ax.text(55, 36.5, "KHOẢNG CÁCH TIÊU ÂM VẬT LÝ >= 150 mm\n(Đệm cao su tiêu chấn triệt tiêu cộng hưởng dội âm)", 
            ha='center', va='top', fontsize=8.6, fontweight='bold', color='#dc2626')

    # Zone 3: Control Base (Hộp kỹ thuật âm sàn - x: 8 to 92, y: 6 to 31)
    ax.add_patch(patches.FancyBboxPatch((8, 6), 84, 25, boxstyle="round,pad=0.8", 
                                        edgecolor='#64748b', facecolor='#f1f5f9', linewidth=2))
    ax.text(50, 27.5, "HỘP KỸ THUẬT ÂM SÀN (CONTROL BASE - ĐƯỢC GIẤU KÍN DƯỚI ĐẾ)", ha='center', va='center', fontsize=11, fontweight='bold', color='#334155')

    # Sub-base components
    ax.add_patch(patches.Rectangle((12, 9), 24, 15, facecolor='#ffffff', edgecolor='#cbd5e1', lw=1.2))
    ax.text(24, 18, "Bộ Nguồn Adapter 12V 1A\n+ Module Testboard MB-102", ha='center', va='center', fontsize=9, fontweight='bold', color='#334155')
    ax.text(24, 12.5, "Phân tách ray 5V & 3.3V độc lập", ha='center', va='center', fontsize=7.8, color='#64748b')

    ax.add_patch(patches.Rectangle((40, 9), 26, 15, facecolor='#ffffff', edgecolor='#2563eb', lw=1.8))
    ax.text(53, 18, "Bo mạch ESP32-S3 N16R8\n(Xtensa Dual-Core, 8MB PSRAM)", ha='center', va='center', fontsize=9.2, fontweight='bold', color='#1d4ed8')
    ax.text(53, 12.5, "Nút nhấn BOOT (GPIO 0) trổ ra vỏ", ha='center', va='center', fontsize=7.8, color='#1e40af')

    ax.add_patch(patches.Rectangle((70, 9), 18, 15, facecolor='#ffffff', edgecolor='#cbd5e1', lw=1.2))
    ax.text(79, 18, "Đế Breadboard MB-102\n& Máng cáp luồn dây", ha='center', va='center', fontsize=9, fontweight='bold', color='#334155')
    ax.text(79, 12.5, "Tách cáp tín hiệu & nguồn", ha='center', va='center', fontsize=7.8, color='#64748b')

    plt.tight_layout()
    out_path = os.path.join(fig_dir, 'hinh_5_2_so_do_bo_tri_sa_ban.png')
    plt.savefig(out_path, dpi=300, facecolor=fig.get_facecolor(), edgecolor='none')
    plt.close()
    print('Generated detailed Fig 5.2:', out_path)

if __name__ == '__main__':
    generate_fig_4_1()
    generate_fig_4_2()
    generate_fig_4_3()
    generate_fig_5_1()
    generate_fig_5_2()
    print('All 5 diagrams successfully generated with meticulous detail!')
