#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

namespace {
constexpr int SDA_PIN = 8;
constexpr int SCL_PIN = 9;
constexpr int SCREEN_WIDTH = 128;
constexpr int SCREEN_HEIGHT = 64;
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1);

uint8_t findDisplayAddress() {
  for (uint8_t address : {uint8_t(0x3C), uint8_t(0x3D)}) {
    Wire.beginTransmission(address);
    if (Wire.endTransmission() == 0) return address;
  }
  return 0;
}

void showSolid(uint16_t color, const char *message) {
  display.clearDisplay();
  if (color == SSD1306_WHITE) display.fillScreen(SSD1306_WHITE);
  display.display();
  Serial.println(message);
}

void showCheckerboard(bool inverse) {
  display.clearDisplay();
  for (int y = 0; y < SCREEN_HEIGHT; y += 4) {
    for (int x = 0; x < SCREEN_WIDTH; x += 4) {
      const bool white = (((x / 4) + (y / 4)) % 2 == 0) != inverse;
      if (white) display.fillRect(x, y, 4, 4, SSD1306_WHITE);
    }
  }
  display.display();
}

void scanRows() {
  Serial.println("Pixel scan: horizontal line moving through all 64 rows.");
  for (int y = 0; y < SCREEN_HEIGHT; ++y) {
    display.clearDisplay();
    display.drawFastHLine(0, y, SCREEN_WIDTH, SSD1306_WHITE);
    display.display();
    delay(120);
  }
}

void scanColumns() {
  Serial.println("Pixel scan: vertical line moving through all 128 columns.");
  for (int x = 0; x < SCREEN_WIDTH; ++x) {
    display.clearDisplay();
    display.drawFastVLine(x, 0, SCREEN_HEIGHT, SSD1306_WHITE);
    display.display();
    delay(120);
  }
}

void showGridAndText() {
  display.clearDisplay();
  display.drawRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT, SSD1306_WHITE);
  for (int x = 8; x < SCREEN_WIDTH; x += 8) display.drawFastVLine(x, 0, SCREEN_HEIGHT, SSD1306_WHITE);
  for (int y = 8; y < SCREEN_HEIGHT; y += 8) display.drawFastHLine(0, y, SCREEN_WIDTH, SSD1306_WHITE);
  display.fillRect(2, 2, 3, 3, SSD1306_WHITE);
  display.fillRect(SCREEN_WIDTH - 5, 2, 3, 3, SSD1306_WHITE);
  display.fillRect(2, SCREEN_HEIGHT - 5, 3, 3, SSD1306_WHITE);
  display.fillRect(SCREEN_WIDTH - 5, SCREEN_HEIGHT - 5, 3, 3, SSD1306_WHITE);
  display.fillRect(25, 23, 78, 18, SSD1306_BLACK);
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);
  display.setCursor(31, 25);
  display.print("OLED TEST OK");
  display.setCursor(31, 36);
  display.print("128 x 64");
  display.display();
  Serial.println("Pixel test finished: grid, corners and text should be complete.");
}
}

void setup() {
  Serial.begin(115200);
  delay(800);
  Serial.println("\nAIoT OLED PANEL TEST");
  Wire.begin(SDA_PIN, SCL_PIN);
  Wire.setClock(100000);
  const uint8_t address = findDisplayAddress();
  if (!address) {
    Serial.println("OLED NOT FOUND at 0x3C or 0x3D. Check 3V3, GND, SDA=GPIO8, SCL=GPIO9.");
    while (true) delay(1000);
  }
  if (!display.begin(SSD1306_SWITCHCAPVCC, address)) {
    Serial.printf("SSD1306 init failed at 0x%02X. Check panel/controller compatibility.\n", address);
    while (true) delay(1000);
  }
  Serial.printf("SSD1306 found at I2C 0x%02X; starting pixel test.\n", address);
}

void loop() {
  showSolid(SSD1306_BLACK, "Solid black: any bright dot may be stuck ON.");
  delay(2000);
  showSolid(SSD1306_WHITE, "Solid white: any dark dot may be dead/stuck OFF.");
  delay(2000);
  showCheckerboard(false);
  Serial.println("Checkerboard A: look for missing or stuck pixels/lines.");
  delay(2000);
  showCheckerboard(true);
  Serial.println("Checkerboard B: inverse pattern.");
  delay(2000);
  scanRows();
  scanColumns();
  showGridAndText();
  delay(4000);
}
