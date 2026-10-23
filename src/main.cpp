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
constexpr int DHT_PIN = 10;
constexpr int SDA_PIN = 8, SCL_PIN = 9, LED_PIN = 11;
constexpr int MIC_WS = 4, MIC_BCLK = 5, MIC_SD = 6;
constexpr int SPK_WS = 15, SPK_BCLK = 16, SPK_DIN = 17;
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
Adafruit_SSD1306 display(128, 64, &Wire, -1);
CRGB leds[LED_COUNT];
WebSocketsClient socketClient;
std::atomic<bool> connected{false}, speaking{false}, ledEnabled{true};
std::atomic<uint32_t> ledColor{0x00FF00};
std::atomic<bool> serverBusy{false};
std::atomic<unsigned> uiState{0}; // offline, listening, thinking, speech, music, error
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

void clearPlayback();

Preferences preferences;
char curSsid[64] = "";
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
  preferences.end();

  strlcpy(curSsid, s.c_str(), sizeof(curSsid));
  strlcpy(curPass, p.c_str(), sizeof(curPass));
  strlcpy(curHost, h.c_str(), sizeof(curHost));
  curPort = (pt > 0 && pt < 65535) ? pt : WS_PORT;
  strlcpy(curToken, tk.c_str(), sizeof(curToken));
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

