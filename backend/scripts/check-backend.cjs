require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');
(async () => {
  const config = fs.readFileSync(path.join(__dirname, '../../include/config.h'), 'utf8');
  const value = name => new RegExp(name + '\\[\\]\\s*=\\s*"([^"]+)"').exec(config)?.[1];
  if (value('WS_TOKEN') !== process.env.DEVICE_TOKEN) throw new Error('Firmware/backend token mismatch');
  const host = value('WS_HOST');
  const port = /WS_PORT\s*=\s*(\d+)/.exec(config)?.[1];
  const wsPath = value('WS_PATH');
  const response = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok || (await response.json()).status !== 'ok') throw new Error('Health failed');
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${host}:${port}${wsPath}`, { headers: { Authorization: `Bearer ${process.env.DEVICE_TOKEN}` } });
    const timer = setTimeout(() => finish(new Error('No listening status')), 6000);
    function finish(error) { clearTimeout(timer); ws.terminate(); error ? reject(error) : resolve(); }
    ws.on('error', finish);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', device_id: `diagnostic-${process.pid}`, audio: { format: 'pcm_s16le', sample_rate: 16000, channels: 1 } })));
    ws.on('message', data => { const message = JSON.parse(data.toString()); if (message.type === 'status' && message.state === 'listening') finish(); });
  });
  console.log('Health, token match and authenticated WebSocket hello OK from laptop.');
  console.log('Phone/ESP32 access must still be tested separately.');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
