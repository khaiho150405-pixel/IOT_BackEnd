import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { AiotGateway, authenticate } from '../src/aiot/aiot.gateway';
import { AiotService, DecisionValue } from '../src/aiot/aiot.service';
import { HistoryStore } from '../src/aiot/history';
import { encodeImaAdpcm } from '../src/aiot/audio';

async function until(check: () => boolean, timeout = 6000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error('Timed out');
    await sleep(10);
  }
}
function sendUtterance(ws: WebSocket) {
  const voice = Buffer.alloc(640);
  for (let i = 0; i < 320; i++) voice.writeInt16LE(i % 2 ? 2000 : -2000, i * 2);
  for (let i = 0; i < 12; i++) ws.send(voice);
  for (let i = 0; i < 66; i++) ws.send(Buffer.alloc(640)); // > VAD_SILENCE_MS (1200 ms) of silence
}

test('WebSocket integrates microphone → AI → ack → OLED → PCM, interrupts, and recovers from TTS errors', async t => {
  process.env.DEVICE_TOKEN = 'local-test-token-with-at-least-24-characters';
  process.env.LED_ACK_RESEND_MS = '700';
  process.env.LED_ACK_TIMEOUT_MS = '2500';
  t.after(() => { delete process.env.LED_ACK_RESEND_MS; delete process.env.LED_ACK_TIMEOUT_MS; });
  const history = new HistoryStore();
  let calls = 0, receivedSensor: any, receivedHistory: any;
  let ttsFailure = false;
  const fakeAi = {
    async analyze(_pcm: Buffer, sensor: any, recent: any): Promise<DecisionValue> {
      calls++; receivedSensor = sensor; receivedHistory = recent;
      return { transcript: 'Tắt đèn', language: 'vi', intent: 'led_off', reply: 'Đã tắt đèn.', trackId: '' };
    },
    async speak() { if (ttsFailure) throw new Error('simulated TTS failure'); return Buffer.alloc(16000); },
  };
  const http = createServer();
  const gateway = new AiotGateway(fakeAi as unknown as AiotService, history);
  gateway.attach(http);
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const address = `ws://127.0.0.1:${(http.address() as AddressInfo).port}/aiot`;
  t.after(async () => { gateway.onModuleDestroy(); await new Promise<void>(resolve => http.close(() => resolve())); });
  const unauthorized = new WebSocket(address);
  const [authError] = await once(unauthorized, 'error');
  assert.match(String(authError), /401/);
  const ws = new WebSocket(address, { headers: { Authorization: `Bearer ${process.env.DEVICE_TOKEN}` } });
  const messages: any[] = [], audio: Buffer[] = [];
  ws.on('message', (data, binary) => { if (binary) audio.push(Buffer.from(data as Buffer)); else messages.push(JSON.parse(data.toString())); });
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'hello', device_id: 'test-device', audio: { format: 'pcm_s16le', sample_rate: 16000, channels: 1 } }));
  await until(() => messages.some(m => m.type === 'status' && m.state === 'listening'));
  ws.send(JSON.stringify({ type: 'sensor', valid: true, temperature: 28.5, humidity: 65 }));
  sendUtterance(ws);
  await until(() => messages.some(m => m.type === 'command'));
  assert.equal(messages.some(m => m.type === 'chat'), false, 'must not claim success before ack');
  const command = messages.find(m => m.type === 'command');
  ws.send(JSON.stringify({ type: 'ack', id: command.id, device: 'led', action: 'off', enabled: false }));
  await until(() => audio.length > 0);
  ws.send(JSON.stringify({ type: 'interrupt' }));
  await until(() => messages.filter(m => m.type === 'status' && m.state === 'listening').length === 2);
  assert.equal(calls, 1);
  assert.equal(receivedSensor.temperature, 28.5);
  assert.deepEqual(receivedHistory, []);
  assert.ok(messages.some(m => m.type === 'chat' && m.reply.includes('tắt')));
  assert.ok(messages.some(m => m.type === 'display' && Buffer.from(m.bitmap, 'base64').length === 448));
  // Frames of up to 2048 bytes (64 ms); the firmware accepts up to 4096 (max_audio_chunk_bytes).
  assert.ok(audio.every(frame => frame.length <= 2048 && frame.length % 2 === 0));
  assert.equal((await history.recent('test-device')).length, 1);
  await sleep(1600);
  ttsFailure = true;
  const previousCommands = messages.filter(m => m.type === 'command').length;
  sendUtterance(ws);
  await until(() => messages.filter(m => m.type === 'command').length > previousCommands);
  const next = messages.filter(m => m.type === 'command').at(-1);
  ws.send(JSON.stringify({ type: 'ack', id: next.id, device: 'led', action: 'off', enabled: false }));
  await until(() => messages.filter(m => m.type === 'status' && m.state === 'listening').length === 3);
  assert.ok(messages.some(m => m.type === 'notice' && m.code === 'tts_fallback'));
  assert.equal(receivedHistory.length, 1);
  await sleep(1600);
  sendUtterance(ws); // Deliberately never acknowledge this command.
  await until(() => messages.some(m => m.type === 'notice' && m.code === 'turn_failed'));
  assert.equal(messages.filter(m => m.type === 'chat').length, 2, 'timeout must not claim command success');
  const unanswered = messages.filter(m => m.type === 'command').at(-1);
  assert.ok(messages.filter(m => m.type === 'command' && m.id === unanswered.id).length >= 3,
    'an unacknowledged command is re-sent with the same id');
  ws.close();
});
test('authentication rejects missing/mismatched token', () => {
  assert.equal(authenticate(undefined, 'secret'), false);
  assert.equal(authenticate('Bearer wrong', 'secret'), false);
  assert.equal(authenticate('Bearer secret', 'secret'), true);
});

