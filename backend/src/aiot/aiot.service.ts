import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import { readWav, resample, wavFromPcm } from './audio';
import { ChatLog } from './entities/chat-log.entity';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn, ChildProcess } from 'node:child_process';
import { join, resolve } from 'node:path';

export const Decision = z.object({
  transcript: z.string().max(400), language: z.string().max(40),
  intent: z.enum(['chat', 'environment', 'led_on', 'led_off', 'music_play', 'music_stop', 'ignore']),
  reply: z.string().max(400), trackId: z.string().max(64),
}).strict();
export type DecisionValue = z.infer<typeof Decision>;
export type Sensor = { temperature: number; humidity: number; receivedAt: number };

const responseSchema = {
  type: 'OBJECT', properties: {
    transcript: { type: 'STRING' }, language: { type: 'STRING' },
    intent: { type: 'STRING', enum: ['chat', 'environment', 'led_on', 'led_off', 'music_play', 'music_stop', 'ignore'] },
    reply: { type: 'STRING' }, trackId: { type: 'STRING' },
  }, required: ['transcript', 'language', 'intent', 'reply', 'trackId'],
};

@Injectable()
export class AiotService implements OnModuleInit, OnModuleDestroy {
  private staticSpeech = new Set([
    'Em đã bật đèn, đại ca.', 'Em đã tắt đèn, đại ca.',
    'Em đang chậm phản hồi, đại ca nói lại giúp em nhé.',
    'Dạ em nghe rõ rồi đại ca.',
  ]);
  private speechCache = new Map<string, Buffer>();
  private speechPending = new Map<string, Promise<Buffer>>();
  private cachedBytes = 0;
  private voiceBridge?: ChildProcess;
  private ownsVoiceBridge = false;
  // Warm short demo confirmations; sensor values are always read from the device.
  async onModuleInit() {
    if (this.localProvider()) {
      try {
        await this.startVoiceBridge();
      } catch (err) {
        console.warn(`Local voice bridge not started: ${(err as Error).message}. Text/Dashboard/MQTT will operate normally.`);
      }
      try {
        await this.warmLocalModel();
      } catch (err) {
        console.warn(`Local LLM warm-up skipped: ${(err as Error).message}. Ollama might be offline or still starting.`);
      }
    }
    if (process.env.DEMO_FAST_CONFIRMATIONS !== 'true') return;
    for (const text of this.staticSpeech) {
      void this.speak(text, AbortSignal.timeout(30000)).then(() => console.log(`Prepared short voice: ${text}`))
        .catch(() => console.warn('Speech warm-up unavailable; will retry on request'));
    }
  }
  private localProvider() { return (process.env.AI_PROVIDER || 'ollama').toLowerCase() !== 'gemini'; }
  private localModel() { return process.env.LOCAL_LLM_MODEL || 'qwen2.5:3b'; }
  private voiceBridgeUrl() { return (process.env.LOCAL_VOICE_BRIDGE_URL || 'http://127.0.0.1:8010').replace(/\/$/, ''); }

