require('dotenv').config({ quiet: true });
const { AiotService } = require('../dist/src/aiot/aiot.service');
(async () => {
  if (!process.env.GEMINI_API_KEY) throw new Error('Missing GEMINI_API_KEY');
  const ai = new AiotService();
  const signal = AbortSignal.timeout(90000);
  const pcm = await ai.speak('Xin chào, nhiệt độ trong phòng là bao nhiêu?', signal);
  console.log(`TTS OK: ${pcm.length} bytes PCM16 mono 16kHz`);
  const started = performance.now();
  const responseSignal = AbortSignal.timeout(9000);
  const result = await ai.analyze(pcm, { temperature: 28, humidity: 65, receivedAt: Date.now() }, [], [],
    AbortSignal.any([responseSignal, AbortSignal.timeout(6500)]));
  if (result.intent !== 'environment' || !result.transcript) throw new Error('Audio recognition did not return environment intent');
  console.log('Audio analysis OK:', result.intent, result.language);
  console.log(`Decision latency: ${Math.round(performance.now() - started)}ms`);
  await ai.speak(result.reply, responseSignal);
  console.log(`Reply audio ready: ${Math.round(performance.now() - started)}ms (+500ms silence detection on hardware)`);
  console.log('Synthetic sensor fixture only; microphone, speaker and real sensor still require hardware testing.');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