test('dashboard typed text uses Gemini decision, sensor, LED ACK, OLED and ESP32 speech path', async t => {
  process.env.DEVICE_TOKEN = 'typed-dashboard-token-with-at-least-24-characters';
  const previousFast = process.env.DEMO_FAST_CONFIRMATIONS;
  process.env.DEMO_FAST_CONFIRMATIONS = 'false';
  t.after(() => { if (previousFast === undefined) delete process.env.DEMO_FAST_CONFIRMATIONS; else process.env.DEMO_FAST_CONFIRMATIONS = previousFast; });
  let receivedText = '', receivedSensor: any;
  const ai = {
    async analyzeText(text: string, sensor: any): Promise<DecisionValue> {
      receivedText = text; receivedSensor = sensor;
      return { transcript: text, language: 'vi', intent: 'led_off', reply: 'Em đã tắt đèn, đại ca.', trackId: '' };
    },
    async speak() { return Buffer.alloc(640); },
  };
  const http = createServer(), gateway = new AiotGateway(ai as unknown as AiotService, new HistoryStore());
  gateway.attach(http); http.listen(0, '127.0.0.1'); await once(http, 'listening');
  t.after(async () => { gateway.onModuleDestroy(); await new Promise<void>(resolve => http.close(() => resolve())); });
  const ws = new WebSocket(`ws://127.0.0.1:${(http.address() as AddressInfo).port}/aiot`,
    { headers: { Authorization: `Bearer ${process.env.DEVICE_TOKEN}` } });
  const messages: any[] = [];
  ws.on('message', (data, binary) => {
    if (binary) return;
    const message = JSON.parse(data.toString()); messages.push(message);
    if (message.type === 'command') ws.send(JSON.stringify({ type: 'ack', id: message.id,
      device: 'led', action: message.action, enabled: message.action === 'on' }));
    if (message.type === 'audio_end') ws.send(JSON.stringify({ type: 'playback_done', id: message.id }));
  });
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'hello', device_id: 'typed-device', audio: { format: 'pcm_s16le', sample_rate: 16000, channels: 1 } }));
  await until(() => messages.some(m => m.state === 'listening'));
  ws.send(JSON.stringify({ type: 'sensor', valid: true, temperature: 27.5, humidity: 61 }));
  const result = await gateway.submitDashboardText('typed-device', 'Tắt đèn giúp em');
  assert.equal(result.transcript, 'Tắt đèn giúp em');
  assert.equal(result.intent, 'led_off');
  assert.equal(receivedText, 'Tắt đèn giúp em');
  assert.equal(receivedSensor.temperature, 27.5);
  assert.ok(messages.some(m => m.type === 'command' && m.action === 'off'));
  await until(() => messages.some(m => m.type === 'chat' && m.reply === 'Em đã tắt đèn, đại ca.') &&
    messages.some(m => m.type === 'display'));
  await until(() => messages.some(m => m.type === 'audio_end'));
  await until(() => messages.filter(m => m.state === 'listening').length >= 2);
  ws.close();
});

