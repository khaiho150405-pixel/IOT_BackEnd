import test from 'node:test';
import assert from 'node:assert/strict';
import { AiotService } from '../src/aiot/aiot.service';
import { wavFromPcm } from '../src/aiot/audio';

test('Gemini request contains audio, fresh sensor and history; invalid decisions cannot actuate', async t => {
  const original = globalThis.fetch;
  const provider = process.env.AI_PROVIDER;
  const apiKey = process.env.GEMINI_API_KEY;
  const style = process.env.ASSISTANT_STYLE;
  const apiStyle = process.env.GEMINI_API_STYLE;
  process.env.AI_PROVIDER = 'gemini';
  process.env.GEMINI_API_STYLE = 'current';
  process.env.GEMINI_API_KEY = 'test-only-not-a-real-key';
  process.env.ASSISTANT_STYLE = 'Gọi người dùng là đại ca.';
  t.after(() => {
    globalThis.fetch = original;
    if (provider === undefined) delete process.env.AI_PROVIDER; else process.env.AI_PROVIDER = provider;
    if (apiKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = apiKey;
    if (style === undefined) delete process.env.ASSISTANT_STYLE; else process.env.ASSISTANT_STYLE = style;
    if (apiStyle === undefined) delete process.env.GEMINI_API_STYLE; else process.env.GEMINI_API_STYLE = apiStyle;
  });
  let captured: any;
  let reply: any = { transcript: 'Turn the light off', language: 'en', intent: 'led_off', reply: 'The light is off.', trackId: '' };
  globalThis.fetch = async (_url, init) => {
    captured = JSON.parse(init!.body as string);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(reply) }] } }] }));
  };
  const ai = new AiotService();
  const signal = new AbortController().signal;
  const sensor = { temperature: 28.5, humidity: 65, receivedAt: Date.now() };
  assert.equal((await ai.analyze(Buffer.alloc(640), sensor, [], [], signal)).intent, 'led_off');
  assert.equal(captured.generationConfig.responseFormat.text.mimeType, 'APPLICATION_JSON');
  assert.equal(captured.generationConfig.responseFormat.text.schema.type, 'object');
  assert.equal(captured.generationConfig.responseSchema, undefined);
  assert.equal(captured.contents[0].parts[1].inlineData.mimeType, 'audio/wav');
  assert.equal(Buffer.from(captured.contents[0].parts[1].inlineData.data, 'base64').toString('ascii', 0, 4), 'RIFF');
  assert.equal(JSON.parse(captured.contents[0].parts[0].text).sensor.temperature, 28.5);
  assert.match(captured.systemInstruction.parts[0].text, /Gọi người dùng là đại ca/);
  await ai.analyze(Buffer.alloc(640), { ...sensor, receivedAt: Date.now() - 9000 }, [], [], signal);
  assert.equal(JSON.parse(captured.contents[0].parts[0].text).sensor, null);
  const recent = [{ transcript: 'Xin chào', reply: 'Em chào đại ca!' }] as any;
  await ai.analyzeText('Nhiệt độ và độ ẩm trong phòng bao nhiêu?', sensor, recent, [], signal);
  const textContext = JSON.parse(captured.contents[0].parts[0].text);
  assert.equal(textContext.currentUserText, 'Nhiệt độ và độ ẩm trong phòng bao nhiêu?');
  assert.equal(textContext.sensor.humidity, 65);
  assert.deepEqual(textContext.recentConversation, [{ user: 'Xin chào', assistant: 'Em chào đại ca!' }]);
  assert.equal(captured.contents[0].parts.length, 1, 'typed input is sent as text, not fabricated audio');
  process.env.GEMINI_API_STYLE = 'legacy';
  const model = process.env.GEMINI_MODEL;
  process.env.GEMINI_MODEL = 'gemini-2.5-flash';
  t.after(() => { if (model === undefined) delete process.env.GEMINI_MODEL; else process.env.GEMINI_MODEL = model; });
  await ai.analyze(Buffer.alloc(640), sensor, [], [], signal);
  assert.equal(captured.generationConfig.thinkingConfig.thinkingBudget, 0);
  assert.equal(captured.generationConfig.maxOutputTokens, 768);
  assert.equal(captured.generationConfig.responseMimeType, 'application/json');
  assert.equal(captured.generationConfig.responseSchema.type, 'OBJECT');
  assert.equal(captured.generationConfig.responseFormat, undefined);
  reply = { ...reply, intent: 'run_shell' };
  await assert.rejects(ai.analyze(Buffer.alloc(640), sensor, [], [], signal));
  reply = { ...reply, intent: 'music_play', trackId: '../../secret' };
  await assert.rejects(ai.analyze(Buffer.alloc(640), sensor, [], [], signal), /Unknown track/);
});