void handleRoot() {
  if (!configServer) return;
  int n = WiFi.scanNetworks();
  String wifiOptions = "";
  for (int i = 0; i < n && i < 8; ++i) {
    String name = WiFi.SSID(i);
    if (name.length() > 0) {
      wifiOptions += "<div class='wifi-item' onclick=\"pick('" + name + "')\">📶 " + name + "</div>";
    }
  }

  String html = R"rawliteral(<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>AIoT Smart Room - Màn hình Báo cáo</title>
<style>
:root{--bg:#090d16;--card:rgba(22,29,47,0.85);--border:rgba(255,255,255,0.08);--accent:#38bdf8;--text:#f8fafc;--muted:#94a3b8}
*{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
body{background:var(--bg);color:var(--text);padding:14px;display:flex;justify-content:center;min-height:100vh}
.container{width:100%;max-width:440px;display:flex;flex-direction:column;gap:14px}
.header{display:flex;align-items:center;justify-content:space-between;padding:4px 2px}
.header h1{font-size:1.15rem;font-weight:700;color:#38bdf8;display:flex;align-items:center;gap:8px}
.pill{font-size:0.75rem;padding:4px 10px;border-radius:20px;font-weight:600}
.pill-on{background:rgba(16,185,129,0.15);color:#34d399;border:1px solid rgba(16,185,129,0.3)}
.pill-wait{background:rgba(245,158,11,0.15);color:#fbbf24;border:1px solid rgba(245,158,11,0.3)}
.card{background:var(--card);backdrop-filter:blur(12px);border:1px solid var(--border);border-radius:18px;padding:16px;box-shadow:0 8px 24px rgba(0,0,0,0.3)}
.card-title{font-size:0.75rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px;font-weight:600}
.sensor-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.sensor-box{background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:14px;padding:14px 10px;text-align:center}
.sensor-label{font-size:0.78rem;color:var(--muted);margin-bottom:4px}
.sensor-num{font-size:2rem;font-weight:800;letter-spacing:-0.5px}
.sensor-num.temp{color:#fb923c}
.sensor-num.humid{color:#38bdf8}

/* Lamp Illustration */
.lamp-wrap{display:flex;flex-direction:column;align-items:center;padding:10px 0;cursor:pointer;position:relative}
.lamp-glow{position:absolute;width:130px;height:130px;top:10px;border-radius:50%;filter:blur(22px);opacity:0;transition:all 0.4s ease;pointer-events:none}
.lamp-svg{width:80px;height:80px;z-index:2;transition:transform 0.2s}
.lamp-wrap:active .lamp-svg{transform:scale(0.94)}
.lamp-status{font-size:1.05rem;font-weight:700;margin-top:10px;z-index:2;letter-spacing:0.5px}
.lamp-hint{font-size:0.72rem;color:var(--muted);margin-top:4px;z-index:2}

/* System Result Box */
.res-box{display:flex;flex-direction:column;gap:8px;font-size:0.85rem}
.res-item{background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:12px;padding:10px 12px}
.res-title{font-size:0.72rem;color:var(--muted);margin-bottom:2px}
.res-val{color:#f1f5f9;font-weight:500;line-height:1.4}

/* Collapsible Wi-Fi */
details{background:rgba(255,255,255,0.02);border:1px solid var(--border);border-radius:14px;overflow:hidden}
summary{padding:12px 14px;font-size:0.82rem;font-weight:600;cursor:pointer;color:#38bdf8;outline:none}
.wifi-form{padding:0 14px 14px;display:flex;flex-direction:column;gap:10px}
.wifi-list{max-height:90px;overflow-y:auto;border:1px solid #334155;border-radius:8px;background:#1e293b;padding:4px}
.wifi-item{padding:6px 8px;border-radius:6px;cursor:pointer;font-size:12px}
.wifi-item:hover{background:#334155;color:#38bdf8}
.wifi-form input{width:100%;padding:9px 12px;background:#1e293b;border:1px solid #334155;border-radius:8px;color:#fff;font-size:13px}
.btn-save{padding:10px;background:linear-gradient(135deg,#0284c7,#2563eb);color:#fff;border:none;border-radius:10px;font-weight:600;cursor:pointer;font-size:13px}
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>🏠 AIoT Smart Room</h1>
    <div id="connPill" class="pill pill-wait">🟡 Đang kết nối AI...</div>
  </div>

  <!-- CẢM BIẾN MÔI TRƯỜNG -->
  <div class="card">
    <div class="card-title">Cảm biến nhiệt độ & độ ẩm phòng</div>
    <div class="sensor-grid">
      <div class="sensor-box">
        <div class="sensor-label">Nhiệt độ phòng 🌡️</div>
        <div class="sensor-num temp"><span id="temp">--.-</span>°C</div>
      </div>
      <div class="sensor-box">
        <div class="sensor-label">Độ ẩm không khí 💧</div>
        <div class="sensor-num humid"><span id="humid">--</span>%</div>
      </div>
    </div>
  </div>

  <!-- MINH HỌA TRẠNG THÁI ĐÈN -->
  <div class="card">
    <div class="card-title">Minh họa trạng thái đèn thông minh</div>
    <div class="lamp-wrap" onclick="toggleLamp()">
      <div id="lampGlow" class="lamp-glow"></div>
      <svg id="lampSvg" class="lamp-svg" viewBox="0 0 24 24">
        <path id="lampBulb" d="M12 2a7 7 0 0 0-7 7c0 2.38 1.19 4.47 3 5.74V17a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-2.26c1.81-1.27 3-3.36 3-5.74a7 7 0 0 0-7-7z" fill="#334155" stroke="#64748b" stroke-width="1.5"/>
        <path d="M9 10l2 2 2-2" stroke="#94a3b8" stroke-width="1.5" stroke-linecap="round"/>
        <line x1="9" y1="21" x2="15" y2="21" stroke="#64748b" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
      <div id="lampStatus" class="lamp-status">🌑 ĐÈN ĐANG TẮT</div>
      <div class="lamp-hint">Chạm vào bóng đèn để bật / tắt</div>
    </div>
  </div>

  <!-- KẾT QUẢ PHẢN HỒI HỆ THỐNG -->
  <div class="card">
    <div class="card-title">Kết quả phản hồi từ hệ thống</div>
    <div class="res-box">
      <div class="res-item">
        <div class="res-title">🗣️ Khẩu lệnh nhận diện:</div>
        <div id="userText" class="res-val">Chưa có khẩu lệnh</div>
      </div>
      <div class="res-item">
        <div class="res-title">🤖 Trả lời / Xử lý:</div>
        <div id="aiReply" class="res-val">Em chào đại ca! Sẵn sàng phục vụ.</div>
      </div>
    </div>
  </div>

  <!-- CÀI ĐẶT WI-FI (THU GỌN) -->
  <details>
    <summary>⚙️ Cài đặt mạng Wi-Fi khác (Tùy chọn)</summary>
    <form class="wifi-form" method="POST" action="/save">
      <div class="wifi-list">)rawliteral";

  html += wifiOptions;

  html += R"rawliteral(</div>
      <input type="text" id="ssid" name="ssid" placeholder="Tên Wi-Fi (SSID)" value=")rawliteral";
  html += curSsid;
  html += R"rawliteral(" required>
      <input type="text" id="pass" name="pass" placeholder="Mật khẩu Wi-Fi" value=")rawliteral";
  html += curPass;
  html += R"rawliteral(">
      <input type="text" id="host" name="host" placeholder="IP Laptop (Để trống = 192.168.137.1)" value=")rawliteral";
  html += curHost;
  html += R"rawliteral(">
      <button type="submit" class="btn-save">💾 Lưu & Kết nối lại</button>
    </form>
  </details>
</div>

<script>
function pick(n){document.getElementById('ssid').value=n;document.getElementById('pass').focus();}
async function updateStatus(){
  try{
    const r=await fetch('/api/status');
    const d=await r.json();
    document.getElementById('temp').textContent=d.temp;
    document.getElementById('humid').textContent=d.humid;
    
    const bulb=document.getElementById('lampBulb');
    const glow=document.getElementById('lampGlow');
    const txt=document.getElementById('lampStatus');
    if(d.led){
      const c=d.color||'#38bdf8';
      bulb.setAttribute('fill',c);
      bulb.setAttribute('stroke',c);
      glow.style.background='radial-gradient(circle, '+c+'aa 0%, transparent 70%)';
      glow.style.opacity='1';
      txt.textContent='💡 ĐÈN ĐANG BẬT';
      txt.style.color='#4ade80';
    }else{
      bulb.setAttribute('fill','#1e293b');
      bulb.setAttribute('stroke','#475569');
      glow.style.opacity='0';
      txt.textContent='🌑 ĐÈN ĐANG TẮT';
      txt.style.color='#94a3b8';
    }

    if(d.transcript) document.getElementById('userText').textContent=d.transcript;
    if(d.reply) document.getElementById('aiReply').textContent=d.reply;

    const pill=document.getElementById('connPill');
    if(d.connected){
      pill.textContent='🟢 Đã kết nối AI';
      pill.className='pill pill-on';
    }else{
      pill.textContent='🟡 Chờ kết nối máy tính';
      pill.className='pill pill-wait';
    }
  }catch(e){}
}
async function toggleLamp(){
  try{
    await fetch('/api/led?toggle=1',{method:'POST'});
    updateStatus();
  }catch(e){}
}
setInterval(updateStatus,1500);
updateStatus();
</script>
</body>
</html>)rawliteral";

  configServer->send(200, "text/html", html);
}

void handleSave() {
  if (!configServer) return;
  String ssid = configServer->arg("ssid");
  String pass = configServer->arg("pass");
  String host = configServer->arg("host");
  String portStr = configServer->arg("port");
  uint16_t port = portStr.toInt();
  if (port == 0 || port > 65535) port = 3000;
  if (host.length() == 0) host = "192.168.137.1";

  saveConfig(ssid.c_str(), pass.c_str(), host.c_str(), port);

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

void setupWebServer() {
  if (!dnsServer) {
    dnsServer = new DNSServer();
    dnsServer->setErrorReplyCode(DNSReplyCode::NoError);
    dnsServer->start(53, "*", IPAddress(192, 168, 4, 1));
  }
  if (!configServer) {
    configServer = new WebServer(80);
    configServer->on("/", HTTP_GET, handleRoot);
    configServer->on("/api/status", HTTP_GET, handleApiStatus);
    configServer->on("/api/led", HTTP_POST, handleApiLed);
    configServer->on("/save", HTTP_POST, handleSave);
    configServer->on("/hotspot-detect.html", HTTP_GET, handleRoot);
    configServer->on("/generate_204", HTTP_GET, handleRoot);
    configServer->on("/ncsi.txt", HTTP_GET, handleRoot);
    configServer->onNotFound(handleRoot);
    configServer->begin();
    Serial.println("Mobile Dashboard ready @ http://192.168.4.1 (AP: AIoT_Smart_Room)");
  }
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
  mic.channel_format = I2S_CHANNEL_FMT_ONLY_LEFT;
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
      serverBusy = true;
      lastServerMessage = millis();
      uiState = 2;
      clearPlayback();
      Serial.println("WebSocket connected");
      String hello = "{\"type\":\"hello\",\"device_id\":\"" + WiFi.macAddress() +
          "\",\"audio\":{\"format\":\"pcm_s16le\",\"sample_rate\":16000,\"channels\":1},"
          "\"max_audio_chunk_bytes\":4096,\"led_enabled\":";
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
      Serial.println("WebSocket disconnected");
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
  String output;
  serializeJson(doc, output);
  socketClient.sendTXT(output);
}

void networkTask(void *) {
  loadConfig();
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP("AIoT_Smart_Room");
  setupWebServer();

  WiFi.setSleep(false);
  WiFi.setAutoReconnect(true);
  WiFi.begin(curSsid, curPass);

  socketClient.begin(curHost, curPort, WS_PATH);
  const String authHeader = String("Authorization: Bearer ") + curToken;
  socketClient.setExtraHeaders(authHeader.c_str()); // Library appends CRLF itself.
  socketClient.onEvent(onSocketEvent);
  socketClient.setReconnectInterval(3000);
  socketClient.enableHeartbeat(15000, 3000, 2);

  uint32_t lastWifiAttempt = millis(), lastSensor = 0;
  bool hadWifi = false;
  bool buttonWasDown = false;
  uint32_t buttonDownAt = 0;
  int32_t raw[MIC_SAMPLES];
  int16_t pcm[MIC_SAMPLES];

  for (;;) {
    // 1. Luon luon phuc vu Web Dashboard tren dien thoai
    if (dnsServer) dnsServer->processNextRequest();
    if (configServer) configServer->handleClient();

    // 2. Kiem tra trang thai Wi-Fi & WebSocket
    const bool wifiReady = (WiFi.status() == WL_CONNECTED);
    if (wifiReady) {
      if (!hadWifi) {
        Serial.printf("WiFi IP: %s | Gateway: %s | Host: %s\n",
          WiFi.localIP().toString().c_str(), WiFi.gatewayIP().toString().c_str(), curHost);
        if (WiFi.localIP()[0] == 192 && WiFi.localIP()[1] == 168 && WiFi.localIP()[2] == 137) {
          if (strcmp(curHost, "192.168.137.1") != 0) {
            Serial.println("Hotspot 192.168.137.x detected -> Setting Host to 192.168.137.1");
            strlcpy(curHost, "192.168.137.1", sizeof(curHost));
            socketClient.disconnect();
            socketClient.begin(curHost, curPort, WS_PATH);
          }
        }
      }
      socketClient.loop();
    } else {
      if (hadWifi) {
        socketClient.disconnect();
        connected = false;
        clearPlayback();
      }
      if (millis() - lastWifiAttempt >= 8000) {
        lastWifiAttempt = millis();
        Serial.println("Reconnecting WiFi...");
        WiFi.reconnect();
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
      delay(500);
      ESP.restart();
    }

    if (connected && serverBusy && millis() - lastServerMessage > 15000) {
      socketClient.disconnect(); // Recover from a stuck server; do not stay muted forever.
    }
    pumpSpeaker();

    // 4. Thu am micro
    size_t bytesRead = 0;
    const esp_err_t status = i2s_read(I2S_NUM_0, raw, sizeof(raw), &bytesRead, 0);
    if (status == ESP_OK && bytesRead && connected && !serverBusy &&
        !(MUTE_MIC_DURING_PLAYBACK && speaking)) {
      const size_t count = bytesRead / sizeof(int32_t);
      for (size_t i = 0; i < count; ++i) {
        int32_t value = raw[i] >> MIC_SHIFT;
        pcm[i] = static_cast<int16_t>(constrain(value, -32768, 32767));
      }
      socketClient.sendBIN(reinterpret_cast<uint8_t *>(pcm), count * sizeof(int16_t));
    }

    // 5. Gui sensor DHT22
    if (connected && millis() - lastSensor >= 2000) {
      lastSensor = millis();
      sendSensor();
    }

    vTaskDelay(pdMS_TO_TICKS(2));
  }
}

void hardwareTask(void *) {
  Wire.begin(SDA_PIN, SCL_PIN);
  const bool hasDisplay = display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDRESS);
  if (!hasDisplay) Serial.println("OLED initialization failed; continuing");
  dht.begin();
  uint32_t lastSensor = millis() - 2000;
  uint32_t lastDisplay = 0, pageStartedAt = 0, generation = 0;
  size_t currentPage = 0;
  for (;;) {
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

          const char *states[] = {"MAT MANG", "DANG NGHE", "XU LY", "DANG NOI", "PHAT NHAC", "CO LOI"};
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

          display.setTextSize(1);
          display.setCursor(0, 27);
          display.print(states[min(unsigned(uiState.load()), 5u)]);
          display.setCursor(62, 27);
          display.printf("LED:%s", ledEnabled.load() ? "BAT" : "TAT");
          display.setCursor(98, 27);
          display.printf("%u/%u", count ? unsigned(currentPage + 1) : 0, unsigned(count));
          display.drawFastHLine(0, 35, 128, SSD1306_WHITE);
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