test('slow analysis and TTS return timeout and release microphone within the response budget', async t => {
  process.env.DEVICE_TOKEN = 'local-deadline-token-with-at-least-24-characters';
  const previousProvider = process.env.AI_PROVIDER;
  process.env.AI_PROVIDER = 'gemini';
  t.after(() => { if (previousProvider === undefined) delete process.env.AI_PROVIDER; else process.env.AI_PROVIDER = previousProvider; });
  let slowAnalysis = true;
  const fakeAi = {
    async analyze() {
      if (slowAnalysis) return new Promise<DecisionValue>(() => {});
      return { transcript: 'Xin chào', language: 'vi', intent: 'chat', reply: 'Em chào đại ca!', trackId: '' };
    },
    async speak() { return new Promise<Buffer>(() => {}); },
  };
  const history = new HistoryStore(), http = createServer();
  const gateway = new AiotGateway(fakeAi as unknown as AiotService, history);
  gateway.attach(http); http.listen(0, '127.0.0.1'); await once(http, 'listening');
  t.after(async () => { gateway.onModuleDestroy(); await new Promise<void>(resolve => http.close(() => resolve())); });
  const ws = new WebSocket(`ws://127.0.0.1:${(http.address() as AddressInfo).port}/aiot`,
    { headers: { Authorization: `Bearer ${process.env.DEVICE_TOKEN}` } });
  const messages: any[] = [];
  ws.on('message', (data, binary) => { if (!binary) messages.push(JSON.parse(data.toString())); });
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'hello', device_id: 'deadline-device', audio: { format: 'pcm_s16le', sample_rate: 16000, channels: 1 } }));
  await until(() => messages.some(m => m.state === 'listening'));
  let started = performance.now();
  sendUtterance(ws);
  await until(() => messages.some(m => m.code === 'response_timeout'), 10000);
  assert.ok(performance.now() - started < 10000);
  assert.equal(messages.some(m => m.type === 'chat'), false);
  await until(() => messages.filter(m => m.state === 'listening').length === 2);
  slowAnalysis = false; messages.length = 0; started = performance.now();
  sendUtterance(ws);
  await until(() => messages.some(m => m.code === 'tts_fallback'), 10000);
  assert.ok(performance.now() - started < 5000);
  assert.ok(messages.some(m => m.type === 'chat' && m.reply === 'Em chào đại ca!'), 'keep real reply visible on TTS timeout');
  await until(() => messages.some(m => m.state === 'listening'));
  ws.close();
});

