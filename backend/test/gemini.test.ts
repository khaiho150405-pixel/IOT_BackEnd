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

function useLocalModel(t: any) {
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
  const state = { model: {} as any, calls: 0, lastBody: undefined as any, fail: false };
  globalThis.fetch = async (_url: any, init?: any) => {
    state.calls++;
    state.lastBody = JSON.parse(init.body);
    if (state.fail) throw new Error('connect ECONNREFUSED');
    return new Response(JSON.stringify({ message: { content: JSON.stringify(state.model) } }));
  };
  return state;
}

test('local provider sends every utterance to Qwen and validates its decision', async t => {
  const qwen = useLocalModel(t);
  const ai = new AiotService(), signal = new AbortController().signal;
  const sensor = { temperature: 27.4, humidity: 61.2, receivedAt: Date.now() };

  // Light command: Qwen decides, the reply is the fixed (pre-voiced) confirmation.
  qwen.model = { intent: 'led_off', reply: 'Vâng, em tắt rồi ạ, nhiệt độ 35 độ.', trackId: '' };
  const off = await ai.analyzeText('Đại ca ơi, tắt đèn đi', sensor, [], [], signal, true);
  assert.equal(off.intent, 'led_off');
  assert.equal(off.reply, 'Em đã tắt đèn, đại ca.');
  assert.equal(qwen.calls, 1, 'commands are analysed by Qwen, not bypassed');
  const sent = qwen.lastBody.messages.at(-1).content;
  assert.match(sent, /tắt đèn đi/);
  assert.match(sent, /đèn đang BẬT/);
  assert.match(sent, /27\.4 độ C/);

  // A misheard light word still works when the switching verb is there.
  qwen.model = { intent: 'led_off', reply: 'Dạ.', trackId: '' };
  assert.equal((await ai.analyzeText('Tắt để đi.', sensor, [], [], signal)).intent, 'led_off');

  // Negations and sentences without a switching verb can never actuate.
  qwen.model = { intent: 'led_off', reply: 'Em đã tắt đèn, đại ca.', trackId: '' };
  const negation = await ai.analyzeText('Đừng tắt đèn nhé', sensor, [], [], signal);
  assert.equal(negation.intent, 'chat');
  assert.doesNotMatch(negation.reply, /đã tắt/);
  qwen.model = { intent: 'led_on', reply: 'Em đã bật đèn.', trackId: '' };
  assert.equal((await ai.analyzeText('Hôm nay trời đẹp quá', sensor, [], [], signal)).intent, 'chat');

  // Environment numbers come from the sensor, never from the model.
  qwen.model = { intent: 'environment', reply: 'Phòng đang 35 độ, độ ẩm 90%.', trackId: '' };
  const environment = await ai.analyzeText('Phòng có nóng không?', sensor, [], [], signal);
  assert.equal(environment.reply, 'Em đo được 27,4 độ C, độ ẩm 61,2 phần trăm, đại ca.');

  // Small talk keeps Qwen's own reply, but cannot claim the light changed.
  qwen.model = { intent: 'chat', reply: 'Dạ em khỏe, cảm ơn đại ca.', trackId: '' };
  assert.equal((await ai.analyzeText('Em khỏe không?', sensor, [], [], signal)).reply, 'Dạ em khỏe, cảm ơn đại ca.');
  qwen.model = { intent: 'chat', reply: 'Em đã bật đèn cho đại ca rồi.', trackId: '' };
  assert.doesNotMatch((await ai.analyzeText('Đèn bật chưa?', sensor, [], [], signal)).reply, /đã bật/);

  // Music: real tracks only.
  const tracks = [{ id: 'mp4-nhac-thu-gian', title: 'Nhạc thư giãn' }];
  qwen.model = { intent: 'music_play', reply: 'Ok', trackId: 'mp4-nhac-thu-gian' };
  const play = await ai.analyzeText('Đại ca ơi, phát bài nhạc thư giãn', sensor, [], tracks, signal);
  assert.equal(play.intent, 'music_play');
  assert.equal(play.trackId, 'mp4-nhac-thu-gian');
  qwen.model = { intent: 'music_stop', reply: '', trackId: '' };
  assert.equal((await ai.analyzeText('Dừng nhạc đi', sensor, [], tracks, signal)).intent, 'music_stop');
});

