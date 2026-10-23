import { Inject, Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import { Server } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket, WebSocketServer, RawData } from 'ws';
import { AiotService, Sensor, DecisionValue } from './aiot.service';
import { HistoryStore } from './history';
import { UtteranceDetector } from './audio';
import { OledRenderer } from './display';
import { MusicLibrary } from './music';
import { AiotMqttService } from './mqtt.service';

interface Session {
  ws: WebSocket;
  id?: string;
  connectedAt: number;
  sensor?: Sensor;
  ledEnabled?: boolean;
  detector: UtteranceDetector;
  busy: boolean;
  controller?: AbortController;
  lastTurn: number;
  pending?: { id: string; action: string; resolve: () => void; reject: (error: Error) => void };
  readyTimer: NodeJS.Timeout;
  rateStart: number;
  rateBytes: number;
  textCount: number;
  alive: boolean;
  playback?: { id: string; resolve: () => void };
}

export function authenticate(header: string | undefined, token: string): boolean {
  const supplied = Buffer.from(header || '');
  const expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

@Injectable()
export class AiotGateway implements OnModuleDestroy {
  private server?: WebSocketServer;
  private sessions = new Set<Session>();
  private heartbeat?: NodeJS.Timeout;
  private oled = new OledRenderer();
  private music = new MusicLibrary();
  constructor(
    @Inject(AiotService) private ai: AiotService,
    @Inject(HistoryStore) private history: HistoryStore,
    @Optional() @Inject(AiotMqttService) private mqtt?: AiotMqttService,
  ) {}

  attach(server: Server) {
    this.mqtt?.setGateway(this);
    this.server = new WebSocketServer({ server, path: '/aiot', maxPayload: 8192, perMessageDeflate: false,
      verifyClient: ({ req }, done) => {
        const accepted = this.sessions.size < 8 &&
          authenticate(req.headers.authorization, process.env.DEVICE_TOKEN!);
        if (!accepted) console.warn(`WebSocket rejected from ${req.socket.remoteAddress}: auth or connection limit`);
        done(accepted, 401, 'Unauthorized');
      },
    });
    this.heartbeat = setInterval(() => {
      for (const s of this.sessions) {
        if (!s.alive) { s.ws.terminate(); continue; }
        s.alive = false;
        s.ws.ping();
      }
    }, 15000);
    this.heartbeat.unref();
    this.server.on('connection', (ws, req) => {
      const peer = req.socket.remoteAddress || 'unknown peer';
      const session: Session = {
        ws, connectedAt: Date.now(), detector: new UtteranceDetector(Number(process.env.VAD_RMS || 500),
          Number(process.env.VAD_SILENCE_MS || 850), Number(process.env.VAD_MAX_MS || 12000)),
        busy: false, lastTurn: 0, rateStart: Date.now(), rateBytes: 0, textCount: 0, alive: true,
        readyTimer: setTimeout(() => ws.close(1008, 'hello required'), 10000),
      };
      this.sessions.add(session);
      console.log(`WebSocket connected from ${peer}`);
      ws.on('pong', () => { session.alive = true; });
      ws.on('message', (data, binary) => {
        try { this.receive(session, data, binary); }
        catch (error) {
          console.warn(`WebSocket protocol rejected for ${session.id || peer}: ${(error as Error).message}`);
          ws.close(1008, 'invalid message');
        }
      });
      ws.on('close', (code, reason) => {
        console.log(`WebSocket closed for ${session.id || peer}: ${code} ${reason.toString()}`);
        clearTimeout(session.readyTimer);
        session.controller?.abort();
        session.pending?.reject(new Error('Device disconnected'));
        if (session.id) this.mqtt?.publishState(session.id, { connected: false });
        this.sessions.delete(session);
      });
      ws.on('error', () => ws.terminate());
    });
  }

  private send(session: Session, message: unknown) {
    if (session.ws.readyState !== WebSocket.OPEN) throw new Error('Device disconnected');
    if (session.ws.bufferedAmount > 65536) throw new Error('Device network too slow');
    session.ws.send(JSON.stringify(message));
  }

  private receive(s: Session, raw: RawData, binary: boolean) {
    const data = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
    if (Date.now() - s.rateStart > 1000) {
      s.rateStart = Date.now(); s.rateBytes = 0; s.textCount = 0;
    }
    s.rateBytes += data.length;
    if (s.rateBytes > 96000 || (!binary && ++s.textCount > 64)) throw new Error('Rate limit');
    if (binary) {
      if (!s.id || !data.length || data.length % 2 || data.length > 4096) throw new Error('Invalid PCM');
      if (s.busy) return;
      const utterance = s.detector.push(data);
      if (utterance) {
        // Set busy synchronously, before any await. One request at a time/device.
        s.busy = true; s.lastTurn = Date.now();
        let energy = 0, peak = 0;
        for (let offset = 0; offset < utterance.length; offset += 2) {
          const sample = utterance.readInt16LE(offset);
          energy += sample * sample;
          peak = Math.max(peak, Math.abs(sample));
        }
        const rms = Math.round(Math.sqrt(energy / (utterance.length / 2)));
        console.log(`Voice capture: duration=${Math.round(utterance.length / 32)}ms rms=${rms} peak=${peak} device=${s.id}`);
        void this.processTurn(s, utterance);
      }
      return;
    }
    const message = JSON.parse(data.toString('utf8'));
    if (!s.id) {
      if (message.type !== 'hello' || typeof message.device_id !== 'string' ||
          !/^[A-Za-z0-9:_-]{1,64}$/.test(message.device_id) ||
          message.audio?.format !== 'pcm_s16le' || message.audio.sample_rate !== 16000 ||
          message.audio.channels !== 1) throw new Error('Invalid hello');
      if ([...this.sessions].some(other => other !== s && other.id === message.device_id)) throw new Error('Device already connected');
      s.id = message.device_id;
      // Do not guess after a backend/device reconnect. New firmware reports its
      // logical LED state in hello; older firmware remains unknown until an ACK.
      s.ledEnabled = typeof message.led_enabled === 'boolean' ? message.led_enabled : undefined;
      clearTimeout(s.readyTimer);
      console.log(`Device hello accepted: ${s.id}`);
      this.send(s, { type: 'status', state: 'listening' });
      this.show(s, 'Dạ em chào đại ca!\nEm sẵn sàng rồi ạ.');
      this.mqtt?.publishState(s.id!, { connected: true, ledEnabled: s.ledEnabled, busy: false });
      return;
    }
    if (message.type === 'sensor') {
      const { temperature: t, humidity: h } = message;
      s.sensor = message.valid === true && Number.isFinite(t) && Number.isFinite(h) &&
        t >= -40 && t <= 80 && h >= 0 && h <= 100 ? { temperature: t, humidity: h, receivedAt: Date.now() } : undefined;
      if (s.sensor && s.id) this.mqtt?.publishSensor(s.id!, s.sensor);
    } else if (message.type === 'ack' && s.pending && message.id === s.pending.id) {
      if (message.device === 'led' && message.action === s.pending.action &&
          message.enabled === (s.pending.action === 'on')) {
        s.ledEnabled = message.enabled;
        if (s.id) this.mqtt?.publishState(s.id!, { connected: true, ledEnabled: s.ledEnabled, busy: s.busy });
        s.pending.resolve();
      }
      else s.pending.reject(new Error('LED acknowledgement mismatch'));
    } else if (message.type === 'playback_done' && s.playback && s.playback.id === message.id) {
      s.playback.resolve();
    } else if (message.type === 'interrupt') {
      s.controller?.abort();
      s.pending?.reject(new Error('Interrupted'));
      this.send(s, { type: 'audio_stop' });
      s.detector.reset();
      // processTurn's finally releases busy after the old work actually stops.
      if (!s.busy) this.send(s, { type: 'status', state: 'listening' });
    } else if (message.type === 'error') {
      s.pending?.reject(new Error('Device rejected command'));
      if (['audio_buffer_full', 'playback_stalled'].includes(message.message)) s.controller?.abort();
    }
  }

  getFirstOnlineDeviceId(): string | undefined {
    const session = [...this.sessions].find(s => s.id && s.ws.readyState === WebSocket.OPEN);
    return session?.id;
  }

  dashboardDevices() {
    return [...this.sessions].filter(s => s.id).map(s => ({
      id: s.id!,
      connected: s.ws.readyState === WebSocket.OPEN,
      connectedAt: new Date(s.connectedAt).toISOString(),
      busy: s.busy,
      ledEnabled: s.ledEnabled,
      sensor: s.sensor ? {
        temperature: s.sensor.temperature,
        humidity: s.sensor.humidity,
        receivedAt: new Date(s.sensor.receivedAt).toISOString(),
        stale: Date.now() - s.sensor.receivedAt >= 8000,
      } : null,
    }));
  }

  async setDashboardLed(deviceId: string, enabled: boolean) {
    const session = [...this.sessions].find(s => s.id === deviceId && s.ws.readyState === WebSocket.OPEN);
    if (!session) throw new Error('DEVICE_OFFLINE');
    if (session.busy || session.pending) throw new Error('DEVICE_BUSY');
    const controller = new AbortController();
    session.busy = true;
    session.detector.reset();
    try {
      this.send(session, { type: 'status', state: 'thinking' });
      await this.command(session, enabled ? 'on' : 'off', controller.signal);
      return this.dashboardDevices().find(device => device.id === deviceId);
    } finally {
      session.detector.reset();
      session.busy = false;
      if (session.ws.readyState === WebSocket.OPEN) this.send(session, { type: 'status', state: 'listening' });
    }
  }

  private show(s: Session, text: string, answer?: string) {
    const pages = answer === undefined ? this.oled.pages(text) : this.oled.conversation(text, answer);
    const batch = randomUUID();
    pages.forEach((page, index) => this.send(s, {
      type: 'display', batch, index, total: pages.length, bitmap: page.toString('base64'),
    }));
  }

  private async command(s: Session, action: 'on' | 'off', signal: AbortSignal) {
    const id = randomUUID();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('LED acknowledgement timed out')), 3000);
      const aborted = () => finish(new Error('Interrupted'));
      const finish = (error?: Error) => {
        clearTimeout(timer); signal.removeEventListener('abort', aborted);
        s.pending = undefined;
        error ? reject(error) : resolve();
      };
      s.pending = { id, action, resolve: () => finish(), reject: finish };
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) { aborted(); return; }
      try { this.send(s, { type: 'command', id, device: 'led', action }); }
      catch (error) { finish(error as Error); }
    });
  }

  private async stream(s: Session, pcm: Buffer, signal: AbortSignal, music = false, onFirstAudio?: () => void) {
    signal.throwIfAborted();
    const id = randomUUID();
    const finished = new Promise<void>(resolve => { s.playback = { id, resolve }; });
    this.send(s, { type: 'audio_start', id, duration_ms: Math.ceil(pcm.length / 32), mode: music ? 'music' : 'speech' });
    try {
      for (let offset = 0; offset < pcm.length; offset += 640) {
        signal.throwIfAborted();
        if (s.ws.readyState !== WebSocket.OPEN || s.ws.bufferedAmount > 32768) throw new Error('Audio network too slow');
        const chunk = pcm.subarray(offset, offset + 640);
        await this.wait(new Promise<void>((resolve, reject) => s.ws.send(chunk, { binary: true }, error => error ? reject(error) : resolve())), signal);
        if (offset === 0) onFirstAudio?.();
        // Never catch up with an unbounded burst after a stalled event loop.
        await sleep(chunk.length / 32, undefined, { signal });
      }
      this.send(s, { type: 'audio_end', id });
      await this.wait(finished, AbortSignal.any([signal, AbortSignal.timeout(4000)]));
    } catch (error) {
      if (s.ws.readyState === WebSocket.OPEN) this.send(s, { type: 'audio_stop' });
      throw error;
    } finally {
      s.playback = undefined;
    }
  }

  // Also bounds local file/database work and providers that ignore AbortSignal.
  private wait<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const aborted = () => reject(signal.reason || new Error('Interrupted'));
      signal.addEventListener('abort', aborted, { once: true });
      work.then(value => { signal.removeEventListener('abort', aborted); resolve(value); },
        error => { signal.removeEventListener('abort', aborted); reject(error); });
      if (signal.aborted) { signal.removeEventListener('abort', aborted); aborted(); }
    });
  }

  submitDashboardText(deviceId: string, text: string): Promise<{
    transcript: string; reply: string; language: string; intent: DecisionValue['intent'];
  }> {
    const session = [...this.sessions].find(s => s.id === deviceId && s.ws.readyState === WebSocket.OPEN);
    if (!session) throw new Error('DEVICE_OFFLINE');
    if (session.busy || session.pending) throw new Error('DEVICE_BUSY');

    // Reserve the device before starting asynchronous AI work, just like VAD does.
    session.busy = true;
    session.lastTurn = Date.now();
    session.detector.reset();
    return new Promise((resolve, reject) => {
      let reported = false;
      const report = (decision?: DecisionValue) => {
        if (reported) return;
        reported = true;
        if (!decision) { reject(new Error('TURN_FAILED')); return; }
        resolve({ transcript: decision.transcript, reply: decision.reply,
          language: decision.language, intent: decision.intent });
      };
      void this.processTurn(session, { text: text.trim() }, report).catch(() => report());
    });
  }

  private async processTurn(s: Session, input: Buffer | { text: string },
    onReady?: (decision?: DecisionValue) => void): Promise<DecisionValue | undefined> {
    const controller = new AbortController();
    s.controller = controller;
    const signal = controller.signal;
    const started = performance.now();
    let deadlineExpired = false, textDelivered = false, readyReported = false;
    let readyReply: DecisionValue | undefined;
    let recoveryController: AbortController | undefined;
    const deliverText = () => {
      if (!readyReply || textDelivered) return;
      this.send(s, { type: 'transcript', text: readyReply.transcript, language: readyReply.language });
      this.send(s, { type: 'chat', reply: readyReply.reply, language: readyReply.language });
      this.show(s, readyReply.transcript, readyReply.reply);
      if (s.id && readyReply) this.mqtt?.publishChat(s.id, readyReply);
      textDelivered = true;
      readyReported = true;
      onReady?.(readyReply);
      // The deadline is for the first user-visible result. Once the OLED/chat has
      // the confirmed answer, give TTS its own bounded window instead of aborting it.
      clearTimeout(deadline);
      console.log(`Voice latency: text=${Math.round(performance.now() - started)}ms device=${s.id}`);
    };
    const responseTimeout = Number(process.env.RESPONSE_TIMEOUT_MS || 30000);
    const deadline = setTimeout(() => {
      deadlineExpired = true; controller.abort(new Error('Response deadline exceeded'));
    }, responseTimeout);
    const firstAudio = () => {
      clearTimeout(deadline);
      console.log(`Voice latency: audio=${Math.round(performance.now() - started)}ms device=${s.id}`);
    };
    try {
      this.send(s, { type: 'status', state: 'thinking' });
      this.show(s, 'Đang nghe, đại ca...');
      const [tracks, recent] = await this.wait(Promise.all([this.music.catalog(), this.history.recent(s.id!)]), signal);
      const analysisTimeout = (process.env.AI_PROVIDER || 'ollama').toLowerCase() === 'ollama' ? 16000 : 8000;
      const analysisSignal = AbortSignal.any([signal, AbortSignal.timeout(analysisTimeout)]);
      const availableTracks = tracks.map(({ id, title }) => ({ id, title }));
      const analysis = Buffer.isBuffer(input) ?
        this.ai.analyze(input, s.sensor, recent, availableTracks, analysisSignal, s.ledEnabled) :
        this.ai.analyzeText(input.text, s.sensor, recent, availableTracks, analysisSignal, s.ledEnabled);
      const decision = await this.wait(analysis, analysisSignal);
      signal.throwIfAborted();
      if (decision.intent === 'ignore') return;
      console.log(`[AI Decision] Transcript: "${decision.transcript}" | Intent: "${decision.intent}" | Reply: "${decision.reply}"`);
      if (process.env.DEMO_FAST_CONFIRMATIONS === 'true') {
        if (decision.intent === 'led_on') decision.reply = 'Em đã bật đèn, đại ca.';
        else if (decision.intent === 'led_off') decision.reply = 'Em đã tắt đèn, đại ca.';
      }
      if (decision.intent === 'environment' && (process.env.DEMO_FAST_CONFIRMATIONS === 'true' || !/\d+/.test(decision.reply))) {
        const sensor = s.sensor;
        if (sensor && Date.now() - sensor.receivedAt < 8000) {
          decision.reply = /^en/i.test(decision.language) ?
            `The room temperature is ${sensor.temperature.toFixed(1)} degrees Celsius, humidity is ${sensor.humidity.toFixed(0)} percent, boss.` :
            `Em đo được ${sensor.temperature.toFixed(1).replace('.', ',')} độ C, độ ẩm ${sensor.humidity.toFixed(1).replace('.', ',')} phần trăm, đại ca.`;
        }
      }
      // Generate speech while waiting for the device ACK. Only deliver after ACK.
      const speechWork = this.ai.speak(decision.reply, signal, decision.language).then(
        value => ({ value, error: undefined }), error => ({ value: undefined, error }));
      let music: Buffer | undefined;
      if (decision.intent === 'led_on' || decision.intent === 'led_off') {
        await this.command(s, decision.intent === 'led_on' ? 'on' : 'off', signal);
      } else if (decision.intent === 'music_play') music = await this.wait(this.music.read(decision.trackId), signal);
      else if (decision.intent === 'music_stop') this.send(s, { type: 'audio_stop' });
      signal.throwIfAborted();
      readyReply = decision;
      void this.history.add(s.id!, decision.transcript, decision.reply, decision.intent)
        .catch(() => console.error('History write failed; response still delivered'));
      this.send(s, { type: 'status', state: 'thinking' });
      // Show the confirmed result now; either Gemini audio or prepared speech follows quickly.
      deliverText();
      let speech: { value?: Buffer; error?: unknown };
      try {
        const configuredLocalTtsWait = Number(process.env.LOCAL_TTS_TIMEOUT_MS || 22000);
        const localTtsWait = Number.isFinite(configuredLocalTtsWait) ?
          Math.min(30000, Math.max(2200, configuredLocalTtsWait)) : 22000;
        const speechWait = (process.env.AI_PROVIDER || 'ollama').toLowerCase() === 'ollama' ? localTtsWait : 2200;
        speech = await this.wait(speechWork, AbortSignal.any([signal, AbortSignal.timeout(speechWait)]));
        if (speech.error) throw speech.error;
      } catch (error) {
        if (signal.aborted) throw error;
        console.warn(`TTS slow/failed: ${(error as Error).message}`);
        this.send(s, { type: 'notice', code: 'tts_fallback' });
        try {
          const fallbackPhrase = /^en/i.test(decision.language) ?
            'Yes boss, I am right here.' : 'Dạ em nghe rõ rồi đại ca.';
          speech = { value: await this.wait(this.ai.speak(fallbackPhrase, signal, decision.language),
            AbortSignal.any([signal, AbortSignal.timeout(2000)])) };
        } catch (fallbackError) {
          console.warn(`Prepared response voice unavailable: ${(fallbackError as Error).message}`);
          speech = { value: undefined, error: fallbackError };
        }
      }
      if (speech.value) await this.stream(s, speech.value, signal, false, firstAudio);
      if (music) await this.stream(s, music, signal, true, firstAudio);
    } catch (error) {
      if ((!signal.aborted || deadlineExpired) && s.ws.readyState === WebSocket.OPEN) {
        const timedOut = deadlineExpired || (error as Error).name === 'TimeoutError';
        console[timedOut ? 'warn' : 'error'](timedOut ? 'Voice turn timed out:' : 'Turn failed:', (error as Error).message);
        try {
          deliverText();
          this.send(s, { type: 'notice', code: timedOut ? 'response_timeout' : 'turn_failed' });
          clearTimeout(deadline);
          if (!textDelivered) this.show(s, timedOut ? 'Mạng phản hồi chậm.\nĐại ca thử lại nhé!' :
            'Dạ em chưa nghe rõ.\nĐại ca nói lại giúp em nhé.');
          recoveryController = new AbortController();
          s.controller = recoveryController;
          try {
            const fallback = await this.wait(this.ai.speak('Em đang chậm phản hồi, đại ca nói lại giúp em nhé.', recoveryController.signal),
              AbortSignal.any([recoveryController.signal, AbortSignal.timeout(700)]));
            await this.stream(s, fallback, recoveryController.signal, false, firstAudio);
          } catch (fallbackError) {
            console.warn(`Prepared timeout voice unavailable: ${(fallbackError as Error).message}`);
          }
        } catch { s.ws.close(1011, 'delivery failed'); }
      }
    } finally {
      clearTimeout(deadline);
      controller.abort();
      recoveryController?.abort();
      s.detector.reset(); s.busy = false; s.controller = undefined;
      if (!readyReported) onReady?.();
      if (s.ws.readyState === WebSocket.OPEN) {
        try {
          this.send(s, { type: 'audio_stop' });
          this.send(s, { type: 'status', state: 'listening' });
        } catch { s.ws.close(1011, 'delivery failed'); }
      }
    }
    return readyReply;
  }
  onModuleDestroy() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const s of this.sessions) { s.controller?.abort(); s.ws.terminate(); }
    this.server?.close();
  }
}
