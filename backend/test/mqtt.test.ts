import test from 'node:test';
import assert from 'node:assert/strict';
import * as mqtt from 'mqtt';
import { AiotMqttService } from '../src/aiot/mqtt.service';

test('AiotMqttService starts embedded broker, publishes telemetry, and handles LED/text commands', async t => {
  const testPort = 18838;
  process.env.MQTT_PORT = String(testPort);
  process.env.MQTT_EMBEDDED_BROKER = 'true';

  let ledCalledWith: { deviceId: string; enabled: boolean } | undefined;
  let textCalledWith: { deviceId: string; text: string } | undefined;

  const mockGateway: any = {
    dashboardDevices() {
      return [{
        id: 'test-mac',
        connected: true,
        ledEnabled: false,
        busy: false,
        sensor: { temperature: 29.2, humidity: 64, receivedAt: new Date().toISOString(), stale: false },
      }];
    },
    getFirstOnlineDeviceId() {
      return 'test-mac';
    },
    async setDashboardLed(deviceId: string, enabled: boolean) {
      ledCalledWith = { deviceId, enabled };
      return { id: deviceId, connected: true, ledEnabled: enabled };
    },
    async submitDashboardText(deviceId: string, text: string) {
      textCalledWith = { deviceId, text };
      return {
        transcript: text,
        reply: 'Em đã thực hiện xong lệnh.',
        language: 'vi',
        intent: 'chat' as const,
      };
    },
  };

  const mqttService = new AiotMqttService();
  mqttService.setGateway(mockGateway);
  await mqttService.onModuleInit();

  t.after(async () => {
    await mqttService.onModuleDestroy();
  });

  // Connect an external test client to the embedded broker
  const client = mqtt.connect(`mqtt://127.0.0.1:${testPort}`);
  await new Promise<void>((resolve, reject) => {
    client.once('connect', () => resolve());
    client.once('error', reject);
  });

  const receivedMessages: Array<{ topic: string; message: string }> = [];
  client.on('message', (topic, payload) => {
    receivedMessages.push({ topic, message: payload.toString('utf8') });
  });

  // Subscribe to sensor, state, chat, response
  await client.subscribeAsync(['aiot/sensor', 'aiot/state', 'aiot/chat', 'aiot/response', 'aiot/led/status']);

  // 1. Test telemetry publish
  mqttService.publishSensor('test-mac', { temperature: 28.5, humidity: 65, receivedAt: Date.now() });
  await new Promise(r => setTimeout(r, 100));

  assert.ok(receivedMessages.some(m => m.topic === 'aiot/sensor' && m.message.includes('28.5')));

  // 2. Test state publish
  mqttService.publishState('test-mac', { connected: true, ledEnabled: true, busy: false });
  await new Promise(r => setTimeout(r, 100));

  assert.ok(receivedMessages.some(m => m.topic === 'aiot/state' && m.message.includes('true')));
  assert.ok(receivedMessages.some(m => m.topic === 'aiot/led/status' && m.message === 'ON'));

  // 3. Test sending command to turn on LED
  client.publish('aiot/command', JSON.stringify({ action: 'led', state: 'on' }));
  await new Promise(r => setTimeout(r, 200));

  assert.deepEqual(ledCalledWith, { deviceId: 'test-mac', enabled: true });
  assert.ok(receivedMessages.some(m => m.topic === 'aiot/response' && m.message.includes('bật')));

  // 4. Test sending plain text 'off' to aiot/led/set
  client.publish('aiot/led/set', 'off');
  await new Promise(r => setTimeout(r, 200));

  assert.deepEqual(ledCalledWith, { deviceId: 'test-mac', enabled: false });

  // 5. Test natural language text command
  client.publish('aiot/command', JSON.stringify({ action: 'text', text: 'Nhiệt độ phòng?' }));
  await new Promise(r => setTimeout(r, 200));

  assert.deepEqual(textCalledWith, { deviceId: 'test-mac', text: 'Nhiệt độ phòng?' });

  await client.endAsync();
});