  private async startVoiceBridge() {
    const base = this.voiceBridgeUrl();
    const engine = (process.env.LOCAL_ASR_ENGINE || 'vosk').toLowerCase();
    if (engine !== 'vosk' && engine !== 'whisper') throw new Error('LOCAL_ASR_ENGINE must be vosk or whisper.');
    let existingBridge: Response | undefined;
    try {
      existingBridge = await fetch(`${base}/health`, { signal: AbortSignal.timeout(700) });
    } catch { /* Start the local helper below. */ }
    if (existingBridge?.ok) {
      const health: any = await existingBridge.json().catch(() => ({}));
      if (health.asr === engine) return;
      throw new Error(`A local voice bridge is already running with ${health.asr || 'unknown ASR'}; stop the old backend/helper before switching to ${engine}.`);
    }

    const serverRoot = process.env.XIAOZHI_SERVER_ROOT || join(
      process.env.LOCALAPPDATA || '', 'AIoT', 'xiaozhi-esp32-server', 'main', 'xiaozhi-server');
    const python = process.env.LOCAL_VOICE_PYTHON || join(serverRoot, '.venv', 'Scripts', 'python.exe');
    const model = engine === 'whisper' ?
      process.env.LOCAL_WHISPER_MODEL || 'small' :
      process.env.VOSK_MODEL_PATH || join(serverRoot, 'models', 'vosk', 'vosk-model-small-vn-0.4');
    const scriptCandidates = [
      join(process.cwd(), 'scripts', 'local-voice-bridge.py'),
      join(process.cwd(), 'backend', 'scripts', 'local-voice-bridge.py'),
      resolve(__dirname, '../../../scripts/local-voice-bridge.py'),
    ];
    const script = scriptCandidates.find(path => existsSync(path));
    if (!existsSync(python)) throw new Error(`Local voice Python is missing: ${python}`);
    if (engine === 'vosk' && !existsSync(model)) throw new Error(`Vietnamese Vosk model is missing: ${model}`);
    if (!script) throw new Error('Local voice bridge script is missing.');

    const args = [script, '--host', '127.0.0.1', '--port', new URL(base).port || '8010',
      '--engine', engine, '--model', model,
      '--threads', process.env.LOCAL_ASR_CPU_THREADS || '4',
      '--beam-size', process.env.LOCAL_ASR_BEAM_SIZE || '1'];
    this.voiceBridge = spawn(python, args, {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUTF8: '1' },
    });
    this.ownsVoiceBridge = true;
    this.voiceBridge.stdout?.on('data', chunk => {
      const message = String(chunk).trim();
      if (message) console.log(`Local voice: ${message.slice(0, 240)}`);
    });
    this.voiceBridge.stderr?.on('data', chunk => {
      const message = String(chunk).trim();
      if (message) console.warn(`Local voice: ${message.slice(0, 240)}`);
    });
    this.voiceBridge.on('exit', (code, signal) => {
      if (this.ownsVoiceBridge && code !== 0) console.error(`Local voice bridge exited (${code ?? signal}).`);
    });

