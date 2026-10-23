#include <Arduino.h>
#include <esp_system.h>

// Deliberately avoids config.h, PSRAM and external hardware.
void setup() {
  Serial.begin(115200);
  Serial.setTxTimeoutMs(50);
}

void loop() {
  Serial.printf("USB TEST OK | uptime=%lu s | reset=%d | flash=%u\n",
                static_cast<unsigned long>(millis() / 1000),
                static_cast<int>(esp_reset_reason()), ESP.getFlashChipSize());
  delay(1000);
}