test('local provider routes only clear Vietnamese LED commands without asking the model', async t => {
  const originalFetch = globalThis.fetch;
  const provider = process.env.AI_PROVIDER;
  const ollamaUrl = process.env.OLLAMA_URL;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (provider === undefined) delete process.env.AI_PROVIDER; else process.env.AI_PROVIDER = provider;
    if (ollamaUrl === undefined) delete process.env.OLLAMA_URL; else process.env.OLLAMA_URL = ollamaUrl;
  });
  process.env.AI_PROVIDER = 'ollama';
  process.env.OLLAMA_URL = 'http://ollama.test';
  let modelCalls = 0;
  globalThis.fetch = async () => {
    modelCalls++;
    return new Response(JSON.stringify({ message: { content: JSON.stringify({
      transcript: 'Đèn đã bật chưa?', language: 'vi', intent: 'chat',
      reply: 'Đại ca muốn em bật hay tắt đèn ạ?', trackId: '',
    }) } }));
  };
  const ai = new AiotService(), signal = new AbortController().signal;
  const off = await ai.analyzeText('Đại ca ơi, tắt đèn đi', undefined, [], [], signal);
  assert.equal(off.intent, 'led_off');
  assert.equal(off.reply, 'Em đã tắt đèn, đại ca.');
  const on = await ai.analyzeText('Mở cái đèn lên', undefined, [], [], signal);
  assert.equal(on.intent, 'led_on');
  const environment = await ai.analyzeText('Nhiệt độ và độ ẩm trong phòng là bao nhiêu?',
    { temperature: 27.4, humidity: 61.2, receivedAt: Date.now() }, [], [], signal);
  assert.equal(environment.intent, 'environment');
  assert.equal(environment.reply, 'Em đo được 27,4 độ C, độ ẩm 61,2 phần trăm, đại ca.');
  const tracks = [{ id: 'mp4-nhac-thu-gian', title: 'Nhạc thư giãn' }];
  const play = await ai.analyzeText('Đại ca ơi, phát bài nhạc thư giãn', undefined, [], tracks, signal);
  assert.equal(play.intent, 'music_play');
  assert.equal(play.trackId, 'mp4-nhac-thu-gian');
  const stop = await ai.analyzeText('Dừng nhạc đi', undefined, [], tracks, signal);
  assert.equal(stop.intent, 'music_stop');
  assert.equal(modelCalls, 0, 'deterministic LED and sensor requests should bypass small-model classification');
  const question = await ai.analyzeText('Đèn đã bật chưa?', undefined, [], [], signal);
  assert.equal(question.intent, 'chat');
  const negation = await ai.analyzeText('Đừng tắt đèn', undefined, [], [], signal);
  assert.equal(negation.intent, 'chat');
  assert.equal(modelCalls, 2, 'questions and negations must not be treated as LED commands');
});

test('TTS parses WAV and legacy raw PCM and rejects compressed audio', async t => {
  const original = globalThis.fetch;
  const provider = process.env.AI_PROVIDER;
  const apiKey = process.env.GEMINI_API_KEY;
  process.env.AI_PROVIDER = 'gemini';
  process.env.GEMINI_API_KEY = 'test-only-key';
  t.after(() => {
    globalThis.fetch = original;
    if (provider === undefined) delete process.env.AI_PROVIDER; else process.env.AI_PROVIDER = provider;
    if (apiKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = apiKey;
  });
  let inlineData = { mimeType: 'audio/wav', data: wavFromPcm(Buffer.alloc(4800), 24000).toString('base64') };
  globalThis.fetch = async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData }] } }] }));
  const ai = new AiotService(), signal = new AbortController().signal;
  assert.equal((await ai.speak('Xin chào', signal)).length, 3200);
  inlineData = { mimeType: 'audio/L16;codec=pcm;rate=24000', data: Buffer.alloc(4800).toString('base64') };
  assert.equal((await ai.speak('Hello', signal)).length, 3200);
  inlineData = { ...inlineData, mimeType: 'audio/mp3' };
  await assert.rejects(ai.speak('Unsupported audio', signal), /Unsupported/);
});

test('speech cache reuses successful audio but a cancelled caller does not block later callers', async t => {
  const original = globalThis.fetch;
  const provider = process.env.AI_PROVIDER;
  const apiKey = process.env.GEMINI_API_KEY;
  process.env.AI_PROVIDER = 'gemini';
  process.env.GEMINI_API_KEY = 'test-only-key';
  t.after(() => {
    globalThis.fetch = original;
    if (provider === undefined) delete process.env.AI_PROVIDER; else process.env.AI_PROVIDER = provider;
    if (apiKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = apiKey;
  });
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: {
      mimeType: 'audio/wav', data: wavFromPcm(Buffer.alloc(3200)).toString('base64'),
    } }] } }] }));
  };
  const ai = new AiotService();
  const phrase = 'Câu kiểm thử bộ nhớ đệm.';
  const cancel = new AbortController(); cancel.abort();
  await assert.rejects(ai.speak(phrase, cancel.signal));
  const signal = new AbortController().signal;
  const first = await ai.speak(phrase, signal);
  assert.deepEqual(await ai.speak(phrase, signal), first);
  assert.equal(calls, 1);
});
