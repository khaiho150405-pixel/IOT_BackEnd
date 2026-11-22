import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'ws';

async function freePort() {
  const reserve = createServer();
  reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = (reserve.address() as AddressInfo).port;
  await new Promise<void>(resolve => reserve.close(() => resolve()));
  return port;
}
function get(url: string, options: { ca?: string; host?: string } = {}) {
  return new Promise<{ status: number; headers: any; body: Buffer }>((resolve, reject) => {
    const parsed = new URL(url);
    const request = (parsed.protocol === 'https:' ? httpsRequest : httpRequest)(parsed, {
      ca: options.ca, headers: options.host ? { host: options.host } : {}, servername: 'localhost',
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', c => chunks.push(c));
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on('error', reject);
    request.end();
  });
}

test('local HTTPS, certificate download, HTTPS redirect, PWA files and the live device channel', async t => {
  const [port, httpsPort] = [await freePort(), await freePort()];
  const tlsDir = mkdtempSync(join(tmpdir(), 'aiot-tls-'));
  const token = 'network-test-token-24-chars-minimum';
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    env: { ...process.env, GEMINI_API_KEY: 'test-only-not-a-real-key', DEVICE_TOKEN: token, AI_PROVIDER: 'gemini',
      HOST: '127.0.0.1', PORT: String(port), HTTPS_PORT: String(httpsPort), TLS_DIR: tlsDir, MDNS_ENABLED: 'false',
      DATABASE_URL: '', AUTH_DB_FILE: ':memory:', AUTH_JWT_SECRET: '', OWNER_USERNAME: 'owner', OWNER_PASSWORD: 'owner-pass-123',
      MQTT_ENABLED: 'false', FONT_DIR: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', d => { output += d; });
  child.stderr.on('data', d => { output += d; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
    rmSync(tlsDir, { recursive: true, force: true });
  });
  const start = Date.now();
  while (!output.includes('HTTPS for browsers')) {
    if (child.exitCode !== null || Date.now() - start > 60000) throw new Error(output || "server did not start within 60 s");
    await sleep(50);
  }

  // The CA is downloadable over plain HTTP and really signs the HTTPS certificate.
  const ca = await get(`http://127.0.0.1:${port}/ca.crt`);
  assert.equal(ca.status, 200);
  assert.match(String(ca.headers['content-type']), /x509-ca-cert/);
  const caPem = ca.body.toString();
  assert.ok(new X509Certificate(caPem).ca);
  const health = await get(`https://127.0.0.1:${httpsPort}/health`, { ca: caPem });
  assert.equal(health.status, 200, 'TLS handshake succeeds when only the local CA is trusted');

  // Pages opened from another machine over HTTP move to HTTPS; localhost and /trust stay on HTTP.
  const remote = await get(`http://127.0.0.1:${port}/dashboard`, { host: `aiot.local:${port}` });
  assert.equal(remote.status, 302);
  assert.equal(remote.headers.location, `https://aiot.local:${httpsPort}/dashboard`);
  assert.equal((await get(`http://127.0.0.1:${port}/dashboard`)).status, 200);
  assert.equal((await get(`http://127.0.0.1:${port}/trust`, { host: `aiot.local:${port}` })).status, 200);
  const info = JSON.parse((await get(`http://127.0.0.1:${port}/api/network`)).body.toString());
  assert.equal(info.https, true);
  assert.equal(info.httpsPort, httpsPort);

  // PWA: manifest, service worker and generated PNG icons.
  const manifest = JSON.parse((await get(`https://127.0.0.1:${httpsPort}/manifest.webmanifest`, { ca: caPem })).body.toString());
  assert.equal(manifest.start_url, '/dashboard');
  assert.ok(manifest.icons.some((i: any) => i.purpose === 'maskable'));
  const sw = await get(`https://127.0.0.1:${httpsPort}/sw.js`, { ca: caPem });
  assert.match(String(sw.headers['content-type']), /javascript/);
  assert.match(sw.body.toString(), /\/api\//, 'the worker must exclude /api from caching');
  const icon = await get(`https://127.0.0.1:${httpsPort}/icons/icon-192.png`, { ca: caPem });
  assert.deepEqual([...icon.body.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'PNG signature');
  assert.equal((await get(`https://127.0.0.1:${httpsPort}/icons/icon-77.png`, { ca: caPem })).status, 404);

  // Live channel: refuses a bad token, then pushes device changes to a signed-in owner.
  const bad = new WebSocket(`wss://127.0.0.1:${httpsPort}/api/live`, { ca: caPem, servername: 'localhost' } as any);
  await once(bad, 'open');
  bad.send(JSON.stringify({ type: 'auth', token: 'not-a-token' }));
  const [badCode] = await once(bad, 'close');
  assert.equal(badCode, 4401);

  const login = await fetch(`http://127.0.0.1:${port}/api/auth/login`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'owner-pass-123' }) });
  const accessToken = (await login.json() as any).accessToken;
  const live = new WebSocket(`wss://127.0.0.1:${httpsPort}/api/live`, { ca: caPem, servername: 'localhost' } as any);
  const updates: any[] = [];
  live.on('message', data => updates.push(JSON.parse(data.toString())));
  await once(live, 'open');
  live.send(JSON.stringify({ type: 'auth', token: accessToken }));
  const waitFor = async (check: () => boolean, ms = 5000) => {
    const begin = Date.now();
    while (!check()) { if (Date.now() - begin > ms) throw new Error(JSON.stringify(updates)); await sleep(25); }
  };
  await waitFor(() => updates.some(u => u.type === 'ready'));
  await waitFor(() => updates.some(u => u.type === 'devices'));

  // An ESP32 connects (plain ws on the HTTP port) and its LED state is pushed without polling.
  const device = new WebSocket(`ws://127.0.0.1:${port}/aiot`, { headers: { Authorization: `Bearer ${token}` } });
  await once(device, 'open');
  device.send(JSON.stringify({ type: 'hello', device_id: 'live-dev', led_enabled: false,
    audio: { format: 'pcm_s16le', sample_rate: 16000, channels: 1 } }));
  await waitFor(() => updates.some(u => u.type === 'devices' && u.devices.some((d: any) => d.id === 'live-dev' && d.connected)));
  device.on('message', data => {
    const m = JSON.parse(data.toString());
    if (m.type === 'command') device.send(JSON.stringify({ type: 'ack', id: m.id, device: 'led', action: m.action, enabled: m.action === 'on' }));
  });
  const switched = Date.now();
  await fetch(`http://127.0.0.1:${port}/api/devices/live-dev/led`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` }, body: JSON.stringify({ enabled: true }) });
  await waitFor(() => updates.some(u => u.type === 'devices' && u.devices.some((d: any) => d.id === 'live-dev' && d.ledEnabled === true)));
  assert.ok(Date.now() - switched < 2000, 'pushed within the 0.5 s change-detection window');

  // Visitors without an account: read-only temperature/humidity/LED view, no MAC, no control.
  const publicView = await fetch(`http://127.0.0.1:${port}/api/public/devices`);
  assert.equal(publicView.status, 200);
  const publicDevices = (await publicView.json() as any).devices;
  const shown = publicDevices.find((d: any) => d.connected);
  assert.ok(shown, 'the connected ESP32 is visible');
  assert.equal(shown.ledEnabled, true);
  assert.ok('sensor' in shown);
  assert.equal(shown.canControl, false);
  assert.ok(!JSON.stringify(publicDevices).includes('live-dev'), 'device id (MAC) is not exposed');
  assert.deepEqual(Object.keys(shown).sort(), ['canChat', 'canControl', 'connected', 'id', 'ledEnabled', 'name', 'sensor']);
  for (const path of ['/api/devices', '/api/users', '/api/audit'])
    assert.equal((await fetch(`http://127.0.0.1:${port}${path}`)).status, 401, `${path} needs an account`);
  const anonymousLed = await fetch(`http://127.0.0.1:${port}/api/devices/live-dev/led`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
  assert.equal(anonymousLed.status, 401, 'visitors cannot switch the light');
  const guest = new WebSocket(`wss://127.0.0.1:${httpsPort}/api/live`, { ca: caPem, servername: 'localhost' } as any);
  const guestUpdates: any[] = [];
  guest.on('message', data => guestUpdates.push(JSON.parse(data.toString())));
  await once(guest, 'open');
  guest.send(JSON.stringify({ type: 'guest' }));
  const guestBegin = Date.now();
  while (!guestUpdates.some(u => u.type === 'devices')) {
    if (Date.now() - guestBegin > 5000) throw new Error(JSON.stringify(guestUpdates));
    await sleep(25);
  }
  const guestDevices = guestUpdates.find(u => u.type === 'devices').devices;
  assert.ok(guestDevices.some((d: any) => d.connected && d.ledEnabled === true && !d.canControl));
  assert.ok(!JSON.stringify(guestUpdates).includes('live-dev'));
  guest.close();

  // Unknown WebSocket paths are refused instead of hanging.
  const stray = new WebSocket(`ws://127.0.0.1:${port}/nope`);
  await once(stray, 'error');
  live.close(); device.close();
});
