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
  for (let i = 0; i < 46; i++) ws.send(Buffer.alloc(640));
}

test('WebSocket integrates microphone → AI → ack → OLED → PCM, interrupts, and recovers from TTS errors', async t => {
  process.env.DEVICE_TOKEN = 'local-test-token-with-at-least-24-characters';
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
  assert.ok(audio.every(frame => frame.length <= 640 && frame.length % 2 === 0));
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
    for (let i = 0; i < 56; i++) { ws.send(i < 12 ? voice : Buffer.alloc(640)); await sleep(20); }
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
      DEMO_FAST_CONFIRMATIONS: 'false' },
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
  const dashboard = await fetch(`http://127.0.0.1:${port}/dashboard`);
  assert.equal(dashboard.status, 200);
  assert.match(await dashboard.text(), /AIOT CONTROL DESK/);
  const devices = await fetch(`http://127.0.0.1:${port}/api/dashboard/devices`);
  const deviceSnapshot = await devices.json() as any;
  assert.equal(deviceSnapshot.devices.length, 1, output);
  assert.equal(deviceSnapshot.devices[0].id, 'bootstrap');
  assert.equal(deviceSnapshot.devices[0].connected, true);
  assert.equal(deviceSnapshot.devices[0].ledEnabled, true, 'initial state comes from ESP32 hello');
  const rejectedOrigin = await fetch(`http://127.0.0.1:${port}/api/dashboard/devices`, {
    headers: { origin: 'https://example.invalid' },
  });
  assert.equal(rejectedOrigin.status, 403);
  const ledCommand = await fetch(`http://127.0.0.1:${port}/api/dashboard/devices/bootstrap/led`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(ledCommand.status, 201);
  assert.equal((await ledCommand.json() as any).ledEnabled, false);
  const invalidText = await fetch(`http://127.0.0.1:${port}/api/dashboard/devices/bootstrap/text`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` },
    body: JSON.stringify({ text: '   ' }),
  });
  assert.equal(invalidText.status, 400);
  const offlineText = await fetch(`http://127.0.0.1:${port}/api/dashboard/devices/missing-device/text`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` },
    body: JSON.stringify({ text: 'Xin chào' }),
  });
  assert.equal(offlineText.status, 404);
  const offlineCommand = await fetch(`http://127.0.0.1:${port}/api/dashboard/devices/missing-device/led`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(offlineCommand.status, 404);
  ws.close(); await once(ws, 'close');
});
