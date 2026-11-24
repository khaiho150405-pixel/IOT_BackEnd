#include <Arduino.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <DHT.h>
#include <FastLED.h>
#include <driver/i2s.h>
#include <esp_heap_caps.h>
#include <esp_system.h>
#include <mbedtls/base64.h>
#include <Preferences.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <atomic>
#if __has_include("config.h")
#include "config.h"
#elif __has_include("config.example.h")
#include "config.example.h"
#else
#error "Missing include/config.h. Copy include/config.example.h to include/config.h."
#endif

// Arduino-ESP32 2.0.17 / ESP-IDF 4.4 legacy I2S API, pinned in platformio.ini.
namespace {
// Pins follow the board edges so no jumper crosses another (USB connectors on the left):
//   lower header (5VIN G13 G14 G21 ... G2 G1 GND): OLED, DHT22 at the left end, WS2812B at the right end
//   upper header (3V3 ... G17 G16 G15 ... G6 G5 G4 EN 3V3 GND): MAX98357A in the middle, INMP441 at the right end
// Avoided: G0/G3/G45/G46 (strapping), G19/G20 (USB), G35-G37 (octal PSRAM), G43/G44 (serial log), G48 (on-board RGB).
constexpr int DHT_PIN = 21;
constexpr int SCL_PIN = 13, SDA_PIN = 14, LED_PIN = 1;
constexpr int MIC_WS = 4, MIC_BCLK = 5, MIC_SD = 6;
// Left to right on the header: G17 G16 G15 = LRC BCLK DIN, the order of the MAX98357A pins.
constexpr int SPK_WS = 17, SPK_BCLK = 16, SPK_DIN = 15;
constexpr uint32_t SAMPLE_RATE = 16000;
constexpr size_t MIC_SAMPLES = 256;
constexpr size_t AUDIO_CAPACITY = 32768; // 2 seconds of mono PCM16, in PSRAM.
constexpr size_t MAX_AUDIO_FRAME = 4096;
constexpr int OLED_CONTENT_HEIGHT = 28;
constexpr int OLED_CONTENT_Y = 36;
constexpr size_t OLED_PAGE_BYTES = 128 * OLED_CONTENT_HEIGHT / 8;
constexpr size_t OLED_MAX_PAGES = 32;
constexpr int INTERRUPT_BUTTON = 0; // Existing BOOT button, only while running.
static_assert(MIC_SHIFT >= 8 && MIC_SHIFT <= 24, "Invalid MIC_SHIFT");
static_assert(LED_COUNT > 0, "LED_COUNT must be positive");

DHT dht(DHT_PIN, DHT22);
// 100 kHz I2C: long breadboard jumpers next to the I2S lines corrupt 400 kHz transfers.
Adafruit_SSD1306 display(128, 64, &Wire, -1, 100000UL, 100000UL);
CRGB leds[LED_COUNT];
// WebSocketsClient that can tell whether the socket has room for another audio frame. A full
// lwIP send buffer made WiFiClient::write block for up to 10 s (10 retries x 1 s), freezing the
// whole network loop; audio frames are dropped instead of waiting.
class AiotSocket : public WebSocketsClient {
 public:
  bool canWriteNow() {
    if (!_client.tcp) return false;
    const int fd = _client.tcp->fd();
    if (fd < 0) return true;
    fd_set set;
    FD_ZERO(&set);
    FD_SET(fd, &set);
    timeval tv = {0, 0};
    // lwIP reports "writable" only with >= TCP_SNDLOWAT (~2.8 KB) free: a frame never blocks.
    return select(fd + 1, nullptr, &set, nullptr, &tv) > 0 && FD_ISSET(fd, &set);
  }
};
AiotSocket socketClient;
std::atomic<bool> connected{false}, speaking{false}, ledEnabled{true};
std::atomic<uint32_t> ledColor{0x00FF00};
std::atomic<bool> serverBusy{false};
uint32_t wsConnectedAt = 0;
std::atomic<unsigned> uiState{0}; // offline, listening, thinking, speech, music, error
// Status bar inputs: whether the assistant name is needed, the no-name window (countdown),
// and the microphone gate (the user is being recorded right now) with its level.
std::atomic<bool> wakeRequired{true}, micCapturing{false};
std::atomic<uint32_t> followUntilMs{0}, followTotalMs{0};
std::atomic<int> micLevel{0};
portMUX_TYPE displayMux = portMUX_INITIALIZER_UNLOCKED;
uint8_t *oledPages = nullptr;
size_t oledPageCount = 0;
uint32_t oledGeneration = 0;
char oledBatch[48] = {};
bool remotePlayback = false;
uint32_t lastServerMessage = 0;
portMUX_TYPE sensorMux = portMUX_INITIALIZER_UNLOCKED;
float temperature = NAN, humidity = NAN;
bool sensorValid = false;
int16_t *audio = nullptr;
size_t audioRead = 0, audioCount = 0;
uint32_t lastPlayback = 0;
bool playbackSeen = false;
char playbackId[48] = {};
bool playbackAckPending = false;
uint32_t lastAudioPacket = 0;
// Microphone slot actually carrying the INMP441 signal (0 or 1 in the stereo
// I2S frame) and a smoothed "speech-likeness" score per slot, see readMic().
int micSlot = 0;
float micScore[2] = {0, 0};
// Diagnostics: slowest network-loop pass since the last sensor report and the part that caused it.
uint32_t loopMaxMs = 0;
const char *loopSlowPart = "";
float micPeakRms = 0;     // loudest 16 ms chunk (voice band) since the last report
uint32_t micOpenCount = 0; // voice-gate openings since the last report
uint32_t micDropCount = 0; // audio frames dropped because the socket was full

void clearPlayback();

Preferences preferences;
char curSsid[64] = "";
uint32_t portalUsedAt = 0; // last request to the setup page (pauses Wi-Fi reconnect attempts)
volatile uint8_t lastWifiReason = 0; // why the last Wi-Fi join failed (ESP-IDF reason code)
char curPass[64] = "";
char curHost[64] = "";
uint16_t curPort = WS_PORT;
char curToken[64] = "";
char lastReply[160] = "Em chao dai ca! He thong AIoT da san sang.";
char lastTranscript[128] = "Chua co khau lenh";

WebServer *configServer = nullptr;
DNSServer *dnsServer = nullptr;

void loadConfig() {
  preferences.begin("aiot_net", false);
  String s = preferences.getString("ssid", WIFI_SSID);
  String p = preferences.getString("pass", WIFI_PASSWORD);
  String h = preferences.getString("host", WS_HOST);
  uint16_t pt = preferences.getUShort("port", WS_PORT);
  String tk = preferences.getString("token", WS_TOKEN);
  // One-time migration: the backend moved from port 3000 (now another service on the
  // laptop, published by its own tunnel) to 3100. A port saved from the setup page
  // before that still says 3000.
  if (preferences.getUChar("cfg_ver", 1) < 2) {
    if (pt == 3000) { pt = WS_PORT; preferences.putUShort("port", pt); }
    preferences.putUChar("cfg_ver", 2);
  }
  preferences.end();

  strlcpy(curSsid, s.c_str(), sizeof(curSsid));
  strlcpy(curPass, p.c_str(), sizeof(curPass));
  strlcpy(curHost, h.c_str(), sizeof(curHost));
  curPort = (pt > 0 && pt < 65535) ? pt : WS_PORT;
  strlcpy(curToken, tk.c_str(), sizeof(curToken));
}

// Token typed on the setup page overrides WS_TOKEN from config.h until BOOT is held 3 s.
void saveToken(const char *token) {
  preferences.begin("aiot_net", false);
  preferences.putString("token", token);
  preferences.end();
  strlcpy(curToken, token, sizeof(curToken));
}

void clearSavedToken() {
  preferences.begin("aiot_net", false);
  preferences.remove("token");
  preferences.end();
  strlcpy(curToken, WS_TOKEN, sizeof(curToken));
}

void saveConfig(const char *ssid, const char *pass, const char *host, uint16_t port) {
  preferences.begin("aiot_net", false);
  preferences.putString("ssid", ssid);
  preferences.putString("pass", pass);
  preferences.putString("host", host);
  preferences.putUShort("port", port);
  preferences.end();

  strlcpy(curSsid, ssid, sizeof(curSsid));
  strlcpy(curPass, pass, sizeof(curPass));
  strlcpy(curHost, host, sizeof(curHost));
  curPort = port;
}

void handleApiStatus() {
  if (!configServer) return;
  if (portalUsedAt) portalUsedAt = millis();
  float t = 0, h = 0; bool valid = false;
  portENTER_CRITICAL(&sensorMux);
  t = temperature; h = humidity; valid = sensorValid;
  portEXIT_CRITICAL(&sensorMux);

  StaticJsonDocument<512> doc;
  doc["temp"] = valid ? String(t, 1) : "--.-";
  doc["humid"] = valid ? String(h, 0) : "--";
  doc["valid"] = valid;
  doc["led"] = ledEnabled.load();
  uint32_t c = ledColor.load();
  char hexColor[10];
  snprintf(hexColor, sizeof(hexColor), "#%06X", c & 0xFFFFFF);
  doc["color"] = hexColor;
  doc["connected"] = connected.load();
  doc["state"] = uiState.load();
  doc["reply"] = lastReply;
  doc["transcript"] = lastTranscript;
  doc["wifi"] = (WiFi.status() == WL_CONNECTED) ? WiFi.SSID() : "Cho ket noi";
  doc["target"] = curSsid;
  const uint8_t r = lastWifiReason;
  // 15/202/204/210: handshake or authentication failed (almost always a wrong password);
  // 201: network not found; 205: AP refused (often a full or MAC-filtered router).
  doc["problem"] = (r == 15 || r == 202 || r == 204 || r == 210 || r == 2 || r == 23) ? "Sai mật khẩu Wi-Fi?" :
                   r == 201 ? "Không thấy mạng (tắt hoặc chỉ 5 GHz?)" :
                   r == 205 ? "Router từ chối thiết bị" : r ? "Không vào được Wi-Fi (mã lỗi " + String(r) + ")" : "";
  doc["ip"] = WiFi.localIP().toString();
  String out;
  serializeJson(doc, out);
  configServer->send(200, "application/json", out);
}

void handleApiLed() {
  if (!configServer) return;
  if (configServer->hasArg("toggle")) {
    ledEnabled = !ledEnabled.load();
  } else if (configServer->hasArg("state")) {
    ledEnabled = (configServer->arg("state") == "1" || configServer->arg("state") == "true");
  }
  if (configServer->hasArg("color")) {
    String hex = configServer->arg("color");
    if (hex.startsWith("#")) hex = hex.substring(1);
    long val = strtol(hex.c_str(), NULL, 16);
    ledColor = (uint32_t)val;
  }
  if (connected.load()) {
    StaticJsonDocument<128> ack;
    ack["type"] = "ack";
    ack["device"] = "led";
    ack["action"] = ledEnabled.load() ? "on" : "off";
    ack["enabled"] = ledEnabled.load();
    String out;
    serializeJson(ack, out);
    socketClient.sendTXT(out);
  }
  handleApiStatus();
}

// ----------------------------------------------------------------------------- saved Wi-Fi networks
// Up to 5 networks are remembered (newest first). When Wi-Fi is down the ESP32 scans and joins the
// strongest one in range, so each place (home, laptop hotspot, lab...) is set up only once. The
// network from include/config.h is always tried as well.
constexpr int MAX_NETWORKS = 5;
char knownSsid[MAX_NETWORKS][33];
char knownPass[MAX_NETWORKS][65];
int knownCount = 0;

void loadKnownNetworks() {
  preferences.begin("aiot_net", true);
  knownCount = preferences.getUChar("wn", 255);
  if (knownCount == 255) {
    // First start with this firmware: keep the single network saved by older firmware.
    knownCount = 0;
    String s = preferences.getString("ssid", ""), p = preferences.getString("pass", "");
    if (s.length() && s != WIFI_SSID) {
      strlcpy(knownSsid[0], s.c_str(), sizeof(knownSsid[0]));
      strlcpy(knownPass[0], p.c_str(), sizeof(knownPass[0]));
      knownCount = 1;
    }
  } else {
    knownCount = min(knownCount, MAX_NETWORKS);
    for (int i = 0; i < knownCount; ++i) {
      char key[4];
      snprintf(key, sizeof(key), "s%d", i);
      strlcpy(knownSsid[i], preferences.getString(key, "").c_str(), sizeof(knownSsid[i]));
      snprintf(key, sizeof(key), "p%d", i);
      strlcpy(knownPass[i], preferences.getString(key, "").c_str(), sizeof(knownPass[i]));
    }
  }
  preferences.end();
}

void storeKnownNetworks() {
  preferences.begin("aiot_net", false);
  preferences.putUChar("wn", knownCount);
  for (int i = 0; i < knownCount; ++i) {
    char key[4];
    snprintf(key, sizeof(key), "s%d", i);
    preferences.putString(key, knownSsid[i]);
    snprintf(key, sizeof(key), "p%d", i);
    preferences.putString(key, knownPass[i]);
  }
  preferences.end();
}

int findKnown(const char *ssid) {
  for (int i = 0; i < knownCount; ++i) if (!strcmp(knownSsid[i], ssid)) return i;
  return -1;
}

// Same network if the names match once surrounding spaces are ignored.
int findKnownLoose(const String &ssid) {
  String wanted = ssid;
  wanted.trim();
  for (int i = 0; i < knownCount; ++i) {
    String saved = knownSsid[i];
    saved.trim();
    if (saved == wanted) return i;
  }
  return -1;
}

// Adds or refreshes a network at the front of the list. An empty password for a network that is
// already saved keeps the saved password (the setup page never shows passwords).
void rememberNetwork(const char *ssid, const char *pass) {
  char keepPass[65];
  const int at = findKnown(ssid);
  strlcpy(keepPass, (pass[0] || at < 0) ? pass : knownPass[at], sizeof(keepPass));
  if (at >= 0) {
    for (int i = at; i < knownCount - 1; ++i) {
      memcpy(knownSsid[i], knownSsid[i + 1], sizeof(knownSsid[i]));
      memcpy(knownPass[i], knownPass[i + 1], sizeof(knownPass[i]));
    }
    --knownCount;
  }
  for (int i = min(knownCount, MAX_NETWORKS - 1); i > 0; --i) {
    memcpy(knownSsid[i], knownSsid[i - 1], sizeof(knownSsid[i]));
    memcpy(knownPass[i], knownPass[i - 1], sizeof(knownPass[i]));
  }
  strlcpy(knownSsid[0], ssid, sizeof(knownSsid[0]));
  strlcpy(knownPass[0], keepPass, sizeof(knownPass[0]));
  knownCount = min(knownCount + 1, MAX_NETWORKS);
  storeKnownNetworks();
}

void forgetNetwork(const char *ssid) {
  const int at = findKnown(ssid);
  if (at < 0) return;
  for (int i = at; i < knownCount - 1; ++i) {
    memcpy(knownSsid[i], knownSsid[i + 1], sizeof(knownSsid[i]));
    memcpy(knownPass[i], knownPass[i + 1], sizeof(knownPass[i]));
  }
  --knownCount;
  storeKnownNetworks();
}

// Joins the strongest saved network in range (or the config.h one). Blocks ~2 s for the scan,
// which only happens while Wi-Fi is down.
// While someone uses the setup page, automatic reconnect attempts pause: a station that is busy
// connecting makes every scan fail, so the page showed "no networks".
bool portalInUse() { return portalUsedAt && millis() - portalUsedAt < 90000; }

// Scans for networks, first stopping a connection attempt in progress (ESP-IDF refuses to scan
// meanwhile) and retrying a failed scan. Returns the number found (0 on failure).
int scanWifi() {
  if (WiFi.status() != WL_CONNECTED) WiFi.disconnect(false, false);
  for (int attempt = 0; attempt < 4; ++attempt) {
    const int found = WiFi.scanNetworks(false, true); // blocking, include hidden networks
    if (found >= 0) {
      Serial.printf("Wi-Fi scan: %d network(s)\n", found);
      return found;
    }
    Serial.printf("Wi-Fi scan failed (%d), retrying\n", found);
    WiFi.scanDelete();
    delay(300);
  }
  return 0;
}

void connectBestNetwork() {
  const char *ssid = WIFI_SSID, *pass = WIFI_PASSWORD;
  if (portalInUse()) return; // let the setup page scan; it saves and restarts anyway
  if (knownCount > 0) {
    const int found = scanWifi();
    int bestRssi = -1000;
    for (int n = 0; n < found; ++n) {
      const String name = WiFi.SSID(n);
      const int at = findKnownLoose(name);
      const bool builtin = name == WIFI_SSID;
      if ((at >= 0 || builtin) && WiFi.RSSI(n) > bestRssi) {
        bestRssi = WiFi.RSSI(n);
        if (at >= 0 && name != knownSsid[at] && name.length() < sizeof(knownSsid[at])) {
          Serial.printf("Wi-Fi: saved name \"%s\" repaired to \"%s\"\n", knownSsid[at], name.c_str());
          strlcpy(knownSsid[at], name.c_str(), sizeof(knownSsid[at]));
          storeKnownNetworks();
        }
        ssid = at >= 0 ? knownSsid[at] : WIFI_SSID;
        pass = at >= 0 ? knownPass[at] : WIFI_PASSWORD;
      }
    }
    if (bestRssi == -1000) {
      // None of the saved names is in range: log what is, quoted, so a name that differs only by
      // spaces or letter case is easy to spot.
      for (int n = 0; n < found && n < 12; ++n) Serial.printf("  seen [%s] %d dBm\n", WiFi.SSID(n).c_str(), WiFi.RSSI(n));
      ssid = knownSsid[0]; pass = knownPass[0]; // try the newest anyway
    }
    WiFi.scanDelete();
  }
  strlcpy(curSsid, ssid, sizeof(curSsid));
  strlcpy(curPass, pass, sizeof(curPass));
  Serial.printf("Wi-Fi: joining \"%s\"\n", curSsid);
  WiFi.begin(curSsid, curPass);
}

String htmlEscape(const String &text) {
  String out;
  out.reserve(text.length() + 8);
  for (size_t i = 0; i < text.length(); ++i) {
    const char c = text[i];
    if (c == '&') out += "&amp;";
    else if (c == '<') out += "&lt;";
    else if (c == '>') out += "&gt;";
    else if (c == '"') out += "&quot;";
    else if (c == '\'') out += "&#39;";
    else out += c;
  }
  return out;
}

void handleRoot() {
  if (!configServer) return;
  portalUsedAt = millis();
  // Nearby networks, strongest first, without duplicates (one entry per name).
  const int found = scanWifi();
  String nearby, seen = "\n";
  for (int n = 0; n < found; ++n) {
    int best = -1;
    for (int k = 0; k < found; ++k) {
      const String name = WiFi.SSID(k);
      if (!name.length() || seen.indexOf("\n" + name + "\n") >= 0) continue;
      if (best < 0 || WiFi.RSSI(k) > WiFi.RSSI(best)) best = k;
    }
    if (best < 0 || nearby.length() > 3500) break;
    const String name = WiFi.SSID(best);
    seen += name + "\n";
    const int rssi = WiFi.RSSI(best);
    const int bars = rssi > -55 ? 4 : rssi > -65 ? 3 : rssi > -75 ? 2 : 1;
    const bool open = WiFi.encryptionType(best) == WIFI_AUTH_OPEN;
    const bool saved = findKnownLoose(name) >= 0 || name == WIFI_SSID;
    const String safe = htmlEscape(name);
    nearby += "<button type='button' class='net' data-ssid='" + safe + "' data-open='" + String(open ? 1 : 0) +
              "' data-saved='" + String(saved ? 1 : 0) + "'><span class='bars b" + String(bars) +
              "'><i></i><i></i><i></i><i></i></span><span class='nm'>" + safe + "</span>" +
              (saved ? "<span class='tag'>Đã lưu</span>" : "") + (open ? "" : "<span class='lock'>🔒</span>") +
              "</button>";
  }
  WiFi.scanDelete();
  if (!nearby.length()) nearby = "<p class='muted'>Không thấy mạng nào. Nhấn Quét lại.</p>";

  String savedList;
  for (int i = 0; i < knownCount; ++i) {
    const String safe = htmlEscape(knownSsid[i]);
    savedList += "<li><span>" + safe + "</span><form method='POST' action='/forget'><input type='hidden' name='ssid' value='" +
                 safe + "'><button class='link'>Quên</button></form></li>";
  }
  if (!savedList.length()) savedList = "<li class='muted'>Chưa lưu mạng nào.</li>";

  String html = R"rawliteral(<!DOCTYPE html>
<html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>AIoT Smart Room - Cài đặt Wi-Fi</title>
<style>
:root{--bg:#0b1120;--card:#141c2f;--line:#26324a;--accent:#38bdf8;--text:#f1f5f9;--muted:#94a3b8;--ok:#34d399;--warn:#fbbf24}
*{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,"Segoe UI",Roboto,sans-serif}
html,body{background:var(--bg);color:var(--text)}
body{padding:16px 16px calc(40vh + env(safe-area-inset-bottom));line-height:1.45}
main{max-width:460px;margin:0 auto;display:flex;flex-direction:column;gap:14px}
h1{font-size:1.15rem;color:var(--accent)}
.sub{font-size:.85rem;color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px}
.card h2{font-size:.95rem;margin-bottom:10px}
.row{display:flex;gap:10px;align-items:center;justify-content:space-between}
.pill{font-size:.75rem;padding:4px 10px;border-radius:20px;font-weight:600;white-space:nowrap}
.on{background:rgba(52,211,153,.15);color:var(--ok)}.wait{background:rgba(251,191,36,.15);color:var(--warn)}
.nets{display:flex;flex-direction:column;gap:6px;max-height:300px;overflow-y:auto;margin-bottom:12px}
.net{display:flex;align-items:center;gap:10px;width:100%;padding:12px;border-radius:10px;border:1px solid var(--line);background:#0f172a;color:var(--text);font-size:.95rem;text-align:left;cursor:pointer}
.net.sel{border-color:var(--accent);background:#0c2536}
.nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tag{font-size:.7rem;color:var(--ok);border:1px solid var(--ok);border-radius:6px;padding:1px 6px}
.bars{display:inline-flex;align-items:flex-end;gap:2px;height:14px}
.bars i{width:3px;background:#334155;border-radius:1px}.bars i:nth-child(1){height:4px}.bars i:nth-child(2){height:7px}.bars i:nth-child(3){height:10px}.bars i:nth-child(4){height:14px}
.b1 i:nth-child(-n+1),.b2 i:nth-child(-n+2),.b3 i:nth-child(-n+3),.b4 i:nth-child(-n+4){background:var(--accent)}
label{display:block;font-size:.8rem;color:var(--muted);margin:10px 0 4px}
input{width:100%;padding:12px;border-radius:10px;border:1px solid var(--line);background:#0f172a;color:var(--text);font-size:16px}
.pw{position:relative}.pw button{position:absolute;right:6px;top:6px;padding:6px 10px;border:0;border-radius:8px;background:#1e293b;color:var(--muted);font-size:.8rem}
.btn{width:100%;margin-top:14px;padding:13px;border:0;border-radius:12px;background:linear-gradient(135deg,#0284c7,#2563eb);color:#fff;font-size:1rem;font-weight:600}
.btn2{padding:8px 12px;border:1px solid var(--line);border-radius:10px;background:transparent;color:var(--accent);font-size:.85rem}
details{margin-top:12px;border-top:1px solid var(--line);padding-top:10px}
summary{cursor:pointer;color:var(--accent);font-size:.88rem}
.muted{color:var(--muted);font-size:.85rem}
.hint{font-size:.8rem;color:var(--muted);margin-top:6px}
ul{list-style:none}li{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--line)}
li form{margin:0}.link{background:none;border:0;color:#f87171;font-size:.85rem}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;text-align:center}
.big{font-size:1.6rem;font-weight:700}
</style></head><body><main>
<div class="row"><div><h1>🏠 AIoT Smart Room</h1><div class="sub">Cài đặt Wi-Fi cho thiết bị</div></div>
<span id="conn" class="pill wait">Đang kiểm tra…</span></div>

<div class="card">
<h2>1. Chọn mạng Wi-Fi</h2>
<p class="hint" style="margin:-4px 0 10px">Thiết bị chỉ dùng được Wi-Fi 2.4 GHz. Nếu router có hai tên (ví dụ "Nhà" và "Nhà_5G"), chọn tên không có 5G.</p>
<div class="nets" id="nets">)rawliteral";
  html += nearby;
  html += R"rawliteral(</div>
<div class="row"><span class="muted">Không thấy mạng của bạn?</span><a class="btn2" href="/">Quét lại</a></div>
<form method="POST" action="/save" id="f">
<label for="ssid">2. Tên Wi-Fi</label>
<input id="ssid" name="ssid" required maxlength="32" autocomplete="off" autocapitalize="none" placeholder="Chạm vào một mạng ở trên">
<label for="pass">3. Mật khẩu Wi-Fi</label>
<div class="pw"><input id="pass" name="pass" type="password" maxlength="63" autocomplete="off" placeholder="Mật khẩu"><button type="button" id="eye">Hiện</button></div>
<p class="hint" id="passHint"></p>
<details><summary>Nâng cao (thường không cần đổi)</summary>
<p class="hint">Thiết bị tự tìm máy chủ qua Internet tại <b>aiot.eduscore.id.vn</b>. Địa chỉ IP chỉ dùng khi thiết bị vào hotspot của laptop (tự đặt 192.168.137.1).</p>
<label for="host">IP máy chủ trong mạng nội bộ</label>
<input id="host" name="host" maxlength="63" value=")rawliteral";
  html += htmlEscape(curHost);
  html += R"rawliteral(">
<label for="port">Cổng</label>
<input id="port" name="port" inputmode="numeric" maxlength="5" value=")rawliteral";
  html += String(curPort);
  html += R"rawliteral(">
<label for="token">Mã thiết bị (DEVICE_TOKEN)</label>
<input id="token" name="token" type="password" autocomplete="off" placeholder="Để trống = giữ mã đang lưu">
</details>
<button class="btn" type="submit">💾 Lưu và kết nối</button>
</form>
</div>

<div class="card"><h2>Mạng đã lưu</h2>
<p class="hint" style="margin:-4px 0 6px">Thiết bị tự vào mạng đã lưu có sóng mạnh nhất, không cần cài lại khi đổi nơi.</p>
<ul>)rawliteral";
  html += savedList;
  html += R"rawliteral(</ul></div>

<div class="card"><h2>Trạng thái phòng</h2>
<div class="grid"><div><div class="muted">Nhiệt độ</div><div class="big"><span id="t">--.-</span>°C</div></div>
<div><div class="muted">Độ ẩm</div><div class="big"><span id="h">--</span>%</div></div></div>
<button class="btn2" style="width:100%;margin-top:12px" id="lamp" type="button">Đèn: --</button>
</div>
</main>
<script>
const ssid=document.getElementById('ssid'),pass=document.getElementById('pass'),hint=document.getElementById('passHint');
document.querySelectorAll('.net').forEach(b=>b.addEventListener('click',()=>{
  document.querySelectorAll('.net').forEach(x=>x.classList.remove('sel'));b.classList.add('sel');
  ssid.value=b.dataset.ssid;
  hint.textContent=b.dataset.open==='1'?'Mạng mở, không cần mật khẩu.':b.dataset.saved==='1'?'Mạng đã lưu: để trống để giữ mật khẩu cũ.':'';
  if(b.dataset.open!=='1'){pass.focus();}
  setTimeout(()=>pass.scrollIntoView({block:'center',behavior:'smooth'}),250);
}));
['ssid','pass','host','port','token'].forEach(id=>{const e=document.getElementById(id);e.addEventListener('focus',()=>setTimeout(()=>e.scrollIntoView({block:'center',behavior:'smooth'}),300));});
document.getElementById('eye').addEventListener('click',e=>{const s=pass.type==='password';pass.type=s?'text':'password';e.target.textContent=s?'Ẩn':'Hiện';});
async function st(){try{const d=await(await fetch('/api/status')).json();
document.getElementById('t').textContent=d.temp;document.getElementById('h').textContent=d.humid;
document.getElementById('lamp').textContent=d.led?'💡 Đèn đang bật – chạm để tắt':'🌑 Đèn đang tắt – chạm để bật';
const c=document.getElementById('conn');c.textContent=d.connected?'Đã kết nối máy chủ':(d.wifi&&d.wifi!=='Cho ket noi'?'Đã vào Wi-Fi '+d.wifi:(d.problem?d.target+': '+d.problem:'Chưa vào Wi-Fi'));c.className='pill '+(d.connected?'on':'wait');}catch(e){}}
document.getElementById('lamp').addEventListener('click',async()=>{try{await fetch('/api/led?toggle=1',{method:'POST'});st();}catch(e){}});
setInterval(st,2000);st();
</script></body></html>)rawliteral";

  configServer->send(200, "text/html", html);
}

void handleForget() {
  if (!configServer) return;
  forgetNetwork(configServer->arg("ssid").c_str());
  configServer->sendHeader("Location", "/");
  configServer->send(303, "text/plain", "");
}

void handleSave() {
  if (!configServer) return;
  String ssid = configServer->arg("ssid");
  String pass = configServer->arg("pass");
  String host = configServer->arg("host");
  String portStr = configServer->arg("port");
  uint16_t port = portStr.toInt();
  if (port == 0 || port > 65535) port = WS_PORT;
  if (host.length() == 0) host = "192.168.137.1";
  // No trim(): a network name may legitimately start or end with spaces (e.g. "Si Khai ").
  if (!ssid.length() || ssid.length() > 32) { configServer->send(400, "text/plain", "Thieu ten Wi-Fi"); return; }

  rememberNetwork(ssid.c_str(), pass.c_str());
  saveConfig(knownSsid[0], knownPass[0], host.c_str(), port);
  String token = configServer->arg("token");
  token.trim();
  if (token.length() >= 24 && token.length() < sizeof(curToken)) saveToken(token.c_str());

  String html = R"rawliteral(<!DOCTYPE html>
<html lang="vi">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Đã lưu cấu hình</title>
<style>body{background:#090d16;color:#f8fafc;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;padding:20px;text-align:center}
.card{background:#111827;border:1px solid #1f2937;border-radius:20px;padding:30px;max-width:380px}
h2{color:#38bdf8;font-size:20px;margin-bottom:12px}p{color:#94a3b8;font-size:14px;line-height:1.6}
.badge{background:#1e293b;color:#38bdf8;padding:4px 10px;border-radius:8px;font-weight:600}
</style></head>
<body><div class="card"><h2>✅ ĐÃ LƯU THÀNH CÔNG!</h2>
<p>ESP32 đang kết nối lại vào Wi-Fi:<br><br><span class="badge">)rawliteral";
  html += ssid;
  html += R"rawliteral(</span><br><br>Đang khởi động lại sau 2 giây...</p></div></body></html>)rawliteral";

  configServer->send(200, "text/html", html);
  delay(1500);
  ESP.restart();
}

bool portalOn = false;

// The setup hotspot (open, no password) runs only while the ESP32 cannot reach the
// backend: an always-on AP shares the radio with the station link and slows it down,
// and anyone nearby could switch the light through /api/led.
void startPortal() {
  if (portalOn) return;
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP("AIoT_Smart_Room");
  if (!dnsServer) {
    dnsServer = new DNSServer();
    dnsServer->setErrorReplyCode(DNSReplyCode::NoError);
  }
  dnsServer->start(53, "*", IPAddress(192, 168, 4, 1));
  if (!configServer) {
    configServer = new WebServer(80);
    configServer->on("/", HTTP_GET, handleRoot);
    configServer->on("/api/status", HTTP_GET, handleApiStatus);
    configServer->on("/api/led", HTTP_POST, handleApiLed);
    configServer->on("/save", HTTP_POST, handleSave);
    configServer->on("/forget", HTTP_POST, handleForget);
    configServer->on("/hotspot-detect.html", HTTP_GET, handleRoot);
    configServer->on("/generate_204", HTTP_GET, handleRoot);
    configServer->on("/ncsi.txt", HTTP_GET, handleRoot);
    configServer->onNotFound(handleRoot);
  }
  configServer->begin();
  portalOn = true;
  Serial.println("Setup hotspot ON @ http://192.168.4.1 (AP: AIoT_Smart_Room)");
}

void stopPortal() {
  if (!portalOn) return;
  portalOn = false;
  if (dnsServer) dnsServer->stop();
  if (configServer) configServer->stop();
  WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_STA);
  Serial.println("Setup hotspot OFF (backend connected)");
}

void fatal(const char *message) {
  Serial.printf("FATAL: %s\n", message);
  for (;;) {
    Serial.printf("FATAL (retry log): %s\n", message);
    fill_solid(leds, LED_COUNT, CRGB::Red);
    FastLED.show();
    delay(500);
    FastLED.clear(true);
    delay(500);
  }
}

void checkEsp(esp_err_t result, const char *operation) {
  if (result != ESP_OK) {
    Serial.printf("%s: %s\n", operation, esp_err_to_name(result));
    fatal(operation);
  }
}

void setupAudio() {
  i2s_config_t mic = {};
  mic.mode = static_cast<i2s_mode_t>(I2S_MODE_MASTER | I2S_MODE_RX);
  mic.sample_rate = SAMPLE_RATE;
  mic.bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT;
  // Read both slots. With ONLY_LEFT the legacy ESP32-S3 driver can sample the
  // empty (tri-stated) slot depending on the L/R strap and driver version: the
  // backend then received a weak, muffled leak of the voice (peak ~3000 even
  // with the mouth on the mic) that speech recognition could not decode.
  // readMic() picks whichever slot carries the real signal.
  mic.channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT;
  mic.communication_format = I2S_COMM_FORMAT_STAND_I2S;
  mic.intr_alloc_flags = ESP_INTR_FLAG_LEVEL1;
  mic.dma_buf_count = 8;
  mic.dma_buf_len = MIC_SAMPLES;
  i2s_pin_config_t micPins = {};
  micPins.mck_io_num = I2S_PIN_NO_CHANGE;
  micPins.bck_io_num = MIC_BCLK;
  micPins.ws_io_num = MIC_WS;
  micPins.data_out_num = I2S_PIN_NO_CHANGE;
  micPins.data_in_num = MIC_SD;
  checkEsp(i2s_driver_install(I2S_NUM_0, &mic, 0, nullptr), "Mic driver");
  checkEsp(i2s_set_pin(I2S_NUM_0, &micPins), "Mic pins");

  i2s_config_t spk = mic;
  spk.mode = static_cast<i2s_mode_t>(I2S_MODE_MASTER | I2S_MODE_TX);
  spk.bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT;
  spk.channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT;
  spk.tx_desc_auto_clear = true;
  spk.dma_buf_count = 4;
  spk.dma_buf_len = 128;
  i2s_pin_config_t spkPins = {};
  spkPins.mck_io_num = I2S_PIN_NO_CHANGE;
  spkPins.bck_io_num = SPK_BCLK;
  spkPins.ws_io_num = SPK_WS;
  spkPins.data_out_num = SPK_DIN;
  spkPins.data_in_num = I2S_PIN_NO_CHANGE;
  checkEsp(i2s_driver_install(I2S_NUM_1, &spk, 0, nullptr), "Speaker driver");
  checkEsp(i2s_set_pin(I2S_NUM_1, &spkPins), "Speaker pins");
  checkEsp(i2s_zero_dma_buffer(I2S_NUM_1), "Speaker clear");
}

// Called only by the network task: WebSocket callbacks never block on playback.
void clearPlayback() {
  audioCount = audioRead = 0;
  playbackSeen = false;
  speaking = false;
  remotePlayback = false;
  playbackAckPending = false;
  playbackId[0] = '\0';
  i2s_zero_dma_buffer(I2S_NUM_1);
}

void sendError(const char *message) {
  StaticJsonDocument<192> doc;
  doc["type"] = "error";
  doc["message"] = message;
  String output;
  serializeJson(doc, output);
  socketClient.sendTXT(output);
}

void receiveAudio(const uint8_t *data, size_t length) {
  lastAudioPacket = millis();
  if (!length || length > MAX_AUDIO_FRAME || length % 2) {
    sendError("audio_requires_even_PCM16_bytes_max_4096");
    return;
  }
  if (length / 2 > AUDIO_CAPACITY - audioCount) {
    // Reject the entire chunk; backend should pace audio at real-time speed.
    sendError("audio_buffer_full");
    return;
  }
  for (size_t i = 0; i < length; i += 2) {
    const uint16_t sample = data[i] | (uint16_t(data[i + 1]) << 8);
    audio[(audioRead + audioCount++) % AUDIO_CAPACITY] = static_cast<int16_t>(sample);
  }
  speaking = true;
}

void receiveJson(const uint8_t *data, size_t length) {
  if (length > 2048) {
    sendError("JSON_too_large");
    return;
  }
  StaticJsonDocument<3072> doc;
  if (deserializeJson(doc, data, length)) {
    sendError("invalid_JSON");
    return;
  }
  const char *type = doc["type"] | "";
  if (!strcmp(type, "display")) {
    if (!doc["index"].is<unsigned>() || !doc["total"].is<unsigned>() ||
        !doc["bitmap"].is<const char *>() || !doc["batch"].is<const char *>()) {
      sendError("invalid_display_page"); return;
    }
    const unsigned index = doc["index"], total = doc["total"];
    const char *batch = doc["batch"];
    const char *encoded = doc["bitmap"];
    uint8_t bitmap[OLED_PAGE_BYTES];
    size_t decoded = 0;
    if (!total || total > OLED_MAX_PAGES || index >= total || strlen(batch) >= sizeof(oledBatch) ||
        mbedtls_base64_decode(bitmap, sizeof(bitmap), &decoded,
          reinterpret_cast<const unsigned char *>(encoded), strlen(encoded)) != 0 || decoded != sizeof(bitmap)) {
      sendError("invalid_display_bitmap"); return;
    }
    if (index && (strcmp(batch, oledBatch) || index != oledPageCount)) {
      sendError("display_page_order"); return;
    }
    portENTER_CRITICAL(&displayMux);
    if (index == 0) {
      strlcpy(oledBatch, batch, sizeof(oledBatch));
      oledPageCount = 0; ++oledGeneration;
    }
    memcpy(oledPages + index * OLED_PAGE_BYTES, bitmap, sizeof(bitmap));
    oledPageCount = index + 1;
    portEXIT_CRITICAL(&displayMux);
    return;
  }
  if (!strcmp(type, "status")) {
    const char *state = doc["state"] | "";
    if (!strcmp(state, "listening")) {
      clearPlayback(); serverBusy = false; uiState = 1;
      wakeRequired = doc["wake"] | true;
      const uint32_t follow = doc["follow_ms"] | 0u;
      followTotalMs = follow;
      followUntilMs = follow ? millis() + follow : 0;
      Serial.println("Microphone ready: listening");
    }
    else if (!strcmp(state, "thinking")) { serverBusy = true; uiState = 2; }
    return;
  }
  if (!strcmp(type, "audio_start")) {
    clearPlayback(); remotePlayback = true; serverBusy = true;
    strlcpy(playbackId, doc["id"] | "", sizeof(playbackId));
    playbackAckPending = playbackId[0] != '\0';
    lastAudioPacket = millis();
    uiState = !strcmp(doc["mode"] | "", "music") ? 4 : 3;
    return;
  }
  if (!strcmp(type, "audio_end")) {
    if (!strcmp(doc["id"] | "", playbackId)) remotePlayback = false;
    return;
  }
  if (!strcmp(type, "notice")) {
    Serial.printf("Server notice: %s\n", doc["code"] | "");
    uiState = 5;
    return;
  }
  if (!strcmp(type, "audio_stop")) {
    clearPlayback();
    return;
  }
  if (!strcmp(type, "transcript")) {
    const char *t = doc["text"] | "";
    Serial.printf("User: %s\n", t);
    strlcpy(lastTranscript, t, sizeof(lastTranscript));
    return;
  }
  if (!strcmp(type, "chat")) {
    const char *r = doc["reply"] | "";
    Serial.printf("Assistant: %s\n", r);
    strlcpy(lastReply, r, sizeof(lastReply));
    return;
  }
  if (strcmp(type, "command") || strcmp(doc["device"] | "", "led")) {
    sendError("unsupported_message");
    return;
  }
  const char *action = doc["action"] | "";
  if (!strcmp(action, "on")) ledEnabled = true;
  else if (!strcmp(action, "off")) ledEnabled = false;
  else if (!strcmp(action, "color") && doc["r"].is<int>() &&
           doc["g"].is<int>() && doc["b"].is<int>()) {
    int r = doc["r"], g = doc["g"], b = doc["b"];
    if (r < 0 || r > 255 || g < 0 || g > 255 || b < 0 || b > 255) {
      sendError("RGB_out_of_range");
      return;
    }
    ledColor = (uint32_t(r) << 16) | (uint32_t(g) << 8) | uint32_t(b);
    ledEnabled = true;
  } else {
    sendError("unsupported_LED_action");
    return;
  }
  const char *cmdReply = doc["reply"] | "";
  if (cmdReply && strlen(cmdReply) > 0) {
    strlcpy(lastReply, cmdReply, sizeof(lastReply));
  }
  StaticJsonDocument<256> ack;
  ack["type"] = "ack";
  ack["id"] = doc["id"] | "";
  ack["device"] = "led";
  ack["action"] = action;
  ack["enabled"] = ledEnabled.load();
  String output;
  serializeJson(ack, output);
  socketClient.sendTXT(output);
  Serial.printf("Command: %s | %s\n", action, cmdReply);
}

void onSocketEvent(WStype_t type, uint8_t *payload, size_t length) {
  if (type == WStype_TEXT || type == WStype_BIN) lastServerMessage = millis();
  switch (type) {
    case WStype_CONNECTED: {
      connected = true;
      wsConnectedAt = millis();
      serverBusy = true;
      lastServerMessage = millis();
      uiState = 2;
      clearPlayback();
      Serial.println("WebSocket connected");
      String hello = "{\"type\":\"hello\",\"device_id\":\"" + WiFi.macAddress() +
          "\",\"audio\":{\"format\":\"pcm_s16le\",\"sample_rate\":16000,\"channels\":1},"
          "\"max_audio_chunk_bytes\":4096,\"mic_codec\":\"ima_adpcm\",\"led_enabled\":";
      hello += ledEnabled.load() ? "true" : "false";
      hello += "}";
      socketClient.sendTXT(hello);
      break;
    }
    case WStype_DISCONNECTED:
      connected = false;
      serverBusy = false;
      uiState = 0;
      clearPlayback();
      // Diagnostics: how long the link lasted and whether memory (TLS needs ~40 KB in one
      // block) is getting short.
      Serial.printf("WebSocket disconnected (up %lu s, heap %u, largest block %u)\n",
                    static_cast<unsigned long>((millis() - wsConnectedAt) / 1000),
                    ESP.getFreeHeap(), ESP.getMaxAllocHeap());
      break;
    case WStype_ERROR:
      Serial.printf("WebSocket error: %.*s (heap %u, largest block %u)\n", static_cast<int>(length),
                    payload ? reinterpret_cast<const char *>(payload) : "", ESP.getFreeHeap(), ESP.getMaxAllocHeap());
      break;
    case WStype_TEXT: receiveJson(payload, length); break;
    case WStype_BIN: receiveAudio(payload, length); break;
    case WStype_FRAGMENT_TEXT_START:
    case WStype_FRAGMENT_BIN_START:
      sendError("use_unfragmented_WebSocket_messages");
      break;
    default: break;
  }
}

void pumpSpeaker() {
  if (audioCount) {
    int16_t stereo[256];
    const size_t count = min(audioCount, size_t(128));
    for (size_t i = 0; i < count; ++i) {
      stereo[2 * i] = stereo[2 * i + 1] = audio[(audioRead + i) % AUDIO_CAPACITY];
    }
    size_t written = 0;
    i2s_write(I2S_NUM_1, stereo, count * 4, &written, 0);
    const size_t consumed = written / 4;
    audioRead = (audioRead + consumed) % AUDIO_CAPACITY;
    audioCount -= consumed;
    if (consumed) {
      lastPlayback = millis();
      playbackSeen = true;
    }
  }
  // Allow DMA to finish (32 ms) and short gaps between incoming frames.
  speaking = remotePlayback || audioCount > 0 || (playbackSeen && millis() - lastPlayback < 200);
  if (remotePlayback && millis() - lastAudioPacket > 2000) {
    clearPlayback(); serverBusy = false; uiState = 1;
    sendError("playback_stalled");
    Serial.println("Playback watchdog: microphone released");
  }
  if (playbackAckPending && !speaking && !remotePlayback && !audioCount) {
    playbackAckPending = false;
    String done = String("{\"type\":\"playback_done\",\"id\":\"") + playbackId + "\"}";
    socketClient.sendTXT(done);
    Serial.println("Playback complete");
  }
}

void sendSensor() {
  float t, h;
  bool valid;
  portENTER_CRITICAL(&sensorMux);
  t = temperature; h = humidity; valid = sensorValid;
  portEXIT_CRITICAL(&sensorMux);
  StaticJsonDocument<256> doc;
  doc["type"] = "sensor";
  doc["valid"] = valid;
  if (valid) {
    doc["temperature"] = t;
    doc["humidity"] = h;
  } else {
    doc["temperature"] = nullptr;
    doc["humidity"] = nullptr;
  }
  doc["uptime_ms"] = millis();
  doc["mic_slot"] = micSlot; // diagnostics: which I2S slot carries the microphone
  JsonArray scores = doc.createNestedArray("mic_scores");
  scores.add(static_cast<long>(micScore[0]));
  scores.add(static_cast<long>(micScore[1]));
  doc["loop_max_ms"] = loopMaxMs;
  doc["loop_slow"] = loopSlowPart;
  doc["rssi"] = WiFi.RSSI();
  doc["mic_peak_rms"] = static_cast<long>(micPeakRms);
  doc["mic_gate_opens"] = micOpenCount;
  doc["mic_drops"] = micDropCount;
  loopMaxMs = 0; loopSlowPart = ""; micPeakRms = 0; micOpenCount = 0; micDropCount = 0;
  String output;
  serializeJson(doc, output);
  socketClient.sendTXT(output);
}

// Converts interleaved 32-bit stereo I2S frames to mono PCM16 from the slot that
// carries the microphone. Each slot is scored by AC power x lag-1 correlation:
// real audio is smooth (correlation ~0.9), while an empty slot is flat or holds
// uncorrelated bit noise, so its score stays near zero. Scores are smoothed over
// ~1 s and the slot only switches when the other one is clearly stronger.
size_t readMic(const int32_t *frames, size_t count, int16_t *out) {
  if (!count) return 0;
  for (int slot = 0; slot < 2; ++slot) {
    float mean = 0;
    for (size_t i = 0; i < count; ++i) mean += static_cast<float>(frames[2 * i + slot] >> MIC_SHIFT);
    mean /= count;
    float power = 0, lag = 0, previous = 0;
    for (size_t i = 0; i < count; ++i) {
      const float value = static_cast<float>(frames[2 * i + slot] >> MIC_SHIFT) - mean;
      power += value * value;
      if (i) lag += value * previous;
      previous = value;
    }
    const float correlation = power > 0 ? lag / power : 0;
    const float score = (power / count) * (correlation > 0 ? correlation : 0);
    micScore[slot] = micScore[slot] * 0.98f + score * 0.02f;
  }
  const int other = 1 - micSlot;
  if (micScore[other] > micScore[micSlot] * 4 + 1) {
    micSlot = other;
    Serial.printf("Microphone slot -> %d (scores %.0f / %.0f)\n", micSlot, micScore[0], micScore[1]);
  }
  for (size_t i = 0; i < count; ++i) {
    const int32_t value = frames[2 * i + micSlot] >> MIC_SHIFT;
    out[i] = static_cast<int16_t>(constrain(value, -32768, 32767));
  }
  return count;
}

// IMA ADPCM, 4 bits per sample: the microphone uplink drops from 32 KB/s to ~8 KB/s, which the
// laptop hotspot carries without filling the socket. Every frame stands alone (header holds the
// first sample and the step index), so a dropped frame only loses 16 ms of audio.
// Frame: uint16 sampleCount, int16 firstSample, uint8 stepIndex, uint8 0, then 4-bit codes for
// samples 1..n-1, low nibble first.
const int16_t ADPCM_STEP[89] = {7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
  50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371,
  408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
  2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493,
  10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767};
const int8_t ADPCM_INDEX[16] = {-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8};
int adpcmIndex = 0; // carried across frames for quality; each header repeats it

size_t encodeAdpcm(const int16_t *pcm, size_t count, uint8_t *out) {
  int predictor = pcm[0], index = adpcmIndex;
  out[0] = count & 0xFF; out[1] = count >> 8;
  out[2] = predictor & 0xFF; out[3] = (predictor >> 8) & 0xFF;
  out[4] = static_cast<uint8_t>(index); out[5] = 0;
  size_t pos = 6;
  for (size_t i = 1; i < count; ++i) {
    int step = ADPCM_STEP[index], diff = pcm[i] - predictor, code = 0;
    if (diff < 0) { code = 8; diff = -diff; }
    int delta = step >> 3;
    if (diff >= step) { code |= 4; diff -= step; delta += step; }
    if (diff >= (step >> 1)) { code |= 2; diff -= step >> 1; delta += step >> 1; }
    if (diff >= (step >> 2)) { code |= 1; delta += step >> 2; }
    predictor += (code & 8) ? -delta : delta;
    predictor = constrain(predictor, -32768, 32767);
    index = constrain(index + ADPCM_INDEX[code], 0, 88);
    if (i & 1) out[pos] = code; else out[pos++] |= code << 4;
  }
  if (count > 1 && ((count - 1) & 1)) ++pos;
  adpcmIndex = index;
  return pos;
}

// Sends microphone samples (at most 1024 per frame) or drops them when the socket is full.
void sendMic(const int16_t *pcm, size_t count) {
  static uint8_t frame[6 + 1024 / 2 + 1];
  while (count) {
    const size_t n = min(count, size_t(1024));
    if (socketClient.canWriteNow()) socketClient.sendBIN(frame, encodeAdpcm(pcm, n, frame));
    else ++micDropCount;
    pcm += n; count -= n;
  }
}

// Voice gate. Streaming the microphone non-stop (32 KB/s) kept the small lwIP send buffer
// full: a blocked socket write then froze this whole loop for up to 10 s (WiFiClient retries
// 10 x 1 s), so LED ACKs, sensor reports and heartbeats were late and commands timed out.
// Audio is now sent only around speech: a short pre-roll (the first syllable), the speech,
// and a hangover of silence longer than the backend's VAD_SILENCE_MS so it can close the turn.
// The gate opens at 3x the room's noise floor (learnt while quiet), kept within 120..220:
// quiet room ~45 with bursts of 130-290, speech ~1000 at 30 cm and ~200-300 at 1 m.
constexpr float MIC_GATE_MIN = 120, MIC_GATE_MAX = 220;
float micNoiseFloor = 45;
constexpr size_t PREROLL_SAMPLES = SAMPLE_RATE * 3 / 10;
constexpr uint32_t GATE_HANGOVER_MS = 2000;
int16_t preroll[PREROLL_SAMPLES];
size_t prerollHead = 0, prerollCount = 0;
bool gateOpen = false;
uint32_t gateCloseAt = 0;

// Level of the voice band only: a first-order 120 Hz high-pass (as the backend applies before
// its VAD) removes DC drift and rumble that otherwise kept the gate open in a quiet room.
float chunkRms(const int16_t *pcm, size_t count) {
  static float previousIn = 0, previousOut = 0;
  constexpr float a = 0.955f; // RC / (RC + dt) for 120 Hz at 16 kHz
  float power = 0;
  for (size_t i = 0; i < count; ++i) {
    const float out = a * (previousOut + pcm[i] - previousIn);
    previousIn = pcm[i]; previousOut = out;
    power += out * out;
  }
  return sqrtf(power / count);
}

void rememberPreroll(const int16_t *pcm, size_t count) {
  for (size_t i = 0; i < count; ++i) {
    preroll[prerollHead] = pcm[i];
    prerollHead = (prerollHead + 1) % PREROLL_SAMPLES;
  }
  prerollCount = min(PREROLL_SAMPLES, prerollCount + count);
}

void flushPreroll() {
  static int16_t chunk[1024]; // 2 KB frames; the backend accepts up to 4 KB
  size_t index = (prerollHead + PREROLL_SAMPLES - prerollCount) % PREROLL_SAMPLES;
  while (prerollCount) {
    const size_t n = min(prerollCount, sizeof(chunk) / sizeof(chunk[0]));
    for (size_t i = 0; i < n; ++i) { chunk[i] = preroll[index]; index = (index + 1) % PREROLL_SAMPLES; }
    sendMic(chunk, n);
    prerollCount -= n;
  }
}

void resetVoiceGate() { gateOpen = false; prerollCount = 0; micCapturing = false; }

// Root certificates for the public backend (wss://WS_PUBLIC_HOST): ISRG Root X1 (Let's Encrypt,
// the current issuer), GTS Root R1 and GlobalSign Root CA (Google Trust Services, the other CA
// Cloudflare uses). The server certificate is verified, never accepted blindly.
const char PUBLIC_ROOT_CA[] = R"PEM(
-----BEGIN CERTIFICATE-----
MIIFazCCA1OgAwIBAgIRAIIQz7DSQONZRGPgu2OCiwAwDQYJKoZIhvcNAQELBQAwTzELMAkGA1UE
BhMCVVMxKTAnBgNVBAoTIEludGVybmV0IFNlY3VyaXR5IFJlc2VhcmNoIEdyb3VwMRUwEwYDVQQD
EwxJU1JHIFJvb3QgWDEwHhcNMTUwNjA0MTEwNDM4WhcNMzUwNjA0MTEwNDM4WjBPMQswCQYDVQQG
EwJVUzEpMCcGA1UEChMgSW50ZXJuZXQgU2VjdXJpdHkgUmVzZWFyY2ggR3JvdXAxFTATBgNVBAMT
DElTUkcgUm9vdCBYMTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAK3oJHP0FDfzm54r
Vygch77ct984kIxuPOZXoHj3dcKi/vVqbvYATyjb3miGbESTtrFj/RQSa78f0uoxmyF+0TM8ukj1
3Xnfs7j/EvEhmkvBioZxaUpmZmyPfjxwv60pIgbz5MDmgK7iS4+3mX6UA5/TR5d8mUgjU+g4rk8K
b4Mu0UlXjIB0ttov0DiNewNwIRt18jA8+o+u3dpjq+sWT8KOEUt+zwvo/7V3LvSye0rgTBIlDHCN
Aymg4VMk7BPZ7hm/ELNKjD+Jo2FR3qyHB5T0Y3HsLuJvW5iB4YlcNHlsdu87kGJ55tukmi8mxdAQ
4Q7e2RCOFvu396j3x+UCB5iPNgiV5+I3lg02dZ77DnKxHZu8A/lJBdiB3QW0KtZB6awBdpUKD9jf
1b0SHzUvKBds0pjBqAlkd25HN7rOrFleaJ1/ctaJxQZBKT5ZPt0m9STJEadao0xAH0ahmbWnOlFu
hjuefXKnEgV4We0+UXgVCwOPjdAvBbI+e0ocS3MFEvzG6uBQE3xDk3SzynTnjh8BCNAw1FtxNrQH
usEwMFxIt4I7mKZ9YIqioymCzLq9gwQbooMDQaHWBfEbwrbwqHyGO0aoSCqI3Haadr8faqU9GY/r
OPNk3sgrDQoo//fb4hVC1CLQJ13hef4Y53CIrU7m2Ys6xt0nUW7/vGT1M0NPAgMBAAGjQjBAMA4G
A1UdDwEB/wQEAwIBBjAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQWBBR5tFnme7bl5AFzgAiIyBpY
9umbbjANBgkqhkiG9w0BAQsFAAOCAgEAVR9YqbyyqFDQDLHYGmkgJykIrGF1XIpu+ILlaS/V9lZL
ubhzEFnTIZd+50xx+7LSYK05qAvqFyFWhfFQDlnrzuBZ6brJFe+GnY+EgPbk6ZGQ3BebYhtF8GaV
0nxvwuo77x/Py9auJ/GpsMiu/X1+mvoiBOv/2X/qkSsisRcOj/KKNFtY2PwByVS5uCbMiogziUwt
hDyC3+6WVwW6LLv3xLfHTjuCvjHIInNzktHCgKQ5ORAzI4JMPJ+GslWYHb4phowim57iaztXOoJw
TdwJx4nLCgdNbOhdjsnvzqvHu7UrTkXWStAmzOVyyghqpZXjFaH3pO3JLF+l+/+sKAIuvtd7u+Nx
e5AW0wdeRlN8NwdCjNPElpzVmbUq4JUagEiuTDkHzsxHpFKVK7q4+63SM1N95R1NbdWhscdCb+ZA
JzVcoyi3B43njTOQ5yOf+1CceWxG1bQVs5ZufpsMljq4Ui0/1lvh+wjChP4kqKOJ2qxq4RgqsahD
YVvTH9w7jXbyLeiNdd8XM2w9U/t7y0Ff/9yi0GE44Za4rF2LN9d11TPAmRGunUHBcnWEvgJBQl9n
JEiU0Zsnvgc/ubhPgXRR4Xq37Z0j4r7g1SgEEzwxA57demyPxgcYxn/eR44/KJ4EBs+lVDR3veyJ
m+kXQ99b21/+jh5Xos1AnX5iItreGCc=
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIIFVzCCAz+gAwIBAgINAgPlk28xsBNJiGuiFzANBgkqhkiG9w0BAQwFADBHMQswCQYDVQQGEwJV
UzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2VzIExMQzEUMBIGA1UEAxMLR1RTIFJvb3Qg
UjEwHhcNMTYwNjIyMDAwMDAwWhcNMzYwNjIyMDAwMDAwWjBHMQswCQYDVQQGEwJVUzEiMCAGA1UE
ChMZR29vZ2xlIFRydXN0IFNlcnZpY2VzIExMQzEUMBIGA1UEAxMLR1RTIFJvb3QgUjEwggIiMA0G
CSqGSIb3DQEBAQUAA4ICDwAwggIKAoICAQC2EQKLHuOhd5s73L+UPreVp0A8of2C+X0yBoJx9vaM
f/vo27xqLpeXo4xL+Sv2sfnOhB2x+cWX3u+58qPpvBKJXqeqUqv4IyfLpLGcY9vXmX7wCl7raKb0
xlpHDU0QM+NOsROjyBhsS+z8CZDfnWQpJSMHobTSPS5g4M/SCYe7zUjwTcLCeoiKu7rPWRnWr4+w
B7CeMfGCwcDfLqZtbBkOtdh+JhpFAz2weaSUKK0PfyblqAj+lug8aJRT7oM6iCsVlgmy4HqMLnXW
nOunVmSPlk9orj2XwoSPwLxAwAtcvfaHszVsrBhQf4TgTM2S0yDpM7xSma8ytSmzJSq0SPly4cpk
9+aCEI3oncKKiPo4Zor8Y/kB+Xj9e1x3+naH+uzfsQ55lVe0vSbv1gHR6xYKu44LtcXFilWr06zq
kUspzBmkMiVOKvFlRNACzqrOSbTqn3yDsEB750Orp2yjj32JgfpMpf/VjsPOS+C12LOORc92wO1A
K/1TD7Cn1TsNsYqiA94xrcx36m97PtbfkSIS5r762DL8EGMUUXLeXdYWk70paDPvOmbsB4om3xPX
V2V4J95eSRQAogB/mqghtqmxlbCluQ0WEdrHbEg8QOB+DVrNVjzRlwW5y0vtOUucxD/SVRNuJLDW
cfr0wbrM7Rv1/oFB2ACYPTrIrnqYNxgFlQIDAQABo0IwQDAOBgNVHQ8BAf8EBAMCAYYwDwYDVR0T
AQH/BAUwAwEB/zAdBgNVHQ4EFgQU5K8rJnEaK0gnhS9SZizv8IkTcT4wDQYJKoZIhvcNAQEMBQAD
ggIBAJ+qQibbC5u+/x6Wki4+omVKapi6Ist9wTrYggoGxval3sBOh2Z5ofmmWJyq+bXmYOfg6LEe
QkEzCzc9zolwFcq1JKjPa7XSQCGYzyI0zzvFIoTgxQ6KfF2I5DUkzps+GlQebtuyh6f88/qBVRRi
ClmpIgUxPoLW7ttXNLwzldMXG+gnoot7TiYaelpkttGsN/H9oPM47HLwEXWdyzRSjeZ2axfG34ar
J45JK3VmgRAhpuo+9K4l/3wV3s6MJT/KYnAK9y8JZgfIPxz88NtFMN9iiMG1D53Dn0reWVlHxYci
NuaCp+0KueIHoI17eko8cdLiA6EfMgfdG+RCzgwARWGAtQsgWSl4vflVy2PFPEz0tv/bal8xa5me
LMFrUKTX5hgUvYU/Z6tGn6D/Qqc6f1zLXbBwHSs09dR2CQzreExZBfMzQsNhFRAbd03OIozUhfJF
fbdT6u9AWpQKXCBfTkBdYiJ23//OYb2MI3jSNwLgjt7RETeJ9r/tSQdirpLsQBqvFAnZ0E6yove+
7u7Y/9waLd64NnHi/Hm3lCXRSHNboTXns5lndcEZOitHTtNCjv0xyBZm2tIMPNuzjsmhDYAPexZ3
FL//2wmUspO8IFgV6dtxQ/PeEMMA3KgqlbbC1j+Qa3bbbP6MvPJwNQzcmRk13NfIRmPVNnGuV/u3
gm3c
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIIDdTCCAl2gAwIBAgILBAAAAAABFUtaw5QwDQYJKoZIhvcNAQEFBQAwVzELMAkGA1UEBhMCQkUx
GTAXBgNVBAoTEEdsb2JhbFNpZ24gbnYtc2ExEDAOBgNVBAsTB1Jvb3QgQ0ExGzAZBgNVBAMTEkds
b2JhbFNpZ24gUm9vdCBDQTAeFw05ODA5MDExMjAwMDBaFw0yODAxMjgxMjAwMDBaMFcxCzAJBgNV
BAYTAkJFMRkwFwYDVQQKExBHbG9iYWxTaWduIG52LXNhMRAwDgYDVQQLEwdSb290IENBMRswGQYD
VQQDExJHbG9iYWxTaWduIFJvb3QgQ0EwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDa
DuaZjc6j40+Kfvvxi4Mla+pIH/EqsLmVEQS98GPR4mdmzxzdzxtIK+6NiY6arymAZavpxy0Sy6sc
THAHoT0KMM0VjU/43dSMUBUc71DuxC73/OlS8pF94G3VNTCOXkNz8kHp1Wrjsok6Vjk4bwY8iGlb
Kk3Fp1S4bInMm/k8yuX9ifUSPJJ4ltbcdG6TRGHRjcdGsnUOhugZitVtbNV4FpWi6cgKOOvyJBNP
c1STE4U6G7weNLWLBYy5d4ux2x8gkasJU26Qzns3dLlwR5EiUWMWea6xrkEmCMgZK9FGqkjWZCrX
gzT/LCrBbBlDSgeF59N89iFo7+ryUp9/k5DPAgMBAAGjQjBAMA4GA1UdDwEB/wQEAwIBBjAPBgNV
HRMBAf8EBTADAQH/MB0GA1UdDgQWBBRge2YaRQ2XyolQL30EzTSo//z9SzANBgkqhkiG9w0BAQUF
AAOCAQEA1nPnfE920I2/7LqivjTFKDK1fPxsnCwrvQmeU79rXqoRSLblCKOzyj1hTdNGCbM+w6Dj
Y1Ub8rrvrTnhQ7k4o+YviiY776BQVvnGCv04zcQLcFGUl5gE38NflNUVyRRBnMRddWQVDf9VMOyG
j/8N7yy5Y0b2qvzfvGn9LhJIZJrglfCm7ymPAbEVtQwdpf5pLGkkeB6zpxxxYu7KyJesF12KwvhH
hm4qxFYxldBniYUr+WymXUadDKqC5JlR3XC321Y9YeRq4VzW9v493kHMB65jUr9TU/Qr6cf9tveC
X4XSQRjbgbMEHMUfpIBvFSDJ3gyICh3WZlXi/EjJKSZp4A==
-----END CERTIFICATE-----
)PEM";

// Backend link. LAN: ws://<laptop>:<port>/aiot on the laptop hotspot (lowest latency).
// PUBLIC: wss://WS_PUBLIC_HOST/aiot through the tunnel, so any Wi-Fi with Internet works
// (no laptop IP, firewall or client-isolation problems). The other one is tried when the
// current one has not connected for LINK_FAILOVER_MS.
enum class BackendLink { Lan, Public };
BackendLink backendLink = BackendLink::Lan;
uint32_t linkStartedAt = 0;
constexpr uint32_t LINK_FAILOVER_MS = 40000;
bool onLaptopHotspot = false; // Wi-Fi address in 192.168.137.x (Windows Mobile Hotspot)

bool hasPublicBackend() { return WS_PUBLIC_HOST[0] != '\0'; }

void startBackendLink(BackendLink link) {
  socketClient.disconnect();
  backendLink = link;
  linkStartedAt = millis();
  if (link == BackendLink::Public) {
    Serial.printf("Backend link: wss://%s:%u%s\n", WS_PUBLIC_HOST, WS_PUBLIC_PORT, WS_PATH);
    socketClient.beginSslWithCA(WS_PUBLIC_HOST, WS_PUBLIC_PORT, WS_PATH, PUBLIC_ROOT_CA);
  } else {
    Serial.printf("Backend link: ws://%s:%u%s\n", curHost, curPort, WS_PATH);
    socketClient.begin(curHost, curPort, WS_PATH);
  }
}

void networkTask(void *) {
  loadConfig();
  WiFi.mode(WIFI_STA);

  WiFi.setSleep(false);
  WiFi.setAutoReconnect(true);
  WiFi.onEvent([](WiFiEvent_t, WiFiEventInfo_t info) {
    lastWifiReason = info.wifi_sta_disconnected.reason;
    Serial.printf("Wi-Fi refused \"%s\": reason %u\n",
                  reinterpret_cast<const char *>(info.wifi_sta_disconnected.ssid), lastWifiReason);
  }, ARDUINO_EVENT_WIFI_STA_DISCONNECTED);
  WiFi.onEvent([](WiFiEvent_t, WiFiEventInfo_t) { lastWifiReason = 0; }, ARDUINO_EVENT_WIFI_STA_GOT_IP);
  loadKnownNetworks();
  connectBestNetwork();
  // Full 20 dBm transmit power on these ESP32-S3 boards, a metre from the hotspot, produced
  // distorted uplink frames and retransmissions (ping up to 130 ms at -21 dBm RSSI, socket
  // writes blocked for seconds). 11 dBm is plenty for a room and gives a clean uplink.
  WiFi.setTxPower(WIFI_POWER_11dBm);

  // The link (LAN or public) is chosen once Wi-Fi is up; see startBackendLink().
  const String authHeader = String("Authorization: Bearer ") + curToken;
  socketClient.setExtraHeaders(authHeader.c_str()); // Library appends CRLF itself.
  socketClient.onEvent(onSocketEvent);
  socketClient.setReconnectInterval(3000);
  // Ping every 15 s; drop the link only after 3 pongs missed by 10 s each. Through the public
  // tunnel a pong sometimes takes a few seconds, and 2 misses of 3 s dropped a healthy link.
  socketClient.enableHeartbeat(15000, 10000, 3);

  uint32_t lastWifiAttempt = millis(), lastSensor = 0;
  // Open the setup hotspot after this long without a backend connection (time for both links).
  constexpr uint32_t PORTAL_AFTER_MS = 60000;
  uint32_t lastBackendSeen = millis();
  bool hadWifi = false;
  bool buttonWasDown = false;
  uint32_t buttonDownAt = 0;
  static int32_t raw[MIC_SAMPLES * 2]; // interleaved stereo frames
  static int16_t pcm[MIC_SAMPLES];

  uint32_t mark = millis();
  // Records how long the part just finished took; keeps the slowest one per report.
  auto lap = [&](const char *part) {
    const uint32_t now = millis(), spent = now - mark;
    mark = now;
    if (spent > loopMaxMs) { loopMaxMs = spent; loopSlowPart = part; }
  };
  for (;;) {
    mark = millis();
    // 1. Luon luon phuc vu Web Dashboard tren dien thoai
    if (connected) {
      lastBackendSeen = millis();
      stopPortal();
    } else if (millis() - lastBackendSeen > PORTAL_AFTER_MS) {
      startPortal();
    }
    if (portalOn) {
      dnsServer->processNextRequest();
      configServer->handleClient();
    }
    lap("portal");

    // 2. Kiem tra trang thai Wi-Fi & WebSocket
    const bool wifiReady = (WiFi.status() == WL_CONNECTED);
    if (wifiReady) {
      if (!hadWifi) {
        Serial.printf("WiFi IP: %s | Gateway: %s | Host: %s\n",
          WiFi.localIP().toString().c_str(), WiFi.gatewayIP().toString().c_str(), curHost);
        onLaptopHotspot = WiFi.localIP()[0] == 192 && WiFi.localIP()[1] == 168 && WiFi.localIP()[2] == 137;
        if (onLaptopHotspot && strcmp(curHost, "192.168.137.1") != 0) {
          Serial.println("Hotspot 192.168.137.x detected -> Setting Host to 192.168.137.1");
          strlcpy(curHost, "192.168.137.1", sizeof(curHost));
        }
        // Laptop hotspot: talk to the laptop directly. Any other Wi-Fi: use the public address.
#ifdef AIOT_FORCE_PUBLIC_LINK
        // Test builds only (PLATFORMIO_BUILD_FLAGS=-DAIOT_FORCE_PUBLIC_LINK): always use wss.
        startBackendLink(hasPublicBackend() ? BackendLink::Public : BackendLink::Lan);
#else
        startBackendLink(onLaptopHotspot || !hasPublicBackend() ? BackendLink::Lan : BackendLink::Public);
#endif
      } else if (connected) {
        linkStartedAt = millis(); // failover counts from the last moment the link was up
#ifdef AIOT_FORCE_PUBLIC_LINK
      } else if (hasPublicBackend() && millis() - linkStartedAt > LINK_FAILOVER_MS) {
#else
      // On the laptop hotspot both links end at the same laptop, and the public one goes through
      // the hotspot NAT (seen dropping every few minutes): stay on LAN there. Failover is for
      // other Wi-Fi networks.
      } else if (hasPublicBackend() && !onLaptopHotspot && millis() - linkStartedAt > LINK_FAILOVER_MS) {
#endif
        Serial.println("Backend not reachable on this link -> trying the other one");
        startBackendLink(backendLink == BackendLink::Lan ? BackendLink::Public : BackendLink::Lan);
      }
      lap("wifi");
      socketClient.loop();
      lap("ws_loop");
    } else {
      if (hadWifi) {
        socketClient.disconnect();
        connected = false;
        clearPlayback();
      }
      if (millis() - lastWifiAttempt >= 15000) {
        lastWifiAttempt = millis();
        connectBestNetwork(); // the strongest saved network in range, e.g. after moving the device
      }
    }
    hadWifi = wifiReady;

    // 3. Kiem tra nut BOOT
    const bool down = digitalRead(INTERRUPT_BUTTON) == LOW;
    if (down && !buttonWasDown) {
      buttonWasDown = true;
      buttonDownAt = millis();
    } else if (!down && buttonWasDown) {
      const uint32_t pressDuration = millis() - buttonDownAt;
      buttonWasDown = false;
      if (pressDuration < 2500 && connected) {
        clearPlayback();
        socketClient.sendTXT("{\"type\":\"interrupt\"}");
      }
    } else if (down && buttonWasDown && (millis() - buttonDownAt >= 3000)) {
      buttonWasDown = false;
      Serial.println("BOOT held 3s -> Reset config to default & restart");
      saveConfig(WIFI_SSID, WIFI_PASSWORD, WS_HOST, WS_PORT);
      clearSavedToken();
      knownCount = 0;
      storeKnownNetworks();
      delay(500);
      ESP.restart();
    }

    if (connected && serverBusy && millis() - lastServerMessage > 15000) {
      socketClient.disconnect(); // Recover from a stuck server; do not stay muted forever.
    }
    lap("button");
    pumpSpeaker();
    lap("speaker");

    // 4. Thu am micro
    size_t bytesRead = 0;
    const esp_err_t status = i2s_read(I2S_NUM_0, raw, sizeof(raw), &bytesRead, 0);
    if (status == ESP_OK && bytesRead && connected && !serverBusy &&
        !(MUTE_MIC_DURING_PLAYBACK && speaking)) {
      const size_t count = readMic(raw, bytesRead / (2 * sizeof(int32_t)), pcm);
      if (count) {
        const float level = chunkRms(pcm, count);
        if (level > micPeakRms) micPeakRms = level;
        micLevel = static_cast<int>(level);
        if (!gateOpen && level < micNoiseFloor * 2) micNoiseFloor = micNoiseFloor * 0.995f + level * 0.005f;
        if (level >= constrain(micNoiseFloor * 3.0f, MIC_GATE_MIN, MIC_GATE_MAX)) {
          if (!gateOpen) { gateOpen = true; ++micOpenCount; flushPreroll(); }
          gateCloseAt = millis() + GATE_HANGOVER_MS;
        }
        if (gateOpen) {
          sendMic(pcm, count);
          if (static_cast<int32_t>(millis() - gateCloseAt) > 0) gateOpen = false;
          micCapturing = gateOpen;
        } else {
          rememberPreroll(pcm, count);
        }
      }
    } else if (!connected || serverBusy || speaking) {
      resetVoiceGate(); // never replay audio captured before a turn or during playback
    }
    lap("mic_send");

    // 5. Gui sensor DHT22
    if (connected && millis() - lastSensor >= 2000) {
      lastSensor = millis();
      sendSensor();
    }
    lap("sensor");

    vTaskDelay(pdMS_TO_TICKS(2));
  }
}

/**
 * Re-sends the SSD1306 128x64 configuration without switching the panel off. A glitch on the
 * I2C wires (speaker current, loose jumper) can corrupt the multiplex/COM settings, which shows
 * as horizontal stripes until a reboot; refreshing them every few seconds heals it silently.
 */
void refreshOledConfig() {
  static const uint8_t config[] = {
    0xD5, 0x80,   // clock divide
    0xA8, 63,     // multiplex ratio: 64 rows
    0xD3, 0x00,   // display offset
    0x40,         // start line 0
    0x8D, 0x14,   // charge pump on
    0x20, 0x00,   // horizontal addressing
    0xA1, 0xC8,   // segment remap, COM scan direction
    0xDA, 0x12,   // COM pins for 128x64
    0xD9, 0xF1, 0xDB, 0x40,
    0xA4, 0xA6, 0x2E, 0xAF,  // resume RAM, normal, no scroll, display on
  };
  for (uint8_t c : config) display.ssd1306_command(c);
}

/**
 * Status bar (rows 25-37), one clear state at a time, highest priority first:
 *   DANG TRA LOI / PHAT NHAC  - the speaker is playing the answer
 *   DANG XU LY ...            - the backend is recognising / thinking
 *   DANG THU AM               - the microphone is recording you; the bar under it shows your level
 *   NGHE LENH 9s              - say the next command without the name; the bar shrinks to zero
 *   Goi: Tro ly oi            - idle, waiting for the assistant name (outlined, not filled)
 * Filled (white) = the assistant is busy with you; outlined = idle.
 */
void drawStatusBar() {
  const uint32_t now = millis();
  const unsigned state = uiState.load();
  const char *dots[] = {"   ", ".  ", ".. ", "..."};
  const char *dot = dots[(now / 300) % 4];
  char text[24];
  bool active = true;
  int bar = -1; // 0..128 progress under the status, -1 = plain separator line
  const uint32_t followEnd = followUntilMs.load(), followTotal = followTotalMs.load();
  const int32_t followLeft = followEnd ? static_cast<int32_t>(followEnd - now) : 0;
  if (state == 3) snprintf(text, sizeof(text), "DANG TRA LOI%s", dot);
  else if (state == 4) snprintf(text, sizeof(text), "PHAT NHAC%s", dot);
  else if (state == 5) { snprintf(text, sizeof(text), "CO LOI - NOI LAI"); }
  else if (serverBusy || state == 2) snprintf(text, sizeof(text), "DANG XU LY%s", dot);
  else if (micCapturing) {
    snprintf(text, sizeof(text), "DANG THU AM%s", dot);
    bar = constrain(micLevel.load() / 8, 4, 128);
  } else if (followLeft > 0 && followTotal) {
    snprintf(text, sizeof(text), "NGHE LENH %lus", static_cast<unsigned long>((followLeft + 999) / 1000));
    bar = static_cast<int>(128ULL * followLeft / followTotal);
  } else {
    active = false;
    snprintf(text, sizeof(text), wakeRequired ? "Goi: Tro ly oi" : "SAN SANG NGHE");
  }
  if (active) {
    display.fillRoundRect(0, 25, 92, 10, 2, SSD1306_WHITE);
    display.setTextColor(SSD1306_BLACK, SSD1306_WHITE);
  } else {
    display.drawRoundRect(0, 25, 92, 10, 2, SSD1306_WHITE);
    display.setTextColor(SSD1306_WHITE);
  }
  display.setTextSize(1);
  display.setCursor(3, 26);
  display.print(text);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(96, 26);
  display.print(ledEnabled.load() ? "D:BAT" : "D:TAT");
  if (bar >= 0) display.fillRect(0, 35, bar, 1, SSD1306_WHITE);
  else display.drawFastHLine(0, 35, 128, SSD1306_WHITE);
}

void hardwareTask(void *) {
  Wire.begin(SDA_PIN, SCL_PIN);
  const bool hasDisplay = display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDRESS);
  if (!hasDisplay) Serial.println("OLED initialization failed; continuing");
  dht.begin();
  uint32_t lastSensor = millis() - 2000;
  uint32_t lastDisplay = 0, pageStartedAt = 0, generation = 0, lastOledRefresh = millis();
  size_t currentPage = 0;
  for (;;) {
    if (hasDisplay && millis() - lastOledRefresh >= 5000) {
      lastOledRefresh = millis();
      refreshOledConfig();
    }
    if (millis() - lastSensor >= 2000) {
      lastSensor = millis();
      const float h = dht.readHumidity(), t = dht.readTemperature();
      const bool valid = !isnan(t) && !isnan(h);
      portENTER_CRITICAL(&sensorMux);
      temperature = t; humidity = h; sensorValid = valid;
      portEXIT_CRITICAL(&sensorMux);
    }
    const bool isOnline = connected.load();
    if (hasDisplay && millis() - lastDisplay >= (isOnline ? 200 : 80)) {
        lastDisplay = millis();
        float t, h; bool valid;
        portENTER_CRITICAL(&sensorMux);
        t = temperature; h = humidity; valid = sensorValid;
        portEXIT_CRITICAL(&sensorMux);

        if (!isOnline) {
          // ================= PROCESSING / CONNECTING SCREEN =================
          display.clearDisplay();

          // 1. Top Banner
          display.fillRoundRect(0, 0, 128, 13, 2, SSD1306_WHITE);
          display.setTextColor(SSD1306_BLACK, SSD1306_WHITE);
          display.setTextSize(1);
          display.setCursor(14, 3);
          display.print("AIoT SMART ROOM");

          // 2. Wi-Fi & AP Info
          display.setTextColor(SSD1306_WHITE);
          const bool wifiOk = WiFi.status() == WL_CONNECTED;
          const char *dots[] = {".", "..", "...", "    "};
          const char *curDot = dots[(millis() / 300) % 4];

          if (!wifiOk) {
            display.setCursor(0, 16);
            display.printf("Ket noi: %s%s", curSsid[0] ? curSsid : WIFI_SSID, curDot);
            display.setCursor(0, 26);
            display.print("AP: AIoT_Smart_Room");
            display.setCursor(0, 36);
            display.print("Web: 192.168.4.1");
          } else {
            display.setCursor(0, 16);
            display.printf("WiFi: %s", WiFi.SSID().c_str());
            display.setCursor(0, 26);
            display.printf("Tim Server AIoT%s", curDot);
            display.setCursor(0, 36);
            display.printf("Web: %s", WiFi.localIP().toString().c_str());
          }

          // 3. Live Sensor status at bottom
          display.drawFastHLine(0, 48, 128, SSD1306_WHITE);
          display.setCursor(0, 53);
          if (valid) {
            display.printf("%.1fC | %.0f%% | STANDBY", t, h);
          } else {
            display.print("DHT22... | STANDBY");
          }

          display.display();
        } else {
          // ================= NORMAL OPERATING DASHBOARD =================
          uint8_t bitmap[OLED_PAGE_BYTES];
          size_t count;
          portENTER_CRITICAL(&displayMux);
          count = oledPageCount;
          if (generation != oledGeneration) {
            generation = oledGeneration; currentPage = 0; pageStartedAt = millis();
          }
          if (count && millis() - pageStartedAt >= 3500) {
            currentPage = (currentPage + 1) % count; pageStartedAt = millis();
          }
          if (count) memcpy(bitmap, oledPages + currentPage * OLED_PAGE_BYTES, sizeof(bitmap));
          portEXIT_CRITICAL(&displayMux);

          display.clearDisplay();
          display.setTextSize(1);
          display.setTextColor(SSD1306_WHITE);
          display.setCursor(0, 0); display.print("Nhiet do");
          display.setCursor(72, 0); display.print("Do am");
          display.setTextSize(2);
          display.setCursor(0, 9);
          if (valid) display.printf("%.1fC", t);
          else display.print("--.-C");
          display.setCursor(72, 9);
          if (valid) display.printf("%.0f%%", h);
          else display.print("--%");
          drawStatusBar();
          if (count) display.drawBitmap(0, OLED_CONTENT_Y, bitmap, 128, OLED_CONTENT_HEIGHT, SSD1306_WHITE);
          else {
            display.setCursor(0, 42); display.print("Chua co hoi thoai");
            display.setCursor(0, 54); display.print("San sang nhan lenh");
          }
          display.display();
        }
    }
    CRGB color = CRGB::Black;
    if (ledEnabled && !isOnline) {
      // Eye-catching breathing cyan pulse while connecting / standby
      uint8_t breath = (sin(millis() / 300.0) + 1.0) * 100 + 30; // 30..230
      color = CRGB(0, breath, breath); // Neon Cyan
    } else if (ledEnabled) {
      color = CRGB(ledColor.load());
      if (speaking) color.nscale8((millis() / 200) % 2 ? 255 : 30);
    }
    fill_solid(leds, LED_COUNT, color);
    FastLED.show();
    vTaskDelay(pdMS_TO_TICKS(25));
  }
}
} // namespace

void setup() {
  Serial.begin(115200);
  Serial.setTxTimeoutMs(50);
  // Native USB CDC may take a moment to reconnect after reset/upload.
  const uint32_t serialWaitStarted = millis();
  while (!Serial && millis() - serialWaitStarted < 3000) delay(10);
  Serial.printf("\nAIoT boot | flash=%u | PSRAM=%u | reset=%d\n",
                ESP.getFlashChipSize(), ESP.getPsramSize(), static_cast<int>(esp_reset_reason()));
  Serial.println("Init: LED");
  FastLED.addLeds<WS2812B, LED_PIN, GRB>(leds, LED_COUNT);
  FastLED.setBrightness(LED_BRIGHTNESS);
  pinMode(INTERRUPT_BUTTON, INPUT_PULLUP);
  if (!psramFound()) fatal("PSRAM missing: verify ESP32-S3 N16R8 board settings");
  audio = static_cast<int16_t *>(heap_caps_malloc(AUDIO_CAPACITY * sizeof(int16_t),
                                                MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (!audio) fatal("Audio buffer allocation failed");
  oledPages = static_cast<uint8_t *>(heap_caps_malloc(OLED_PAGE_BYTES * OLED_MAX_PAGES,
                                                     MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (!oledPages) fatal("OLED page allocation failed");
  Serial.println("Init: I2S");
  setupAudio();
  Serial.println("Init: tasks");
  // Create hardware task last; before this point only setup owns FastLED.
  if (xTaskCreatePinnedToCore(networkTask, "network_audio", 12288, nullptr, 2, nullptr, 0) != pdPASS)
    fatal("Network task allocation failed");
  if (xTaskCreatePinnedToCore(hardwareTask, "sensors_led_oled", 6144, nullptr, 1, nullptr, 1) != pdPASS)
    fatal("Hardware task allocation failed");
}

void loop() {
  // Periodic output makes USB/COM troubleshooting possible even when the
  // one-time boot message is missed while Windows re-enumerates the device.
  static uint32_t lastHeartbeat = 0;
  if (millis() - lastHeartbeat >= 5000) {
    lastHeartbeat = millis();
    Serial.printf("AIoT alive | uptime=%lu s | WiFi=%s | WS=%s | PSRAM=%u | heap=%u\n",
                  static_cast<unsigned long>(millis() / 1000),
                  WiFi.status() == WL_CONNECTED ? "connected" : "disconnected",
                  connected.load() ? "connected" : "disconnected", ESP.getPsramSize(),
                  ESP.getFreeHeap());
  }
  vTaskDelay(pdMS_TO_TICKS(100));
}
