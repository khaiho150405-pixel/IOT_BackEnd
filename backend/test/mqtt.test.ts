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

test('embedded broker requires accounts and enforces per-device MQTT permissions', async t => {
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
  const viewer = await auth.createUser(owner, { username: 'viewer', password: 'viewer-pass-1', role: 'member' });
  await auth.setPermissions(owner, viewer.id, [{ deviceId: 'dev-a', canControl: false }]);

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
    const c = mqtt.connect(`mqtt://127.0.0.1:${testPort}`, { username, password, reconnectPeriod: 0, connectTimeout: 3000 });
    c.once('connect', () => resolve(c));
    c.once('error', e => { c.end(true); resolve(e); });
  });
  const pause = (ms = 250) => new Promise(r => setTimeout(r, ms));
  // mqtt.js rejects a SUBACK with 128 (refused); report each topic separately.
  const subscribe = (c: mqtt.MqttClient, topic: string) =>
    c.subscribeAsync(topic).then(() => 'granted', () => 'refused');

  // No account / wrong password: refused.
  assert.ok(await connect() instanceof Error, 'anonymous clients are refused');
  assert.ok(await connect('viewer', 'wrong-password') instanceof Error, 'bad password refused');

  // Viewer: may watch dev-a only, may not command it.
  const v = await connect('viewer', 'viewer-pass-1') as mqtt.MqttClient;
  assert.ok(!(v instanceof Error));
  assert.equal(await subscribe(v, 'aiot/device/dev-a/state'), 'granted', 'own device');
  assert.equal(await subscribe(v, 'aiot/device/dev-b/state'), 'refused', 'other device');
  assert.equal(await subscribe(v, 'aiot/#'), 'refused', 'wildcard');
  assert.equal(await subscribe(v, 'aiot/sensor'), 'refused', 'aggregate topic of all devices');
  v.publish('aiot/device/dev-a/led/set', 'on');
  await pause();
  assert.equal(leds.length, 0, 'viewer cannot switch the light');

  // After a control grant the same account can switch dev-a but still not dev-b.
  await auth.setPermissions(owner, viewer.id, [{ deviceId: 'dev-a', canControl: true }]);
  v.publish('aiot/device/dev-a/led/set', 'on');
  v.publish('aiot/device/dev-b/led/set', 'on');
  await pause();
  assert.deepEqual(leds, [{ deviceId: 'dev-a', enabled: true }]);

  // Owner may do everything, including aggregate topics.
  const o = await connect('owner', 'owner-pass-123') as mqtt.MqttClient;
  assert.equal(await subscribe(o, 'aiot/#'), 'granted');
  o.publish('aiot/device/dev-b/led/set', 'off');
  await pause();
  assert.deepEqual(leds.at(-1), { deviceId: 'dev-b', enabled: false });

  // A refused command keeps the client connected but reaches nobody, even a "#" subscriber.
  const seen: string[] = [];
  o.on('message', topic => seen.push(topic));
  assert.equal(await subscribe(o, '#'), 'granted');
  const before = leds.length;
  v.publish('aiot/device/dev-b/led/set', 'on');
  v.publish('aiot/device/dev-a/led/set', 'off');
  await pause();
  assert.ok(!seen.some(topic => topic.startsWith('$')), 'diverted packets are not delivered');
  assert.deepEqual(leds.slice(before), [{ deviceId: 'dev-a', enabled: false }], 'still connected after a refusal');

  const audit = await auth.listAudit(owner, 100);
  assert.ok(audit.some(e => e.source === 'mqtt' && e.username === 'viewer' && e.result === 'denied'));
  assert.ok(audit.some(e => e.source === 'mqtt' && e.username === 'viewer' && e.result === 'ok' && e.deviceId === 'dev-a'));
  await v.endAsync(); await o.endAsync();
});
