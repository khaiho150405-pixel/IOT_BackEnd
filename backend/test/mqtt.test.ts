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

test('embedded broker requires an account; every account may control every device', async t => {
  process.env.AUTH_DB_FILE = ':memory:';
  delete process.env.DATABASE_URL;
  const testPort = 18839;
  process.env.MQTT_PORT = String(testPort);
  process.env.MQTT_EMBEDDED_BROKER = 'true';
  const { AuthService } = await import('../src/auth/auth.service');
  const auth = new AuthService();
  await auth.ready();
  await auth.setup({ username: 'owner', password: 'owner-pass-123' });
  const owner = (await auth.authenticate((await auth.login('owner', 'owner-pass-123')).accessToken))!;
  await auth.touchDevice('dev-a');
  await auth.touchDevice('dev-b');
  await auth.createUser(owner, { username: 'friend', password: 'friend-pass-1' });

  const leds: Array<{ deviceId: string; enabled: boolean }> = [];
  const gateway: any = {
    dashboardDevices: () => [{ id: 'dev-a', connected: true, ledEnabled: false }, { id: 'dev-b', connected: true, ledEnabled: false }],
    getFirstOnlineDeviceId: () => 'dev-a',
    async setDashboardLed(deviceId: string, enabled: boolean) { leds.push({ deviceId, enabled }); return { id: deviceId, ledEnabled: enabled }; },
    async submitDashboardText() { return { transcript: '', reply: '', language: 'vi', intent: 'chat' }; },
  };
  const service = new AiotMqttService(auth);
  service.setGateway(gateway);
  await service.onModuleInit();
  t.after(async () => { await service.onModuleDestroy(); await auth.onModuleDestroy(); });
  const connect = (username?: string, password?: string) => new Promise<mqtt.MqttClient | Error>(resolve => {
    const c = mqtt.connect('mqtt://127.0.0.1:' + testPort, { username, password, reconnectPeriod: 0, connectTimeout: 3000 });
    c.once('connect', () => resolve(c));
    c.once('error', e => { c.end(true); resolve(e); });
  });
  const pause = (ms = 250) => new Promise(r => setTimeout(r, ms));
  const subscribe = (c: mqtt.MqttClient, topic: string) =>
    c.subscribeAsync(topic).then(() => 'granted', () => 'refused');

  // No account / wrong password: refused (visitors only get the read-only web view).
  assert.ok(await connect() instanceof Error, 'anonymous clients are refused');
  assert.ok(await connect('friend', 'wrong-password') instanceof Error, 'bad password refused');

  // A second account has the same rights as the first one.
  const f = await connect('friend', 'friend-pass-1') as mqtt.MqttClient;
  assert.ok(!(f instanceof Error));
  assert.equal(await subscribe(f, 'aiot/#'), 'granted');
  f.publish('aiot/device/dev-a/led/set', 'on');
  f.publish('aiot/device/dev-b/led/set', 'off');
  await pause();
  assert.deepEqual(leds, [{ deviceId: 'dev-a', enabled: true }, { deviceId: 'dev-b', enabled: false }]);

  // Telemetry topics belong to the backend: a forged sensor reading is dropped, audited,
  // reaches nobody (not even "#") and the client stays connected.
  const o = await connect('owner', 'owner-pass-123') as mqtt.MqttClient;
  const seen: string[] = [];
  o.on('message', topic => seen.push(topic));
  assert.equal(await subscribe(o, '#'), 'granted');
  f.publish('aiot/device/dev-a/sensor', JSON.stringify({ temperature: 99 }));
  f.publish('aiot/device/dev-a/led/set', 'off');
  await pause();
  assert.ok(!seen.includes('aiot/device/dev-a/sensor'), 'forged telemetry not delivered');
  assert.ok(!seen.some(topic => topic.startsWith('$')), 'diverted packets are not delivered');
  assert.deepEqual(leds.at(-1), { deviceId: 'dev-a', enabled: false }, 'still connected after a refusal');

  const audit = await auth.listAudit(owner, 100);
  assert.ok(audit.some(e => e.source === 'mqtt' && e.username === 'friend' && e.result === 'denied'));
  assert.ok(audit.some(e => e.source === 'mqtt' && e.username === 'friend' && e.result === 'ok' && e.deviceId === 'dev-b'));
  await f.endAsync(); await o.endAsync();
});