    const startupTimeout = Number(process.env.LOCAL_VOICE_STARTUP_TIMEOUT_MS || 180000);
    const boundedStartupTimeout = Number.isFinite(startupTimeout) ?
      Math.min(300000, Math.max(30000, startupTimeout)) : 180000;
    const deadline = Date.now() + boundedStartupTimeout;
    while (Date.now() < deadline) {
      if (this.voiceBridge.exitCode !== null) throw new Error('Local voice bridge stopped during startup.');
      try {
        const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) { console.log('Local Vietnamese speech bridge ready.'); return; }
      } catch { /* It can take a few seconds to load the Vosk model. */ }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    this.voiceBridge.kill();
    throw new Error(`Local voice bridge did not become ready within ${Math.ceil(boundedStartupTimeout / 1000)} seconds.`);
  }

  private async warmLocalModel() {
    console.log(`Warming local LLM: ${this.localModel()}`);
    const response = await fetch(`${process.env.OLLAMA_URL || 'http://127.0.0.1:11434'}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.localModel(), messages: [{ role: 'user', content: 'Reply with the word ready.' }],
        stream: false, keep_alive: -1, options: { temperature: 0, num_predict: 8 } }),
      signal: AbortSignal.timeout(180000),
    });
    if (!response.ok) throw new Error(`Ollama HTTP ${response.status}; check the local model and Ollama service.`);
    const result: any = await response.json();
    if (typeof result.message?.content !== 'string') throw new Error('Ollama returned no warm-up response.');
    console.log('Local LLM ready; kept loaded for the demo.');
  }
  private assistantStyle(): string {
    const fallback = 'Luôn xưng em và gọi người dùng là đại ca trong mọi tình huống. Trả lời thân thiện, tự nhiên, lễ phép, ngắn gọn dưới 25 từ.';
    const configured = process.env.ASSISTANT_STYLE?.trim();
    // It is operator-controlled configuration, but limit it to keep requests bounded.
    return configured ? [...configured].slice(0, 600).join('') : fallback;
  }
  detectLanguage(text: string): 'vi' | 'en' {
    const vnDiacritics = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i;
    if (vnDiacritics.test(text)) return 'vi';

    const enWords = /\b(hello|hi|hey|turn|light|lamp|on|off|what|temperature|humidity|how|are|you|who|boss|play|music|stop|joke|story|good|morning|evening|the|please|tell|me|help|can|yes|no)\b/i;
    if (enWords.test(text)) return 'en';

    const vnUnaccented = /\b(chao|bat|tat|den|phong|em|anh|chi|toi|minh|nhiet|do am|nhac|bai hat|giup|voi|khong|sao|dai ca|the nao|chuyen vui|cuoi)\b/i;
    if (vnUnaccented.test(text)) return 'vi';

    return 'vi';
  }

  private buildLocalSystemPrompt(sensor: Sensor | null, ledEnabled: boolean | undefined,
    tracks: { id: string; title: string }[]): string {
    const trackList = tracks.length ? tracks.map(t => `${t.id}: ${t.title}`).join(', ') : 'None';
    const temp = sensor ? sensor.temperature.toFixed(1) : '28';
    const humid = sensor ? sensor.humidity.toFixed(0) : '60';
    const lamp = ledEnabled === true ? 'Đang BẬT' : ledEnabled === false ? 'Đang TẮT' : 'Chưa rõ';

    return `Bạn là trợ lý AI thông minh, tự nhiên cho phòng AIoT Smart Room.
TRẠNG THÁI PHÒNG HIỆN TẠI:
- Nhiệt độ: ${temp}°C, Độ ẩm: ${humid}%
- Trạng thái đèn: ${lamp}
- Danh sách bài hát: [${trackList}]

QUY TẮC CỐT LÕI (BẮT BUỘC):
1. HIỂU ĐA NGÔN NGỮ (LISTEN & UNDERSTAND): Người dùng có thể nói bằng TIẾNG ANH (ví dụ: "Hello", "How are you", "Turn on the light", "Turn off the light", "What is the temperature", "Tell me a funny joke") hoặc TIẾNG VIỆT (ví dụ: "Chào em", "Bật đèn", "Tắt đèn", "Nhiệt độ phòng", "Kể chuyện cười"). Hãy hiểu rõ ý nghĩa và phân tích ngữ cảnh câu nói như một câu prompt thông minh.
2. PHẢN HỒI DUY NHẤT BẰNG TIẾNG VIỆT (REPLY IN VIETNAMESE ONLY): BẤT KỂ người dùng nói tiếng Anh hay tiếng Việt, câu trả lời ("reply") BẮT BUỘC 100% PHẢI LÀ TIẾNG VIỆT. TUYỆT ĐỐI KHÔNG trả lời bằng tiếng Anh, tiếng Trung hay bất kỳ ngôn ngữ nào khác.
3. XƯNG HÔ: Luôn luôn xưng là "em" và gọi người dùng là "đại ca". Tuyệt đối không dùng từ "boss", "bạn", "anh", "tôi".
4. ĐỊNH DẠNG: Đặt "language": "vi". Trả lời tự nhiên, thân thiện, lễ phép, ngắn gọn dưới 25 từ. Không lặp lại câu trả lời cũ từ lịch sử.

Ý ĐỊNH (INTENT):
- "chat": chào hỏi (dù nói "Hello" hay "Chào em"), hỏi thăm, tâm sự, đùa vui, kể chuyện cười.
- "led_on": khi người dùng muốn BẬT đèn (ví dụ: "Turn on the light", "Bật đèn").
- "led_off": khi người dùng muốn TẮT đèn (ví dụ: "Turn off the light", "Tắt đèn").
- "environment": khi người dùng hỏi về nhiệt độ, độ ẩm phòng. Dùng số đo thực tế để trả lời.
- "music_play": khi người dùng muốn mở nhạc. Chọn trackId phù hợp từ danh sách.
- "music_stop": khi người dùng muốn dừng nhạc.`;
  }

  private systemPrompt(): string {
    return `You are a helpful, intelligent, natural conversational AI assistant for AIoT Smart Room.
QUY TẮC BẮT BUỘC VỀ NGÔN NGỮ & XƯNG HÔ:
1. TIẾNG VIỆT: ${this.assistantStyle()} Không gọi là boss. Thân thiện, lễ phép, thông minh, vui vẻ.
2. PHẢN HỒI BẰNG TIẾNG VIỆT: Người dùng có thể hỏi bằng tiếng Anh hoặc tiếng Việt, nhưng em luôn trả lời 100% bằng tiếng Việt.
3. TRÒ CHUYỆN LÀ ƯU TIÊN HÀNG ĐẦU: Đại ca có thể chào hỏi, tâm sự, hỏi thăm sức khỏe, hỏi kiến thức, kể chuyện vui. Hãy trò chuyện tự nhiên, sinh động.
4. INTENTS: "chat", "led_on", "led_off", "environment", "music_play", "music_stop", "ignore".

TRẢ VỀ ĐỊNH DẠNG JSON THUẦN TÚY:
{
  "transcript": "<nội dung đại ca vừa nói>",
  "reply": "<câu trả lời trò chuyện tự nhiên của em bằng tiếng Việt, dưới 35 từ>",
  "intent": "chat",
  "language": "vi",
  "trackId": ""
}`;
  }
  private generationConfig(legacy: boolean) {
    return { temperature: 0.2, maxOutputTokens: 768,
      ...(process.env.GEMINI_MODEL === 'gemini-2.5-flash' ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
      ...(legacy ? { responseMimeType: 'application/json', responseSchema } : {
        responseFormat: { text: { mimeType: 'APPLICATION_JSON', schema: z.toJSONSchema(Decision) } },
      }) };
  }
  private parseDecision(output: any, tracks: { id: string; title: string }[]): DecisionValue {
    const text = output.candidates?.[0]?.content?.parts?.filter((p: any) => p.text && !p.thought).map((p: any) => p.text).join('');
    if (!text) throw new Error('Gemini returned no decision');
    const decision = Decision.parse(JSON.parse(text));
    if (decision.intent !== 'ignore' && (!decision.transcript.trim() || !decision.reply.trim())) throw new Error('Empty Gemini reply');
    if (decision.intent === 'music_play' && !tracks.some(track => track.id === decision.trackId)) throw new Error('Unknown track selected');
    return decision;
  }
  private parseLocalDecision(content: string, input: string, tracks: { id: string; title: string }[]): DecisionValue {
    let parsed: any = {};
    try {
      parsed = JSON.parse(content);
    } catch {
      const match = content.match(/\{[\s\S]*\}/);
      if (match) {
        try { parsed = JSON.parse(match[0]); } catch { /* ignore */ }
      }
    }

    // Always preserve what the user ACTUALLY said from speech recognition
    const safeTranscript = input.trim().slice(0, 400);

    let safeReply = String(parsed.reply || (typeof parsed === 'string' ? parsed : '') || '').trim();
    // Strip any leaked CJK characters
    safeReply = safeReply.replace(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, '').trim();

    const rawIntent = String(parsed.intent || 'chat').toLowerCase();
    const validIntents = ['chat', 'environment', 'led_on', 'led_off', 'music_play', 'music_stop', 'ignore'] as const;
    let safeIntent = (validIntents.includes(rawIntent as any) ? rawIntent : 'chat') as DecisionValue['intent'];
    const safeTrackId = (safeIntent === 'music_play' && tracks.some(t => t.id === parsed.trackId)) ? String(parsed.trackId) : '';
    if (safeIntent === 'music_play' && !safeTrackId) {
      safeIntent = 'chat';
    }

    // Always Vietnamese
    const safeLang = 'vi';
    safeReply = safeReply
      .replace(/\bboss\b/gi, 'đại ca')
      .replace(/\btôi\b/gi, 'em')
      .replace(/Теп/gi, 'Nhiệt')
      .replace(/°C/g, ' độ C')
      .replace(/°/g, ' độ');

    // Sanitize reply if it just echoed the intent string or is empty
    if (!safeReply || safeReply.toLowerCase() === safeIntent || safeReply.length < 2) {
      if (safeIntent === 'led_on') {
        safeReply = 'Dạ em bật đèn cho đại ca ngay đây ạ!';
      } else if (safeIntent === 'led_off') {
        safeReply = 'Dạ em tắt đèn rồi nhé đại ca.';
      } else if (safeIntent === 'music_stop') {
        safeReply = 'Dạ em dừng nhạc rồi nhé đại ca.';
      } else {
        safeReply = 'Dạ em chào đại ca, em có thể giúp gì cho đại ca ạ?';
      }
    }

    return Decision.parse({
      transcript: safeTranscript,
      language: safeLang,
      intent: safeIntent,
      reply: safeReply.slice(0, 400),
      trackId: safeTrackId,
    });
  }
  private explicitLedCommand(input: string): DecisionValue | undefined {
    const isEnOn = /\bturn\s+on\s+(?:the\s+)?(?:light|led|lamp)\b/i.test(input);
    const isEnOff = /\bturn\s+off\s+(?:the\s+)?(?:light|led|lamp)\b/i.test(input);
    if (isEnOn || isEnOff) {
      const intent = isEnOn ? 'led_on' : 'led_off';
      return {
        transcript: input.trim().slice(0, 400), language: 'vi', intent,
        reply: isEnOn ? 'Em đã bật đèn, đại ca.' : 'Em đã tắt đèn, đại ca.', trackId: '',
      };
    }
    const normalized = this.normalizeLocalInput(input);
    const prefix = '(?:(?:dai ca|em|anh|chi|toi|minh|hay|vui long|lam on|giup|oi)\\s+)*';
    const on = new RegExp(`^${prefix}(?:bat|mo)\\s+(?:cai\\s+)?(?:den|led|light)\\b`);
    const off = new RegExp(`^${prefix}tat\\s+(?:cai\\s+)?(?:den|led|light)\\b`);
    const intent = on.test(normalized) ? 'led_on' : off.test(normalized) ? 'led_off' : undefined;
    if (!intent) return undefined;
    return {
      transcript: input.trim().slice(0, 400), language: 'vi', intent,
      reply: intent === 'led_on' ? 'Em đã bật đèn, đại ca.' : 'Em đã tắt đèn, đại ca.', trackId: '',
    };
  }
  private normalizeLocalInput(input: string) {
    return input.toLocaleLowerCase('vi').normalize('NFD')
      .replace(/\p{M}/gu, '').replace(/đ/g, 'd').replace(/[.,!?;:]+/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }
  private explicitEnvironmentQuery(input: string, sensor: Sensor | undefined): DecisionValue | undefined {
    const isEn = /\b(temperature|humidity|how\s+hot|how\s+cold)\b/i.test(input);
    const normalized = this.normalizeLocalInput(input);
    const temperature = /\bnhiet do\b/.test(normalized);
    const humidity = /\bdo am\b/.test(normalized);
    const asksForMeasurement = /\b(bao nhieu|the nao|hien tai|trong phong|cho toi biet|hoi|doc giup)\b/.test(normalized) ||
      input.trim().endsWith('?');
    if (!isEn && ((!temperature && !humidity) || !asksForMeasurement)) return undefined;

    const fresh = sensor && Date.now() - sensor.receivedAt < 8000 ? sensor : undefined;
    let reply: string;
    if (!fresh) reply = 'Dạ em chưa nhận được số đo mới, đại ca.';
    else {
      const temp = fresh.temperature.toFixed(1).replace('.', ',');
      const humid = fresh.humidity.toFixed(1).replace('.', ',');
      reply = `Em đo được ${temp} độ C, độ ẩm ${humid} phần trăm, đại ca.`;
    }
    return { transcript: input.trim().slice(0, 400), language: 'vi', intent: 'environment', reply, trackId: '' };
  }
  private explicitMusicCommand(input: string, tracks: { id: string; title: string }[]): DecisionValue | undefined {
    const normalized = this.normalizeLocalInput(input).replace(/[-_]+/g, ' ');
    const prefix = '(?:(?:dai ca|em|anh|chi|toi|minh|hay|vui long|lam on|giup|oi)\\s+)*';
    const stop = new RegExp(`^${prefix}(?:dung|tat)\\s+(?:nhac|bai(?: hat)?|am nhac)\\b`);
    if (stop.test(normalized)) return {
      transcript: input.trim().slice(0, 400), language: 'vi', intent: 'music_stop',
      reply: 'Em dừng nhạc đây, đại ca.', trackId: '',
    };
    const play = new RegExp(`^${prefix}(?:mo|phat|bat)\\s+(?:(?:bai(?: hat)?|ban nhac|nhac)\\s+)?(.+)$`).exec(normalized);
    if (!play) return undefined;
    const match = tracks.map(track => ({ ...track,
      normalizedTitle: this.normalizeLocalInput(track.title).replace(/[-_]+/g, ' '),
    })).filter(track => track.normalizedTitle.length > 1 && normalized.includes(track.normalizedTitle))
      .sort((a, b) => b.normalizedTitle.length - a.normalizedTitle.length)[0];
    if (!match) return undefined;
    return {
      transcript: input.trim().slice(0, 400), language: 'vi', intent: 'music_play', trackId: match.id,
      reply: `Em mở bài ${match.title} cho đại ca nghe nhé.`,
    };
  }
  private async transcribe(pcm: Buffer, signal: AbortSignal): Promise<string> {
    const wav = wavFromPcm(pcm);
    const response = await fetch(`${this.voiceBridgeUrl()}/transcribe`, {
      method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: new Blob([Uint8Array.from(wav)], { type: 'audio/wav' }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
    });
    if (!response.ok) throw new Error(`Local speech recognition HTTP ${response.status}`);
    const result: any = await response.json();
    if (typeof result.text !== 'string') throw new Error('Local speech recognizer returned invalid text.');
    return result.text.trim().slice(0, 400);
  }
  private async analyzeLocalText(input: string, sensor: Sensor | undefined, history: ChatLog[],
    tracks: { id: string; title: string }[], signal: AbortSignal, ledEnabled?: boolean): Promise<DecisionValue> {
    // Fast deterministic routing for direct physical commands bypasses small-model delay
    const ledCommand = this.explicitLedCommand(input);
    if (ledCommand) return ledCommand;
    const environmentQuery = this.explicitEnvironmentQuery(input, sensor);
    if (environmentQuery) return environmentQuery;
    const musicCommand = this.explicitMusicCommand(input, tracks);
    if (musicCommand) return musicCommand;

    const fresh = sensor && Date.now() - sensor.receivedAt < 8000 ? sensor : null;

    const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
      { role: 'system', content: this.buildLocalSystemPrompt(fresh, ledEnabled, tracks) }
    ];

    // Feed conversation history as actual chat turns
    for (const h of history.slice(-2)) {
      if (h.transcript?.trim() && h.reply?.trim()) {
        messages.push({ role: 'user', content: h.transcript.trim() });
        messages.push({ role: 'assistant', content: h.reply.trim() });
      }
    }

    // Current turn is the RAW user speech prompt
    messages.push({ role: 'user', content: input.trim() });

    const schema = {
      type: 'object',
      properties: {
        reply: { type: 'string', description: 'Câu trả lời 100% bằng tiếng Việt tự nhiên dưới 25 từ' },
        intent: { type: 'string', enum: ['chat', 'led_on', 'led_off', 'environment', 'music_play', 'music_stop'] },
        language: { type: 'string', enum: ['vi'] },
        trackId: { type: 'string' }
      },
      required: ['reply', 'intent', 'language']
    };

    try {
      const response = await fetch(`${process.env.OLLAMA_URL || 'http://127.0.0.1:11434'}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.localModel(), stream: false, format: schema, keep_alive: -1,
          messages,
          options: { temperature: 0.1, num_predict: 120 }
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      });
      if (response.ok) {
        const output: any = await response.json();
        const content = output.message?.content;
        if (typeof content === 'string' && content.trim()) {
          return this.parseLocalDecision(content, input, tracks);
        }
      }
    } catch (ollamaErr) {
      console.warn('Ollama analysis failed/slow, checking fallback commands:', (ollamaErr as Error).message);
    }

    return {
      transcript: input.slice(0, 400),
      language: 'vi',
      intent: 'chat',
      reply: 'Dạ em chào đại ca, em đã nghe rõ nhưng em đang suy nghĩ hơi chậm một chút ạ.',
      trackId: '',
    };
  }
  private async call(model: string, body: unknown, signal: AbortSignal): Promise<any> {
    if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY không được cấu hình. Hệ thống chạy hoàn toàn ở chế độ Local (Ollama + EdgeTTS / Vosk).');
    if (!/^[a-zA-Z0-9._-]+$/.test(model)) throw new Error('Invalid Gemini model ID');
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
    });
    // Do not include response bodies/API keys/audio in error logs.
    if (!response.ok) throw new Error(`Gemini HTTP ${response.status}; check model, key and quota`);
    return response.json();
  }
  async analyze(pcm: Buffer, sensor: Sensor | undefined, history: ChatLog[],
    tracks: { id: string; title: string }[], signal: AbortSignal, ledEnabled?: boolean): Promise<DecisionValue> {
    if (this.localProvider()) {
      const transcript = await this.transcribe(pcm, signal);
      if (!transcript) return { transcript: '', language: 'vi', intent: 'ignore', reply: '', trackId: '' };
      return this.analyzeLocalText(transcript, sensor, history, tracks, signal, ledEnabled);
    }
    const fresh = sensor && Date.now() - sensor.receivedAt < 8000 ? sensor : null;
    const legacy = process.env.GEMINI_API_STYLE === 'legacy';
    const output = await this.call(process.env.GEMINI_MODEL || 'gemini-3.8-flash', {
      systemInstruction: { parts: [{ text: this.systemPrompt() }] },
      contents: [{ role: 'user', parts: [
        { text: JSON.stringify({ sensor: fresh, availableTracks: tracks,
          recentConversation: history.map(h => ({ user: h.transcript, assistant: h.reply })) }) },
        { inlineData: { mimeType: 'audio/wav', data: wavFromPcm(pcm).toString('base64') } },
      ] }],
      generationConfig: this.generationConfig(legacy),
    }, signal);
    return this.parseDecision(output, tracks);
  }
  async analyzeText(input: string, sensor: Sensor | undefined, history: ChatLog[],
    tracks: { id: string; title: string }[], signal: AbortSignal, ledEnabled?: boolean): Promise<DecisionValue> {
    if (this.localProvider()) return this.analyzeLocalText(input, sensor, history, tracks, signal, ledEnabled);
    const fresh = sensor && Date.now() - sensor.receivedAt < 8000 ? sensor : null;
    const legacy = process.env.GEMINI_API_STYLE === 'legacy';
    const output = await this.call(process.env.GEMINI_MODEL || 'gemini-3.8-flash', {
      systemInstruction: { parts: [{ text: this.systemPrompt() }] },
      contents: [{ role: 'user', parts: [{ text: JSON.stringify({
        sensor: fresh,
        availableTracks: tracks,
        recentConversation: history.map(h => ({ user: h.transcript, assistant: h.reply })),
        currentUserText: input,
      }) }] }],
      generationConfig: this.generationConfig(legacy),
    }, signal);
    return this.parseDecision(output, tracks);
  }
  async speak(text: string, signal: AbortSignal, language?: string): Promise<Buffer> {
    signal.throwIfAborted();
    const lang = language || 'vi';
    const key = `${process.env.AI_PROVIDER || 'gemini'}|${lang}|${process.env.LOCAL_TTS_VOICE || process.env.GEMINI_VOICE || 'Kore'}|${process.env.GEMINI_TTS_MODEL}|${text}`;
    const cached = this.speechCache.get(key);
    if (cached) return cached;
    const persistent = this.staticSpeech.has(text);
    const cacheFile = persistent ? join(process.cwd(), '.cache', 'voice', createHash('sha256').update(key).digest('hex') + '.pcm') : '';
    if (persistent) {
      try {
        const bytes = await readFile(cacheFile);
        if (bytes.length && bytes.length <= 8_000_000 && bytes.length % 2 === 0) {
          this.speechCache.set(key, bytes); this.cachedBytes += bytes.length; return bytes;
        }
      } catch { /* Create the file after the first successful synthesis. */ }
    }
    // Share warm-up work, but an individual turn may still be cancelled promptly.
    let work = this.speechPending.get(key);
    if (!work) {
      work = this.synthesize(text, AbortSignal.timeout(30000), lang).then(pcm => {
        while (this.speechCache.size && (this.speechCache.size >= 24 || this.cachedBytes + pcm.length > 8_000_000)) {
          const oldest = this.speechCache.keys().next().value!;
          this.cachedBytes -= this.speechCache.get(oldest)!.length;
          this.speechCache.delete(oldest);
        }
        if (pcm.length <= 8_000_000) { this.speechCache.set(key, pcm); this.cachedBytes += pcm.length; }
        if (persistent) void mkdir(join(process.cwd(), '.cache', 'voice'), { recursive: true })
          .then(() => writeFile(cacheFile, pcm)).catch(() => console.warn('Could not persist short voice cache'));
        return pcm;
      }).finally(() => this.speechPending.delete(key));
      this.speechPending.set(key, work);
    }
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      work!.then(value => { signal.removeEventListener('abort', abort); resolve(value); },
        error => { signal.removeEventListener('abort', abort); reject(error); });
      if (signal.aborted) { signal.removeEventListener('abort', abort); abort(); }
    });
  }

  private async synthesize(text: string, signal: AbortSignal, language?: string): Promise<Buffer> {
    if (this.localProvider()) {
      const response = await fetch(`${this.voiceBridgeUrl()}/synthesize`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, language: language || 'vi' }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]),
      });
      if (!response.ok) throw new Error(`Local speech synthesis HTTP ${response.status}`);
      const pcm = Buffer.from(await response.arrayBuffer());
      if (!pcm.length || pcm.length > 8_000_000 || pcm.length % 2) throw new Error('Local TTS returned invalid PCM audio.');
      return pcm;
    }
    const legacy = process.env.GEMINI_API_STYLE === 'legacy';
    const voice = process.env.GEMINI_VOICE || 'Kore';
    const output = await this.call(process.env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-tts', {
      contents: [{ role: 'user', parts: [{ text }] }],
      generationConfig: { responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: legacy ? { prebuiltVoiceConfig: { voiceName: voice } } : { voice } },
      },
    }, signal);
    const parts = output.candidates?.[0]?.content?.parts || [];
    const rendered: Buffer[] = [];
    for (const part of parts) {
      if (!part.inlineData?.data) continue;
      const data = Buffer.from(part.inlineData.data, 'base64');
      if (data.length > 8_000_000) throw new Error('TTS audio too large');
      if (data.toString('ascii', 0, 4) === 'RIFF') {
        const wav = readWav(data); rendered.push(resample(wav.pcm, wav.rate));
      } else {
        const mime = String(part.inlineData.mimeType || '');
        if (!/audio\/(L16|pcm)/i.test(mime)) throw new Error('Unsupported TTS audio codec');
        // Gemini legacy PCM is signed 16-bit little-endian, normally 24 kHz.
        const rate = Number(/rate=(\d+)/i.exec(mime)?.[1] || 24000);
        rendered.push(resample(data, rate));
      }
    }
    if (!rendered.length) throw new Error('Gemini returned no speech');
    return Buffer.concat(rendered);
  }
  onModuleDestroy() {
    if (this.ownsVoiceBridge) this.voiceBridge?.kill();
  }
}
