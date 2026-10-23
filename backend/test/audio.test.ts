import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UtteranceDetector, readWav, resample, wavFromPcm } from '../src/aiot/audio';
import { OledRenderer, PAGE_BYTES } from '../src/aiot/display';
import { MusicLibrary } from '../src/aiot/music';
import { HistoryStore } from '../src/aiot/history';

function tone(samples: number, amplitude = 2000, hz = 400, rate = 16000) {
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) pcm.writeInt16LE(Math.round(amplitude * Math.sin(i * Math.PI * 2 * hz / rate)), i * 2);
  return pcm;
}

test('VAD excludes silence, keeps pre-roll, returns one bounded utterance', () => {
  const vad = new UtteranceDetector(500, 900, 2000);
  for (let i = 0; i < 100; i++) assert.equal(vad.push(Buffer.alloc(640)), undefined);
  for (let i = 0; i < 12; i++) assert.equal(vad.push(tone(320)), undefined);
  let result: Buffer | undefined;
  for (let i = 0; i < 45; i++) result = vad.push(Buffer.alloc(640)) || result;
  assert.ok(result && result.length >= 1140 * 32 && result.length <= 1500 * 32);
  assert.equal(vad.push(Buffer.alloc(640)), undefined);
  assert.throws(() => vad.push(Buffer.alloc(3)));
});
test('VAD rejects clicks and cuts continuous sound at maximum duration', () => {
  const vad = new UtteranceDetector(500, 300, 2000);
  vad.push(tone(320));
  for (let i = 0; i < 20; i++) assert.equal(vad.push(Buffer.alloc(640)), undefined);
  let count = 0;
  for (let i = 0; i < 210; i++) if (vad.push(tone(320))) count++;
  assert.equal(count, 2);
});
test('WAV parser validates format/truncation and supports extra RIFF chunks', () => {
  const pcm = tone(320);
  assert.deepEqual(readWav(wavFromPcm(pcm)), { pcm, rate: 16000 });
  const base = wavFromPcm(pcm);
  const extra = Buffer.from('4a554e4b020000000000', 'hex');
  const withMetadata = Buffer.concat([base.subarray(0, 36), extra, base.subarray(36)]);
  withMetadata.writeUInt32LE(withMetadata.length - 8, 4);
  assert.deepEqual(readWav(withMetadata).pcm, pcm);
  assert.throws(() => readWav(base.subarray(0, 46)));
  base.writeUInt16LE(2, 22);
  assert.throws(() => readWav(base), /mono/);
});
test('24 kHz to 16 kHz preserves duration/amplitude and suppresses above-Nyquist tone', () => {
  const result = resample(tone(2400, 2000, 400, 24000), 24000);
  assert.equal(result.length, 3200);
  assert.ok(Math.abs(result.readInt16LE(20) - 2000) < 100);
  const high = resample(tone(2400, 2000, 10000, 24000), 24000);
  let energy = 0;
  for (let i = 100; i < high.length - 100; i += 2) energy += high.readInt16LE(i) ** 2;
  assert.ok(Math.sqrt(energy / ((high.length - 200) / 2)) < 200);
});
test('OLED renders Vietnamese as paginated 128x28 bitmaps within firmware message limit', () => {
  const renderer = new OledRenderer();
  const pages = renderer.pages('Bạn: Nhiệt độ và độ ẩm trong phòng?\nAI: Nhiệt độ 28,5°C, độ ẩm 65%. Đã tắt đèn.');
  assert.ok(pages.length >= 2 && pages.length <= 32);
  for (const page of pages) {
    assert.equal(page.length, PAGE_BYTES);
    assert.ok(page.some(byte => byte > 0));
    assert.ok(Buffer.byteLength(JSON.stringify({ type: 'display', batch: 'x'.repeat(36), index: 0, total: pages.length, bitmap: page.toString('base64') })) < 2048);
  }
  assert.notDeepEqual(renderer.pages('Độ ẩm')[0], renderer.pages('Do am')[0]);
});

test('OLED conversation preserves separate question and answer regions on every page', () => {
  const renderer = new OledRenderer();
  const pages = renderer.conversation('Đại ca hỏi nhiệt độ trong phòng?', 'Em thấy nhiệt độ 28,5°C và độ ẩm 65% đại ca ơi.');
  assert.ok(pages.length > 1 && pages.length <= 32);
  for (const page of pages) {
    assert.equal(page.length, PAGE_BYTES);
    assert.ok(page.subarray(0, 128 * 13 / 8).some(byte => byte));
    assert.ok(page.subarray(128 * 15 / 8).some(byte => byte));
    assert.ok(page.subarray(128 * 13 / 8, 128 * 14 / 8).every(byte => byte === 255));
  }
  assert.notDeepEqual(renderer.conversation('Bạn khỏe không?', 'Em khỏe.')[0],
    renderer.conversation('Bạn khỏe không?', 'Em mệt.')[0]);
});
test('music validates catalog WAV paths, IDs and sample rate', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aiot-music-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'track.wav'), wavFromPcm(tone(320)));
  await writeFile(join(root, 'catalog.json'), JSON.stringify([
    { id: 'test', title: 'Test', file: 'track.wav' },
    { id: 'escape', title: 'Escape', file: '../outside.wav' },
    { id: 'wrong-rate', title: 'Wrong', file: 'wrong.wav' },
  ]));
  await writeFile(join(root, 'wrong.wav'), wavFromPcm(tone(320), 24000));
  const music = new MusicLibrary(root);
  assert.equal((await music.read('test')).length, 640);
  await assert.rejects(music.read('unknown'));
  await assert.rejects(music.read('escape'));
  await assert.rejects(music.read('wrong-rate'), /16000/);
});
test('music automatically lists MP4 files by Vietnamese filename', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aiot-mp4-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'mp4'));
  await writeFile(join(root, 'catalog.json'), '[]');
  await writeFile(join(root, 'mp4', 'Nhạc thư giãn.mp4'), 'test container');
  await writeFile(join(root, 'mp4', 'ignore.txt'), 'not music');
  const tracks = await new MusicLibrary(root).catalog();
  assert.deepEqual(tracks, [{ id: 'mp4-Nhac-thu-gian', title: 'Nhạc thư giãn', file: 'mp4/Nhạc thư giãn.mp4' }]);
});
test('history keeps last five exchanges and isolates devices', async () => {
  const history = new HistoryStore();
  for (let i = 0; i < 7; i++) await history.add('device-a', String(i), 'reply', 'chat');
  assert.deepEqual((await history.recent('device-a')).map(row => row.transcript), ['2', '3', '4', '5', '6']);
  assert.deepEqual(await history.recent('device-b'), []);
});