test('successive LED on/off and sensor turns execute, speak, wait for playback done, and listen again', async t => {
  process.env.DEVICE_TOKEN = 'sequential-test-token-with-at-least-24-characters';
  const previous = process.env.DEMO_FAST_CONFIRMATIONS;
  process.env.DEMO_FAST_CONFIRMATIONS = 'true';
  t.after(() => { if (previous === undefined) delete process.env.DEMO_FAST_CONFIRMATIONS; else process.env.DEMO_FAST_CONFIRMATIONS = previous; });
  const intents = ['led_on', 'led_off', 'environment'];
  let calls = 0;
  const spoken: string[] = [];
  const ai = {
    async analyze(): Promise<DecisionValue> {
      return { intent: intents[calls++] as DecisionValue['intent'], transcript: 'Yêu cầu demo', language: 'vi', reply: 'Phản hồi', trackId: '' };
    },
    async speak(text: string) { spoken.push(text); return Buffer.alloc(640); },
  };
  const http = createServer(), gateway = new AiotGateway(ai as unknown as AiotService, new HistoryStore());
  gateway.attach(http); http.listen(0, '127.0.0.1'); await once(http, 'listening');
  t.after(async () => { gateway.onModuleDestroy(); await new Promise<void>(resolve => http.close(() => resolve())); });
  const ws = new WebSocket(`ws://127.0.0.1:${(http.address() as AddressInfo).port}/aiot`,
    { headers: { Authorization: `Bearer ${process.env.DEVICE_TOKEN}` } });
  const messages: any[] = []; let lamp = false;
  ws.on('message', (data, binary) => {
    if (binary) return;
    const m = JSON.parse(data.toString()); messages.push(m);
    if (m.type === 'command') {
      lamp = m.action === 'on';
      ws.send(JSON.stringify({ type: 'ack', id: m.id, device: 'led', action: m.action, enabled: lamp }));
    }
  });
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'hello', device_id: 'sequential-device', audio: { format: 'pcm_s16le', sample_rate: 16000, channels: 1 } }));
  await until(() => messages.some(m => m.state === 'listening'));
  for (let turn = 0; turn < 3; turn++) {
    // A new turn must work immediately after playback_done/listening.
    messages.length = 0;
    ws.send(JSON.stringify({ type: 'sensor', valid: true, temperature: 28.5, humidity: 65 }));
    // Pace PCM like a real 16 kHz microphone; three instantaneous recordings
    // would correctly hit the transport's per-second flood limit.
    const voice = Buffer.alloc(640);
    for (let i = 0; i < 320; i++) voice.writeInt16LE(i % 2 ? 2000 : -2000, i * 2);
    // The production VAD waits for 850 ms of silence so it does not clip sentence endings.
    for (let i = 0; i < 76; i++) { ws.send(i < 12 ? voice : Buffer.alloc(640)); await sleep(20); }
    await until(() => messages.some(m => m.type === 'audio_end'));
    assert.equal(messages.some(m => m.state === 'listening'), false, 'stay muted until actual playback done');
    const end = messages.find(m => m.type === 'audio_end');
    const begin = messages.find(m => m.type === 'audio_start');
    assert.equal(begin.id, end.id);
    assert.ok(messages.findIndex(m => m.type === 'chat') < messages.findIndex(m => m.type === 'audio_start'));
    if (turn < 2) assert.equal(lamp, turn === 0);
    ws.send(JSON.stringify({ type: 'playback_done', id: 'stale-id' }));
    await sleep(30);
    assert.equal(messages.some(m => m.state === 'listening'), false);
    ws.send(JSON.stringify({ type: 'playback_done', id: end.id }));
    await until(() => messages.some(m => m.state === 'listening'));
  }
  assert.equal(calls, 3);
  assert.equal(spoken[0], 'Em đã bật đèn, đại ca.');
  assert.equal(spoken[1], 'Em đã tắt đèn, đại ca.');
  assert.match(spoken[2], /28,5 độ C.*65,0 phần trăm/);
  ws.close();
});