test('MQTT over WebSocket (/mqtt) and Home Assistant discovery', async t => {
  process.env.AUTH_DB_FILE = ':memory:';
  delete process.env.DATABASE_URL;
  process.env.MQTT_PORT = '18840';
  process.env.MQTT_EMBEDDED_BROKER = 'true';
  const { AuthService } = await import('../src/auth/auth.service');
  const { createServer } = await import('node:http');
  const auth = new AuthService();
  await auth.ready();
  await auth.setup({ username: 'homeassistant', password: 'home-assistant-1' });
  const id = '7C:4F:AD:2B:3D:70';
  const leds: boolean[] = [], texts: string[] = [];
  const gateway: any = {
    dashboardDevices: () => [{ id, connected: true, ledEnabled: false }],
    async setDashboardLed(_d: string, enabled: boolean) { leds.push(enabled); return {}; },
    async submitDashboardText(_d: string, text: string) { texts.push(text); return { transcript: text, reply: 'ok', language: 'vi', intent: 'chat' }; },
  };
  const service = new AiotMqttService(auth);
  service.setGateway(gateway);
  await service.onModuleInit();
  const http = createServer();
  service.attachWebSocket(http);
  await new Promise<void>(r => http.listen(0, '127.0.0.1', () => r()));
  const url = `ws://127.0.0.1:${(http.address() as any).port}/mqtt`;
  t.after(async () => { await service.onModuleDestroy(); http.close(); await auth.onModuleDestroy(); });
  const connect = (username?: string, password?: string) => new Promise<mqtt.MqttClient | Error>(resolve => {
    const c = mqtt.connect(url, { username, password, reconnectPeriod: 0, connectTimeout: 3000 });
    c.once('connect', () => resolve(c));
    c.once('error', e => { c.end(true); resolve(e); });
  });
  const pause = (ms = 300) => new Promise(r => setTimeout(r, ms));

  // Same account rules as TCP 1883.
  assert.ok(await connect() instanceof Error, 'anonymous WebSocket clients are refused');
  const ha = await connect('homeassistant', 'home-assistant-1') as mqtt.MqttClient;
  assert.ok(!(ha instanceof Error), 'an account signs in over WebSocket');
  const configs = new Map<string, any>();
  ha.on('message', (topic, payload) => { if (topic.endsWith('/config')) configs.set(topic, JSON.parse(payload.toString())); });
  await ha.subscribeAsync('homeassistant/#');

  // The device comes online: one HA device with eight entities, retained.
  service.publishState(id, { connected: true, ledEnabled: false, busy: false });
  await pause();
  const node = 'aiot_7c4fad2b3d70';
  assert.deepEqual([...configs.keys()].sort(), ['binary_sensor/alert', 'binary_sensor/busy', 'binary_sensor/online', 'light/led', 'sensor/humidity',
    'sensor/reply', 'sensor/temperature', 'text/ask'].map(k => `homeassistant/${k.split('/')[0]}/${node}/${k.split('/')[1]}/config`).sort());
  const light = configs.get(`homeassistant/light/${node}/led/config`);
  assert.equal(light.command_topic, `aiot/device/${id}/led/set`);
  assert.equal(light.state_topic, `aiot/device/${id}/led/status`);
  assert.equal(light.unique_id, `${node}_led`);
  assert.deepEqual(light.device.connections, [['mac', id.toLowerCase()]]);
  assert.equal(configs.get(`homeassistant/sensor/${node}/temperature/config`).device_class, 'temperature');

  // HA switching the light and asking the assistant reach the device.
  ha.publish(light.command_topic, light.payload_on);
  const ask = configs.get(`homeassistant/text/${node}/ask/config`);
  ha.publish(ask.command_topic, '{"action": "text", "text": "Nhiệt độ phòng?"}');
  await pause();
  assert.deepEqual(leds, [true]);
  assert.deepEqual(texts, ['Nhiệt độ phòng?']);

  // After an HA restart (birth message) the configs are sent again.
  configs.clear();
  ha.publish('homeassistant/status', 'online');
  await pause();
  assert.equal(configs.size, 8, 'discovery re-sent on the HA birth message');
  // Accounts still cannot forge discovery configs.
  ha.publish(`homeassistant/light/${node}/led/config`, '{"name":"fake"}');
  await pause();
  assert.notEqual(configs.get(`homeassistant/light/${node}/led/config`)?.name, 'fake');
  await ha.endAsync();
});
