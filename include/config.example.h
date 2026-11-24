#pragma once
constexpr char WIFI_SSID[] = "YOUR_WIFI_SSID";
constexpr char WIFI_PASSWORD[] = "YOUR_WIFI_PASSWORD";
constexpr char WS_HOST[] = "192.168.1.100";
constexpr unsigned short WS_PORT = 3100;
constexpr char WS_PATH[] = "/aiot";
// Public address of the backend (Cloudflare tunnel, TLS). Used on any Wi-Fi other than the
// laptop hotspot, and as a fallback when the LAN backend cannot be reached. "" = LAN only.
constexpr char WS_PUBLIC_HOST[] = "aiot.example.com";
constexpr unsigned short WS_PUBLIC_PORT = 443;
constexpr char WS_TOKEN[] = "CHANGE_ME_DEVICE_TOKEN_32_CHARS";
constexpr unsigned char OLED_ADDRESS = 0x3C;
constexpr unsigned short LED_COUNT = 1;
constexpr unsigned char LED_BRIGHTNESS = 40;
constexpr unsigned char MIC_SHIFT = 16; // 2x gain: speech at 20-30 cm was barely above VAD_RMS
constexpr bool MUTE_MIC_DURING_PLAYBACK = true;