test('actual NestJS bootstrap exposes health and authenticates WS without calling Gemini', async t => {
  const reserve = createServer();
  reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = (reserve.address() as AddressInfo).port;
  await new Promise<void>(resolve => reserve.close(() => resolve()));
  const token = 'bootstrap-test-token-24-chars-minimum';
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    env: { ...process.env, GEMINI_API_KEY: 'test-only-not-a-real-key', DEVICE_TOKEN: token,
      AI_PROVIDER: 'gemini', HOST: '127.0.0.1', PORT: String(port), DATABASE_URL: '', FONT_DIR: '',
      DEMO_FAST_CONFIRMATIONS: 'false', AUTH_DB_FILE: ':memory:', AUTH_JWT_SECRET: '',
      OWNER_USERNAME: 'owner', OWNER_PASSWORD: 'owner-pass-123', MQTT_ENABLED: 'false',
      HTTPS_ENABLED: 'false', MDNS_ENABLED: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', data => { output += data.toString(); });
  child.stderr.on('data', data => { output += data.toString(); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
  });
  await until(() => {
    if (child.exitCode !== null) throw new Error(output);
    return output.includes('Nest application successfully started');
  }, 15000);
  let healthy = false;
  for (let i = 0; i < 30; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      healthy = response.ok && (await response.json() as any).protocol === 'aiot-pcm16-v2';
      if (healthy) break;
    } catch { /* listener starts just after Nest's log */ }
    await sleep(50);
  }
  assert.ok(healthy, output);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/aiot`, { headers: { Authorization: `Bearer ${token}` } });
  await once(ws, 'open');
  ws.on('message', (data, binary) => {
    if (binary) return;
    const message = JSON.parse(data.toString());
    if (message.type === 'command') ws.send(JSON.stringify({ type: 'ack', id: message.id,
      device: 'led', action: message.action, enabled: message.action === 'on' }));
  });
  const reply = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'hello', device_id: 'bootstrap', led_enabled: true,
    audio: { format: 'pcm_s16le', sample_rate: 16000, channels: 1 } }));
  const [message] = await reply;
  assert.equal(JSON.parse(message.toString()).state, 'listening');
  const base = `http://127.0.0.1:${port}`;
  const post = (path: string, body: unknown, token?: string, method = 'POST') => fetch(base + path, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const get = (path: string, token?: string) => fetch(base + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const dashboard = await fetch(`${base}/dashboard`);
  assert.equal(dashboard.status, 200);
  assert.match(await dashboard.text(), /AIOT CONTROL DESK/);

  // Every device API requires an account now (the shared PIN and localhost-only mode are gone).
  assert.equal((await get('/api/dashboard/devices')).status, 401);
  assert.equal((await post('/api/auth/login', { username: 'owner', password: 'wrong-password' })).status, 401);
  const login = await post('/api/auth/login', { username: 'owner', password: 'owner-pass-123' });
  assert.equal(login.status, 201, output);
  const owner = (await login.json() as any).accessToken as string;

  // The ESP32 registers itself on hello; the owner sees and controls it.
  let deviceSnapshot: any;
  for (let i = 0; i < 40; i++) {
    deviceSnapshot = await (await get('/api/dashboard/devices', owner)).json();
    if (deviceSnapshot.devices?.length) break;
    await sleep(50);
  }
  assert.equal(deviceSnapshot.devices.length, 1, output);
  assert.equal(deviceSnapshot.devices[0].id, 'bootstrap');
  assert.equal(deviceSnapshot.devices[0].connected, true);
  assert.equal(deviceSnapshot.devices[0].ledEnabled, true, 'initial state comes from ESP32 hello');
  assert.equal(deviceSnapshot.devices[0].canControl, true);
  const ledCommand = await post('/api/dashboard/devices/bootstrap/led', { enabled: false }, owner);
  assert.equal(ledCommand.status, 201);
  assert.equal((await ledCommand.json() as any).ledEnabled, false);
  assert.equal((await post('/api/dashboard/devices/bootstrap/text', { text: '   ' }, owner)).status, 400);
  assert.equal((await post('/api/dashboard/devices/missing-device/text', { text: 'Xin chào' }, owner)).status, 404);
  assert.equal((await post('/api/dashboard/devices/missing-device/led', { enabled: true }, owner)).status, 404);

  // One account type: a second account (asked for as "member") controls the device at once
  // and can itself create accounts. Without an account nothing can be switched.
  const created = await post('/api/users', { username: 'friend1', password: 'friend-pass-1', role: 'member' }, owner);
  assert.equal(created.status, 201);
  assert.equal((await created.json() as any).role, 'admin');
  const friend = (await (await post('/api/auth/login', { username: 'friend1', password: 'friend-pass-1' })).json() as any).accessToken;
  const friendDevices = (await (await get('/api/devices', friend)).json() as any).devices;
  assert.equal(friendDevices.length, 1);
  assert.ok(friendDevices[0].canControl && friendDevices[0].canChat);
  assert.equal((await post('/api/devices/bootstrap/led', { enabled: true }, friend)).status, 201);
  assert.equal((await post('/api/users', { username: 'friend2', password: 'friend-pass-2' }, friend)).status, 201);
  assert.equal((await post('/api/devices/bootstrap/led', { enabled: false })).status, 401, 'visitors cannot control');

  // Audit trail: who did what; every account reads all of it.
  const audit = (await (await get('/api/audit', friend)).json() as any).entries as any[];
  assert.ok(audit.some(e => e.username === 'owner' && e.action === 'led:off' && e.result === 'ok'));
  assert.ok(audit.some(e => e.username === 'friend1' && e.action === 'led:on' && e.result === 'ok'));
  ws.close(); await once(ws, 'close');
});

test('a reconnecting device replaces its stale connection instead of being rejected', async t => {
  process.env.DEVICE_TOKEN = 'local-test-token-with-at-least-24-characters';
  const fakeAi = { async analyze() { throw new Error('unused'); }, async speak() { return Buffer.alloc(0); } };
  const http = createServer();
  const gateway = new AiotGateway(fakeAi as unknown as AiotService, new HistoryStore());
  gateway.attach(http);
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const address = `ws://127.0.0.1:${(http.address() as AddressInfo).port}/aiot`;
  t.after(async () => { gateway.onModuleDestroy(); await new Promise<void>(resolve => http.close(() => resolve())); });
  const hello = JSON.stringify({ type: 'hello', device_id: 'esp-reboot', audio: { format: 'pcm_s16le', sample_rate: 16000, channels: 1 } });
  const connect = async () => {
    const ws = new WebSocket(address, { headers: { Authorization: `Bearer ${process.env.DEVICE_TOKEN}` } });
    const messages: any[] = [];
    ws.on('message', (data, binary) => { if (!binary) messages.push(JSON.parse(data.toString())); });
    await once(ws, 'open');
    ws.send(hello);
    await until(() => messages.some(m => m.type === 'status' && m.state === 'listening'));
    return ws;
  };
  const stale = await connect();          // the old socket of a device that rebooted
  const staleClosed = once(stale, 'close');
  const fresh = await connect();          // must be accepted right away
  await staleClosed;
  assert.equal(fresh.readyState, WebSocket.OPEN);
  const devices = gateway.dashboardDevices().filter((d: any) => d.id === 'esp-reboot');
  assert.equal(devices.length, 1);
  assert.equal(devices[0].connected, true);
  fresh.close();
});

test('spoken turns need the assistant name, except right after an answer', async t => {
  process.env.DEVICE_TOKEN = 'wake-word-token-with-at-least-24-characters';
  process.env.WAKE_FOLLOWUP_MS = '3000';
  t.after(() => { delete process.env.WAKE_FOLLOWUP_MS; });
  const wakeFlags: boolean[] = [];
  let answer = true;
  const ai = {
    async analyze(_pcm: Buffer, _s: any, _h: any, _t: any, _signal: any, _led: any, requireWake: boolean): Promise<DecisionValue> {
      wakeFlags.push(requireWake);
      return answer ? { transcript: 'Trợ lý ơi, chào em', language: 'vi', intent: 'chat', reply: 'Dạ em chào đại ca.', trackId: '' } :
        { transcript: 'nói chuyện riêng', language: 'vi', intent: 'ignore', reply: '', trackId: '' };
    },
    async speak() { return Buffer.alloc(640); },
    wakeRequired: () => true,
  };
  // MQTT retained state must follow every turn, or panels keep showing busy=true.
  const mqttStates: any[] = [];
  const mqtt = { setGateway() {}, publishState: (_id: string, state: any) => mqttStates.push(state), publishSensor() {}, publishChat() {}, publishAlert() {} };
  const http = createServer(), gateway = new AiotGateway(ai as unknown as AiotService, new HistoryStore(), mqtt as any);
  const shown: string[] = [];
  const show = (gateway as any).show.bind(gateway);
  (gateway as any).show = (s: any, text: string, answer?: string) => { shown.push(text); return show(s, text, answer); };
  gateway.attach(http); http.listen(0, '127.0.0.1'); await once(http, 'listening');
  t.after(async () => { gateway.onModuleDestroy(); await new Promise<void>(resolve => http.close(() => resolve())); });
  const ws = new WebSocket(`ws://127.0.0.1:${(http.address() as AddressInfo).port}/aiot`,
    { headers: { Authorization: `Bearer ${process.env.DEVICE_TOKEN}` } });
  const messages: any[] = [];
  ws.on('message', (data, binary) => {
    if (binary) return;
    const message = JSON.parse(data.toString()); messages.push(message);
    if (message.type === 'audio_end') ws.send(JSON.stringify({ type: 'playback_done', id: message.id }));
  });
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'hello', device_id: 'wake-device', audio: { format: 'pcm_s16le', sample_rate: 16000, channels: 1 } }));
  const listening = () => messages.filter(m => m.state === 'listening').length;
  await until(() => listening() === 1);

  sendUtterance(ws); // first request: the name is required
  await until(() => listening() === 2);
  await sleep(1100); // stay under the 96 KB/s device rate limit
  sendUtterance(ws); // started inside the follow-up window: no name needed
  await until(() => listening() === 3);
  assert.deepEqual(wakeFlags, [true, false]);
  // The device is told the name is needed and how long the no-name window lasts (status bar countdown).
  const states = messages.filter(m => m.state === 'listening');
  assert.deepEqual(states[0], { type: 'status', state: 'listening', wake: true, follow_ms: 0 });
  assert.ok(states[1].follow_ms > 2500 && states[1].follow_ms <= 3000, 'window announced after an answer');
  assert.deepEqual(mqttStates.map(state => state.busy), [false, true, false, true, false],
    'MQTT state: idle after hello, busy during each turn, idle again after it');

  answer = false; // overheard talk is ignored and opens no follow-up window
  await sleep(4800); // window (3 s) + the 1.56 s utterance the test sends at once
  sendUtterance(ws);
  await until(() => listening() === 4);
  await sleep(1100);
  sendUtterance(ws);
  await until(() => listening() === 5);
  assert.deepEqual(wakeFlags, [true, false, true, true]);
  assert.equal(messages.filter(m => m.type === 'chat').length, 2, 'ignored talk gets no reply');
  const after = messages.filter(m => m.state === 'listening');
  assert.equal(after[3].follow_ms, 0, 'ignored talk opens no window');
  assert.ok(shown.includes('Gọi "Trợ lý ơi"\nđể ra lệnh nhé.'), 'back to the hint when the window ends');
  ws.close();
});