test('local provider falls back to conservative rules when Qwen is unavailable', async t => {
  const qwen = useLocalModel(t);
  qwen.fail = true;
  const ai = new AiotService(), signal = new AbortController().signal;
  assert.equal((await ai.analyzeText('Tắt đèn đi', undefined, [], [], signal)).intent, 'led_off');
  assert.equal((await ai.analyzeText('Mở cái đèn lên', undefined, [], [], signal)).intent, 'led_on');
  assert.equal((await ai.analyzeText('Đừng tắt đèn', undefined, [], [], signal)).intent, 'chat');
  const env = await ai.analyzeText('Nhiệt độ trong phòng bao nhiêu?',
    { temperature: 27.4, humidity: 61.2, receivedAt: Date.now() }, [], [], signal);
  assert.equal(env.intent, 'environment');
});

test('local provider never claims music playback without a real track', async t => {
  const qwen = useLocalModel(t);
  const ai = new AiotService(), signal = new AbortController().signal;

  // Qwen asks to play music but the catalog is empty.
  qwen.model = { intent: 'music_play', reply: 'Em mở nhạc thư giãn nhé.', trackId: '' };
  const empty = await ai.analyzeText('Phát bài nhạc thư giãn', undefined, [], [], signal);
  assert.equal(empty.intent, 'chat');
  assert.match(empty.reply, /chưa có bài nào/);

  // A hallucinated track id lists what is really available.
  const tracks = [{ id: 'lofi', title: 'Lofi chill' }];
  qwen.model = { intent: 'chat', reply: 'Dạ, Em sẽ tìm bài phù hợp.', trackId: '' };
  assert.match((await ai.analyzeText('They are already out here.', undefined, [], [], signal)).reply, /chưa có bài nào/);
  qwen.model = { intent: 'music_play', reply: 'Em mở nhạc cho đại ca nhé.', trackId: 'happy-birthday' };
  const missing = await ai.analyzeText('Mở bài hát Happy Birthday', undefined, [], tracks, signal);
  assert.equal(missing.intent, 'chat');
  assert.equal(missing.trackId, '');
  assert.match(missing.reply, /Lofi chill/);

  // Labelled chat but the reply claims playback (observed with qwen2.5:3b).
  qwen.model = { intent: 'chat', trackId: '', reply: 'Đang phát bài nhạc thư giãn. Nhạc sẽ tự động tắt sau 3 phút.' };
  const claimed = await ai.analyzeText('Cho em nghe gì đó êm dịu', undefined, [], [], signal);
  assert.equal(claimed.intent, 'chat');
  assert.doesNotMatch(claimed.reply, /Đang phát/);

  // Ordinary chat that mentions music is left alone.
  qwen.model = { intent: 'chat', trackId: '', reply: 'Nhạc cổ điển giúp đại ca thư giãn đó ạ.' };
  assert.equal((await ai.analyzeText('Nhạc nào giúp thư giãn?', undefined, [], [], signal)).reply,
    'Nhạc cổ điển giúp đại ca thư giãn đó ạ.');
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

test('local fallback voice audio is not cached, Edge audio is', async t => {
  const original = globalThis.fetch;
  const provider = process.env.AI_PROVIDER;
  process.env.AI_PROVIDER = 'ollama';
  t.after(() => {
    globalThis.fetch = original;
    if (provider === undefined) delete process.env.AI_PROVIDER; else process.env.AI_PROVIDER = provider;
  });
  let engine = 'windows';
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(Buffer.alloc(3200), { headers: { 'x-tts-engine': engine } });
  };
  const ai = new AiotService(), signal = new AbortController().signal;
  const phrase = 'Câu kiểm thử giọng dự phòng.';
  await ai.speak(phrase, signal);
  await ai.speak(phrase, signal);
  assert.equal(calls, 2, 'fallback audio must be synthesized again once Edge may have recovered');
  engine = 'edge';
  await ai.speak(phrase, signal);
  await ai.speak(phrase, signal);
  assert.equal(calls, 3, 'Edge audio is cached');
});

test('local provider asks to repeat badly recognised speech instead of guessing', async t => {
  const qwen = useLocalModel(t);
  const ai = new AiotService(), signal = new AbortController().signal;
  let confidence = 0.5;
  globalThis.fetch = async (url: any, init?: any) => {
    if (String(url).endsWith('/transcribe')) {
      return new Response(JSON.stringify({ text: 'ó con so sánh với lại cùng người lái', language: 'vi', confidence }));
    }
    qwen.calls++;
    return new Response(JSON.stringify({ message: { content: JSON.stringify({ intent: 'led_on', reply: 'Em đã bật đèn.', trackId: '' }) } }));
  };
  const low = await ai.analyze(Buffer.alloc(3200), undefined, [], [], signal);
  assert.equal(low.intent, 'chat');
  assert.equal(low.reply, 'Dạ em nghe chưa rõ, đại ca nói lại giúp em nhé.');
  assert.equal(qwen.calls, 0, 'garbled speech never reaches the command classifier');
  confidence = 0.95;
  await ai.analyze(Buffer.alloc(3200), undefined, [], [], signal);
  assert.equal(qwen.calls, 1, 'confident speech is analysed by Qwen');
});

test('spoken arithmetic is answered exactly, including misheard operator words', async t => {
  const qwen = useLocalModel(t);
  qwen.model = { intent: 'chat', reply: 'Dạ, bằng mười hai ạ.', trackId: '' };
  const ai = new AiotService(), signal = new AbortController().signal;
  const ask = async (q: string) => (await ai.analyzeText(q, undefined, [], [], signal)).reply;
  assert.equal(await ask('một cẩm một bằng máy.'), 'Dạ, 1 cộng 1 bằng 2 đại ca ạ.');
  assert.equal(await ask('một cả một bằng máy.'), 'Dạ, 1 cộng 1 bằng 2 đại ca ạ.');
  assert.equal(await ask('một cọc một bằng máy.'), 'Dạ, 1 cộng 1 bằng 2 đại ca ạ.');
  assert.equal(await ask('ba cộng bốn bằng mấy'), 'Dạ, 3 cộng 4 bằng 7 đại ca ạ.');
  assert.equal(await ask('mười chừ ba còn bằng mấy'), 'Dạ, 10 trừ 3 bằng 7 đại ca ạ.');
  assert.equal(await ask('hai mươi lăm nhân bốn bằng bao nhiêu'), 'Dạ, 25 nhân 4 bằng 100 đại ca ạ.');
  assert.equal(await ask('một trăm linh ba trừ ba bằng mấy'), 'Dạ, 103 trừ 3 bằng 100 đại ca ạ.');
  assert.equal(await ask('7 chia 2 bằng mấy'), 'Dạ, 7 chia 2 bằng 3,5 đại ca ạ.');
  assert.equal(await ask('mười chừ ba còn mấy'), 'Dạ, 10 trừ 3 bằng 7 đại ca ạ.');
  assert.equal(await ask('ba cộng bốn bàn mấy.'), 'Dạ, 3 cộng 4 bằng 7 đại ca ạ.');
  assert.equal(qwen.calls, 0, 'arithmetic never depends on the language model');
  // Ordinary sentences that merely contain number words still go to Qwen.
  await ask('hôm nay anh làm ba bài tập');
  assert.equal(qwen.calls, 1);
});

test('requests are carried out: a clarifying reply is retried and wrapper questions are dropped', async t => {
  const qwen = useLocalModel(t);
  const answers = [
    { intent: 'chat', reply: 'Dạ, đại ca muốn em so sánh tài năng giữa Ronaldo và Messi không đại ca?', trackId: '' },
    { intent: 'chat', reply: 'Dạ, đại ca muốn nghe ạ? Ronaldo ghi bàn mạnh, còn Messi kiến tạo giỏi hơn. Đại ca thấy sao ạ?', trackId: '' },
  ];
  let call = 0;
  globalThis.fetch = async () => {
    qwen.calls++;
    return new Response(JSON.stringify({ message: { content: JSON.stringify(answers[Math.min(call++, 1)]) } }));
  };
  const ai = new AiotService(), signal = new AbortController().signal;
  const decision = await ai.analyzeText('đúng rồi hãy so sánh đi', undefined, [], [], signal);
  assert.equal(qwen.calls, 2, 'one retry after a clarifying question');
  assert.equal(decision.reply, 'Dạ, Ronaldo ghi bàn mạnh, còn Messi kiến tạo giỏi hơn.');

  // English speech from the multilingual model is not rejected by the PhoWhisper threshold.
  call = 1; qwen.calls = 0;
  globalThis.fetch = async (url: any) => String(url).endsWith('/transcribe') ?
    new Response(JSON.stringify({ text: 'Hello.', language: 'en', confidence: 0.41 })) :
    (qwen.calls++, new Response(JSON.stringify({ message: { content: JSON.stringify({ intent: 'chat', reply: 'Dạ, em chào đại ca!', trackId: '' }) } })));
  assert.equal((await ai.analyze(Buffer.alloc(3200), undefined, [], [], signal)).reply, 'Dạ, em chào đại ca!');
});
