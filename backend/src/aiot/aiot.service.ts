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
    'Dạ em nghe chưa rõ, đại ca nói lại giúp em nhé.',
  ]);
  private speechCache = new Map<string, Buffer>();
  private speechPending = new Map<string, Promise<Buffer>>();
  private fallbackSpeech = new WeakSet<Buffer>();
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

  // Static so Ollama can reuse its prompt cache between turns (prompt evaluation
  // was ~3.4 s of each ~5 s turn); the per-turn room state goes in the user message.
  private localIntentPrompt(): string {
    return `Bạn là bộ não của trợ lý giọng nói trong phòng thông minh. Mỗi lượt bạn nhận câu người dùng vừa nói (do máy nhận dạng giọng nói chuyển thành chữ nên có thể sai vài chữ) và trạng thái phòng. Hãy hiểu ý người dùng rồi trả về JSON.

PHÂN LOẠI "intent":
- "led_on": yêu cầu BẬT/MỞ đèn. Ví dụ: "bật đèn lên", "mở đèn giúp anh", "turn on the light", "sáng đèn lên".
- "led_off": yêu cầu TẮT đèn. Ví dụ: "tắt đèn đi", "tắt đèn giùm", "turn off the light".
- "environment": hỏi nhiệt độ, độ ẩm, phòng nóng/lạnh/khô/ẩm thế nào. Ví dụ: "nhiệt độ bao nhiêu", "phòng có nóng không".
- "music_play": muốn nghe/mở/phát nhạc hoặc bài hát.
- "music_stop": muốn dừng/tắt nhạc.
- "chat": mọi thứ khác: chào hỏi, cảm ơn, hỏi thăm, hỏi kiến thức, kể chuyện, câu phủ định ("đừng tắt đèn"), câu hỏi trạng thái ("đèn bật chưa?"), câu vô nghĩa hoặc không rõ.

QUY TẮC:
1. Chỉ chọn led_on/led_off/music_play/music_stop khi người dùng thật sự RA LỆNH làm việc đó. Phân vân thì chọn "chat" và hỏi lại ngắn gọn.
2. Nếu câu bị nhận dạng sai nhẹ nhưng ý rõ (ví dụ "tắt đèn đi" thành "tắt đèn đi ạ", "bật đen lên"), vẫn hiểu đúng ý.
3. "reply": tiếng Việt, xưng "em", gọi người dùng là "đại ca", tự nhiên, thường dưới 25 từ (bài thơ, câu chuyện, giải thích được tới 50 từ). Không bịa số đo, không nói đã làm việc gì nếu không phải lệnh.
4. "trackId": id bài hát trong danh sách khi intent là music_play, ngược lại để "".
5. Hỏi đèn đang bật hay tắt là "chat": trả lời theo trạng thái đèn trong TRẠNG THÁI PHÒNG.
6. TRÒ CHUYỆN ("chat"): nói chuyện như một người bạn thân thiện, dựa vào các lượt trước để giữ mạch câu chuyện. LÀM NGAY điều người dùng yêu cầu, KHÔNG hỏi lại để làm rõ: bảo làm thơ thì đọc luôn một bài thơ, kể chuyện thì kể luôn, hỏi kiến thức thì trả lời luôn; yêu cầu chung chung thì tự chọn một chủ đề phù hợp. Không kết thúc bằng câu hỏi kiểu "đại ca muốn ... gì ạ?". Không nhắc tới đèn, nhiệt độ hay chức năng của mình nếu người dùng không hỏi.
7. CÂU BỊ NGHE NHẦM: máy nhận dạng hay nhầm các chữ có âm gần giống (sai dấu, mất phụ âm đầu, "cộng" thành "cẩm"/"cẩu", "mấy" thành "máy", "kể" thành "hay cả", "cười" thành "cừu"/"gửi"). Trước hết hãy tự đoán câu người dùng THỰC SỰ muốn nói, rồi TRẢ LỜI câu đã đoán đó (với câu hỏi tính toán, kiến thức, chuyện vui... hãy trả lời luôn, không hỏi lại). Trong reply dùng từ đúng, không lặp lại chữ bị nghe nhầm. Chỉ khi không thể đoán ra một ý hợp lý nào mới reply đúng câu: "Dạ em nghe chưa rõ, đại ca nói lại giúp em nhé."
8. ${this.assistantStyle()}

VÍ DỤ:
"bật đèn lên giúp anh" -> {"intent":"led_on","reply":"Em đã bật đèn, đại ca.","trackId":""}
"đèn đang bật hay tắt vậy" (đèn đang TẮT) -> {"intent":"chat","reply":"Dạ đèn đang tắt, đại ca muốn em bật không ạ?","trackId":""}
"hôm nay em khỏe không" -> {"intent":"chat","reply":"Dạ em khỏe ạ, cảm ơn đại ca đã hỏi thăm.","trackId":""}
"kể chuyện cười đi" -> {"intent":"chat","reply":"Dạ, con cá nào không biết bơi? Con cá nướng đó đại ca!","trackId":""}
"hãy làm thơ đi" -> {"intent":"chat","reply":"Dạ, em đọc đại ca nghe: Gió thu nhè nhẹ qua hiên, lá vàng khẽ rụng bên thềm bình yên. Chén trà nóng ấm tay ai, chúc đại ca một ngày dài thảnh thơi.","trackId":""}
"một hai ba" -> {"intent":"chat","reply":"Dạ em nghe rõ rồi, đại ca cần em giúp gì ạ?","trackId":""}
"hôm nay anh mệt quá" -> {"intent":"chat","reply":"Dạ, đại ca làm việc nhiều à? Đại ca nghỉ ngơi một chút, uống nước nhé.","trackId":""}
"hai nhăn ba bằng mấy" (nghĩa là "hai nhân ba bằng mấy") -> {"intent":"chat","reply":"Dạ, hai nhân ba bằng sáu đại ca ạ.","trackId":""}
"hay cả một chuyện cừu" (nghĩa là "kể một chuyện cười") -> {"intent":"chat","reply":"Dạ, sao con mèo không chơi bài? Vì sợ gặp phải con báo đó đại ca!","trackId":""}
"thủ đô việt nam là ở đâu" -> {"intent":"chat","reply":"Dạ, thủ đô của Việt Nam là Hà Nội đại ca ạ.","trackId":""}
"con so sánh với lại cùng người lái tiếng" (không đoán được ý) -> {"intent":"chat","reply":"Dạ em nghe chưa rõ, đại ca nói lại giúp em nhé.","trackId":""}`;
  }
  private localTurnMessage(input: string, sensor: Sensor | null, ledEnabled: boolean | undefined,
    tracks: { id: string; title: string }[]): string {
    const lamp = ledEnabled === true ? 'đang BẬT' : ledEnabled === false ? 'đang TẮT' : 'chưa rõ';
    const climate = sensor ?
      `nhiệt độ ${sensor.temperature.toFixed(1)} độ C, độ ẩm ${sensor.humidity.toFixed(0)}%` : 'chưa có số đo cảm biến';
    const trackList = tracks.length ? tracks.slice(0, 30).map(t => `${t.id}: ${t.title}`).join('; ') : 'trống (chưa có bài nào)';
    return `TRẠNG THÁI PHÒNG: đèn ${lamp}; ${climate}; thư viện nhạc: ${trackList}.\nNGƯỜI DÙNG NÓI: "${input.trim().slice(0, 400)}"`;
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
  private parseLocalDecision(content: string, input: string, tracks: { id: string; title: string }[],
    sensor?: Sensor): DecisionValue {
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
    safeReply = safeReply.replace(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, '')
      // ...and full-width CJK punctuation ("\uff0c\u3002") that qwen sometimes emits in Vietnamese text.
      .replace(/[\u3000-\u303f\uff00-\uffef]+/g, ' ').replace(/\s{2,}/g, ' ').trim();

    const rawIntent = String(parsed.intent || 'chat').toLowerCase();
    const validIntents = ['chat', 'environment', 'led_on', 'led_off', 'music_play', 'music_stop', 'ignore'] as const;
    let safeIntent = (validIntents.includes(rawIntent as any) ? rawIntent : 'chat') as DecisionValue['intent'];
    let safeTrackId = '';

    if (safeIntent === 'led_on' || safeIntent === 'led_off') {
      // Only switch the light when the words actually ask for it (not a negation,
      // not an unrelated sentence the model or speech recognizer got wrong).
      if (this.requestsLightChange(input)) {
        safeReply = safeIntent === 'led_on' ? 'Em đã bật đèn, đại ca.' : 'Em đã tắt đèn, đại ca.';
      } else {
        safeIntent = 'chat';
        safeReply = 'Dạ, đại ca muốn em bật hay tắt đèn ạ?';
      }
    } else if (safeIntent === 'environment') {
      // Numbers always come from the sensor, never from the model.
      safeReply = this.environmentReply(sensor);
    } else if (safeIntent === 'music_play') {
      const track = tracks.find(t => t.id === parsed.trackId);
      if (track) {
        safeTrackId = track.id;
        safeReply = `Em mở bài ${track.title} cho đại ca nghe nhé.`;
      } else {
        // The model wanted music but picked no real track: never let its reply claim playback.
        safeIntent = 'chat';
        safeReply = this.musicUnavailableReply(tracks);
      }
    } else if (safeIntent === 'music_stop') {
      safeReply = 'Em dừng nhạc đây, đại ca.';
    } else if (this.claimsMusicPlayback(safeReply)) {
      // Small local models sometimes label a music request "chat" yet say "Đang phát nhạc...".
      safeReply = this.musicUnavailableReply(tracks);
    } else if (this.claimsLightChange(safeReply)) {
      // A chat reply must not claim the light changed when no command was sent.
      safeReply = 'Dạ, đại ca muốn em bật hay tắt đèn ạ?';
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
  private requestsLightChange(input: string): boolean {
    const text = this.normalizeLocalInput(input);
    if (/\b(dung|khoan|dont|do not|khong duoc|khong can|chua can)\b/.test(text)) return false;
    // A switching verb is required; the word for "light" may be misheard
    // (e.g. "tắt để đi"), and Qwen has already judged the sentence a light command.
    return /\b(bat|tat|mo|turn on|turn off|switch on|switch off)\b/.test(text);
  }
  private claimsLightChange(reply: string): boolean {
    return /\b(da|dang|se)\s+(?:\S+\s+){0,2}(bat|tat|mo)\s+(?:\S+\s+){0,2}den\b/.test(this.normalizeLocalInput(reply));
  }
  private environmentReply(sensor: Sensor | undefined): string {
    const fresh = sensor && Date.now() - sensor.receivedAt < 8000 ? sensor : undefined;
    if (!fresh) return 'Dạ em chưa nhận được số đo mới, đại ca.';
    const temp = fresh.temperature.toFixed(1).replace('.', ',');
    const humid = fresh.humidity.toFixed(1).replace('.', ',');
    return `Em đo được ${temp} độ C, độ ẩm ${humid} phần trăm, đại ca.`;
  }
  /**
   * "một cộng một bằng mấy" -> exact answer. Tolerates what the recogniser does
   * to these words on the INMP441 ("cộng" -> "cẩm"/"cẩu"/"cả", "trừ" -> "chừ",
   * "nhân" -> "nhăn", "mấy" -> "máy") and accepts digits. Integers 0-9999.
   */
  private spokenArithmetic(input: string): DecisionValue | undefined {
    const words = this.normalizeLocalInput(input).replace(/\b(voi|cho|thi|la|con|duoc)\b/g, ' ').split(' ').filter(Boolean);
    const ops: Record<string, { sign: string; name: string }> = {
      cong: { sign: '+', name: 'cộng' }, cam: { sign: '+', name: 'cộng' }, cau: { sign: '+', name: 'cộng' },
      cang: { sign: '+', name: 'cộng' }, ca: { sign: '+', name: 'cộng' }, coc: { sign: '+', name: 'cộng' }, tru: { sign: '-', name: 'trừ' }, chu: { sign: '-', name: 'trừ' },
      nhan: { sign: '*', name: 'nhân' }, chia: { sign: '/', name: 'chia' },
    };
    const opIndex = words.findIndex(w => ops[w]);
    if (opIndex < 1) return undefined;
    const left = this.vietnameseNumber(words.slice(0, opIndex));
    const rightWords = words.slice(opIndex + 1);
    // Require a question ending ("bằng ...", "(còn) mấy", "bao nhiêu") so chat that
    // merely contains numbers is left to Qwen.
    const end = rightWords.findIndex(w => w === 'bang' || w === 'may' || w === 'bao');
    if (end < 1) return undefined;
    const right = this.vietnameseNumber(rightWords.slice(0, end));
    if (left === undefined || right === undefined) return undefined;
    const op = ops[words[opIndex]];
    if (op.sign === '/' && right === 0) {
      return { transcript: input.trim().slice(0, 400), language: 'vi', intent: 'chat', trackId: '',
        reply: 'Dạ, không chia được cho số không đâu đại ca ạ.' };
    }
    const value = op.sign === '+' ? left + right : op.sign === '-' ? left - right :
      op.sign === '*' ? left * right : left / right;
    const shown = Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, '').replace('.', ',');
    return { transcript: input.trim().slice(0, 400), language: 'vi', intent: 'chat', trackId: '',
      reply: `Dạ, ${left} ${op.name} ${right} bằng ${shown} đại ca ạ.` };
  }
  /** Parses diacritic-free Vietnamese number words ("hai muoi lam", "mot tram linh ba") or digits. */
  private vietnameseNumber(tokens: string[]): number | undefined {
    if (!tokens.length || tokens.length > 6) return undefined;
    if (tokens.length === 1 && /^\d{1,4}$/.test(tokens[0])) return Number(tokens[0]);
    const digit: Record<string, number> = { khong: 0, mot: 1, hai: 2, ba: 3, bon: 4, tu: 4, nam: 5, lam: 5,
      sau: 6, bay: 7, tam: 8, chin: 9 };
    let total = 0, current = 0, seen = false;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t in digit) { current += digit[t]; seen = true; continue; }
      if (t === 'muoi') { current = (current === 0 ? 1 : current) * 10; seen = true; continue; }
      if (t === 'tram') { total += (current === 0 ? 1 : current) * 100; current = 0; seen = true; continue; }
      if (t === 'nghin' || t === 'ngan') { total = (total + (current === 0 ? 1 : current)) * 1000; current = 0; seen = true; continue; }
      if (t === 'linh' || t === 'le') continue;
      return undefined;
    }
    return seen ? total + current : undefined;
  }
  /** A reply that only asks the user what they want instead of doing it. */
  private isClarifyingQuestion(reply: string): boolean {
    const text = reply.trim();
    if (!text.endsWith('?')) return false;
    if (text === 'Dạ, đại ca muốn em bật hay tắt đèn ạ?') return false; // deliberate safety question
    const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
    const folded = this.normalizeLocalInput(text);
    return sentences.length <= 2 && text.length < 140 &&
      /\b(muon|can) (em )?\S*.*\b(gi|nao|khong)\b/.test(folded);
  }
  /**
   * Keeps the content of a reply that is wrapped in questions:
   * "Dạ, đại ca muốn nghe chuyện ạ? Có một ... . Đại ca thích không ạ?" -> "Dạ, có một ... ."
   */
  private dropTrailingQuestion(reply: string): string {
    let sentences = reply.trim().split(/(?<=[.!?])\s+/).filter(Boolean);
    const lead = sentences[0] || '';
    const wrapperLead = lead.endsWith('?') && lead.length < 80 &&
      (this.isClarifyingQuestion(lead) || /\b(muon|nhi)\b/.test(this.normalizeLocalInput(lead)));
    if (sentences.length >= 2 && wrapperLead) {
      const rest = sentences.slice(1);
      if (rest.join(' ').length >= 20) {
        if (!/^dạ\b/i.test(rest[0])) rest[0] = `Dạ, ${rest[0]}`;
        sentences = rest;
      }
    }
    if (sentences.length >= 2 && sentences[sentences.length - 1].endsWith('?')) {
      const content = sentences.slice(0, -1);
      if (content.join(' ').length >= 20) sentences = content;
    }
    return sentences.join(' ');
  }
  private musicUnavailableReply(tracks: { id: string; title: string }[]): string {
    if (!tracks.length) return 'Dạ thư viện nhạc chưa có bài nào, đại ca thêm bài vào thư mục music giúp em nhé.';
    const titles = tracks.slice(0, 3).map(track => track.title).join(', ');
    return `Dạ em chưa tìm thấy bài đó. Em đang có: ${titles}${tracks.length > 3 ? '...' : ''}`.slice(0, 400);
  }
  private claimsMusicPlayback(reply: string): boolean {
    const normalized = this.normalizeLocalInput(reply);
    // Also "Em sẽ tìm bài phù hợp" (seen live): promising to find/choose a song.
    return /\b(dang|se|da|em)\s+(?:\S+\s+){0,2}(phat|mo|bat|tim|chon|chuan bi)\s+(?:\S+\s+){0,3}(nhac|bai|ca khuc)\b/.test(normalized);
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
    if (!match) {
      // A clear music request with no matching track gets an honest answer instead of the LLM.
      if (!/\b(nhac|bai hat|ca khuc|music|song)\b/.test(normalized)) return undefined;
      return {
        transcript: input.trim().slice(0, 400), language: 'vi', intent: 'chat',
        reply: this.musicUnavailableReply(tracks), trackId: '',
      };
    }
    return {
      transcript: input.trim().slice(0, 400), language: 'vi', intent: 'music_play', trackId: match.id,
      reply: `Em mở bài ${match.title} cho đại ca nghe nhé.`,
    };
  }
  private async transcribe(pcm: Buffer, signal: AbortSignal): Promise<{ text: string; confidence?: number; language?: string }> {
    const wav = wavFromPcm(pcm);
    const response = await fetch(`${this.voiceBridgeUrl()}/transcribe`, {
      method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: new Blob([Uint8Array.from(wav)], { type: 'audio/wav' }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
    });
    if (!response.ok) throw new Error(`Local speech recognition HTTP ${response.status}`);
    const result: any = await response.json();
    if (typeof result.text !== 'string') throw new Error('Local speech recognizer returned invalid text.');
    const confidence = typeof result.confidence === 'number' && Number.isFinite(result.confidence) ?
      result.confidence : undefined;
    return { text: result.text.trim().slice(0, 400), confidence, language: typeof result.language === 'string' ? result.language : undefined };
  }
  private async analyzeLocalText(input: string, sensor: Sensor | undefined, history: ChatLog[],
    tracks: { id: string; title: string }[], signal: AbortSignal, ledEnabled?: boolean): Promise<DecisionValue> {
    // Spoken arithmetic is answered exactly: qwen2.5:3b got "ba cộng bốn" = 12
    // and "mười trừ ba" = 6 on real (misheard) microphone transcripts.
    const math = this.spokenArithmetic(input);
    if (math) return math;
    // Every utterance is understood by Qwen; code then validates what it decided
    // (real sensor numbers, real tracks, an actual command in the words) so a
    // model or speech-recognition mistake cannot switch devices on its own.
    const fresh = sensor && Date.now() - sensor.receivedAt < 8000 ? sensor : null;
    const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
      { role: 'system', content: this.localIntentPrompt() },
    ];
    for (const h of history.slice(-4)) {
      if (h.transcript?.trim() && h.reply?.trim()) {
        messages.push({ role: 'user', content: `NGƯỜI DÙNG NÓI: "${h.transcript.trim()}"` });
        messages.push({ role: 'assistant', content: JSON.stringify({ reply: h.reply.trim() }) });
      }
    }
    messages.push({ role: 'user', content: this.localTurnMessage(input, fresh, ledEnabled, tracks) });

    const schema = {
      type: 'object',
      properties: {
        intent: { type: 'string', enum: ['chat', 'led_on', 'led_off', 'environment', 'music_play', 'music_stop'] },
        reply: { type: 'string' },
        trackId: { type: 'string' },
      },
      required: ['intent', 'reply', 'trackId'],
    };

    const askQwen = async (conversation: typeof messages): Promise<{ decision: DecisionValue; raw: string }> => {
      const response = await fetch(`${process.env.OLLAMA_URL || 'http://127.0.0.1:11434'}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.localModel(), stream: false, format: schema, keep_alive: -1,
          messages: conversation,
          options: { temperature: 0.1, num_predict: 320 },
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      });
      if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);
      const output: any = await response.json();
      const content = output.message?.content;
      if (typeof content !== 'string' || !content.trim()) throw new Error('Ollama returned no decision');
      return { decision: this.parseLocalDecision(content, input, tracks, fresh ?? undefined), raw: content };
    };

    try {
      const started = Date.now();
      let { decision, raw } = await askQwen(messages);
      // The user wants requests carried out, not clarified. qwen2.5:3b still
      // answers "Dạ, đại ca muốn em ... gì ạ?" despite the prompt, so such a
      // reply gets one retry that tells it to act now.
      if (decision.intent === 'chat' && this.isClarifyingQuestion(decision.reply)) {
        const retry = await askQwen([...messages, { role: 'assistant', content: raw }, { role: 'user', content:
          'KHÔNG hỏi lại. Hãy tự chọn và LÀM NGAY yêu cầu trên của người dùng (trả lời, so sánh, kể, làm thơ, khuyên...), rồi trả JSON.' }]);
        if (retry.decision.intent === 'chat' && !this.isClarifyingQuestion(retry.decision.reply)) decision = retry.decision;
      }
      if (decision.intent === 'chat') decision = { ...decision, reply: this.dropTrailingQuestion(decision.reply) };
      console.log(`[Qwen] ${Date.now() - started} ms intent=${decision.intent} for "${input.trim().slice(0, 80)}"`);
      return decision;
    } catch (ollamaErr) {
      signal.throwIfAborted();
      console.warn('Ollama analysis failed/slow, using rule-based fallback:', (ollamaErr as Error).message);
    }

    // Qwen unavailable: clear commands still work through the conservative rules.
    const fallback = this.explicitLedCommand(input) ?? this.explicitEnvironmentQuery(input, sensor) ??
      this.explicitMusicCommand(input, tracks);
    if (fallback) return fallback;
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
      const { text: transcript, confidence, language } = await this.transcribe(pcm, signal);
      if (!transcript) return { transcript: '', language: 'vi', intent: 'ignore', reply: '', trackId: '' };
      // Badly recognised speech is asked again instead of guessed (no device action,
      // no off-topic answer). Real INMP441 recordings: correct sentences 0.86-1.0,
      // a correct one with an English loanword 0.67, garbage 0.72-0.74 (Qwen asks those again).
      const minConfidence = Number(process.env.ASR_MIN_CONFIDENCE ?? 0.6);
      // Only for PhoWhisper (Vietnamese): the English model scores a correct "Hello" at 0.41.
      if (language !== 'en' && confidence !== undefined && Number.isFinite(minConfidence) && confidence < minConfidence) {
        console.log(`Low ASR confidence ${confidence.toFixed(2)} < ${minConfidence}: asking to repeat "${transcript.slice(0, 80)}"`);
        return { transcript, language: 'vi', intent: 'chat', reply: 'Dạ em nghe chưa rõ, đại ca nói lại giúp em nhé.', trackId: '' };
      }
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
        if (this.fallbackSpeech.has(pcm)) return pcm;
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
      // Fallback voices are used only while Edge TTS is failing; caching them would
      // keep the lower-quality voice for that phrase after Edge recovers.
      const engine = response.headers.get('x-tts-engine');
      if (engine && engine !== 'edge') this.fallbackSpeech.add(pcm);
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