test('a device announcing mic_codec ima_adpcm is understood like raw PCM', async t => {
  process.env.DEVICE_TOKEN = 'adpcm-device-token-with-at-least-24-characters';
  let heard: Buffer | undefined;
  const ai = {
    async analyze(pcm: Buffer): Promise<DecisionValue> {
      heard = pcm;
      return { transcript: 'Xin chào', language: 'vi', intent: 'chat', reply: 'Dạ.', trackId: '' };
    },
    async speak() { return Buffer.alloc(640); },
  };
  const http = createServer(), gateway = new AiotGateway(ai as unknown as AiotService, new HistoryStore());
  gateway.attach(http); http.listen(0, '127.0.0.1'); await once(http, 'listening');
  t.after(async () => { gateway.onModuleDestroy(); await new Promise<void>(resolve => http.close(() => resolve())); });
  const ws = new WebSocket(`ws://127.0.0.1:${(http.address() as AddressInfo).port}/aiot`,
    { headers: { Authorization: `Bearer ${process.env.DEVICE_TOKEN}` } });
  const messages: any[] = [];
  ws.on('message', (data, binary) => {
    if (binary) return;
    const m = JSON.parse(data.toString()); messages.push(m);
    if (m.type === 'audio_end') ws.send(JSON.stringify({ type: 'playback_done', id: m.id }));
  });
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'hello', device_id: 'adpcm-device', mic_codec: 'ima_adpcm',
    audio: { format: 'pcm_s16le', sample_rate: 16000, channels: 1 } }));
  await until(() => messages.some(m => m.state === 'listening'));
  // 0.48 s of a 400 Hz tone, then 1.6 s of silence, in 256-sample ADPCM frames like the firmware.
  let index = 0, bytes = 0;
  const frame = (voiced: boolean) => {
    const pcm = Buffer.alloc(512);
    if (voiced) for (let i = 0; i < 256; i++) pcm.writeInt16LE(Math.round(4000 * Math.sin(i * 2 * Math.PI * 400 / 16000)), i * 2);
    const encoded = encodeImaAdpcm(pcm, index); index = encoded.index; bytes += encoded.frame.length;
    ws.send(encoded.frame);
  };
  for (let i = 0; i < 30; i++) frame(true);
  for (let i = 0; i < 100; i++) frame(false);
  await until(() => !!heard);
  assert.ok(bytes < 130 * 140, `~4x less uplink than PCM (${bytes} bytes for 130 frames)`);
  let peak = 0;
  for (let i = 0; i < heard!.length; i += 2) peak = Math.max(peak, Math.abs(heard!.readInt16LE(i)));
  // The 120 Hz high-pass adds a short overshoot at the tone onset; a broken decoder would give ~0 or ~32767.
  assert.ok(peak > 3000 && peak < 5500, `decoded speech keeps its level (peak ${peak})`);
  ws.close();
});

test('a device on the laptop network gets the laptop LAN address (lan_hint) after a tunnel hello', async t => {
  const { networkInterfaces } = await import('node:os');
  const { laptopAddressFor } = await import('../src/network/mdns');
  assert.equal(laptopAddressFor('8.8.8.8', '255.255.255.0'), undefined, 'public addresses are never hinted');
  assert.equal(laptopAddressFor('10.0.0.5', '255.0.0.0'), undefined, 'networks larger than /16 are not trusted');
  assert.equal(laptopAddressFor('not-an-ip', '255.255.255.0'), undefined);
  const lan = Object.values(networkInterfaces()).flat().find(a => a && a.family === 'IPv4' && !a.internal &&
    /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address) && a.netmask === '255.255.255.0');
  if (!lan) { t.skip('no private /24 interface on this machine'); return; }
  const parts = lan.address.split('.');
  const deviceIp = [...parts.slice(0, 3), String((Number(parts[3]) % 250) + 2)].join('.');
  assert.equal(laptopAddressFor(deviceIp, '255.255.255.0'), lan.address);

  process.env.DEVICE_TOKEN = 'lan-hint-token-with-at-least-24-characters';
  const ai = { async analyze() { throw new Error('unused'); }, async speak() { return Buffer.alloc(0); } };
  const http = createServer(), gateway = new AiotGateway(ai as unknown as AiotService, new HistoryStore());
  gateway.attach(http); http.listen(0, '127.0.0.1'); await once(http, 'listening');
  t.after(async () => { gateway.onModuleDestroy(); await new Promise<void>(resolve => http.close(() => resolve())); });
  const hello = async (ip: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${(http.address() as AddressInfo).port}/aiot`,
      { headers: { Authorization: `Bearer ${process.env.DEVICE_TOKEN}` } });
    const messages: any[] = [];
    ws.on('message', (data, binary) => { if (!binary) messages.push(JSON.parse(data.toString())); });
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'hello', device_id: 'lan-device', ip, netmask: '255.255.255.0',
      audio: { format: 'pcm_s16le', sample_rate: 16000, channels: 1 } }));
    await until(() => messages.some(m => m.state === 'listening'));
    await sleep(50);
    ws.close();
    return messages.find(m => m.type === 'lan_hint');
  };
  assert.deepEqual(await hello(deviceIp), { type: 'lan_hint', host: lan.address, port: Number(process.env.PORT || 3100) });
  assert.equal(await hello('203.0.113.7'), undefined, 'another network: no hint');
});
