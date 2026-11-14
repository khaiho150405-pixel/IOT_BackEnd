export const RATE = 16000;

export function wavFromPcm(pcm: Buffer, rate = RATE): Buffer {
  if (pcm.length % 2) throw new Error('PCM16 must contain whole samples');
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// Parse RIFF chunks, including metadata/padding. Never assume a 44-byte header.
export function readWav(wav: Buffer): { pcm: Buffer; rate: number } {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' ||
      wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Expected PCM WAV');
  let rate = 0;
  let pcm: Buffer | undefined;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > wav.length) throw new Error('Truncated WAV');
    if (id === 'fmt ') {
      if (size < 16 || wav.readUInt16LE(start) !== 1 ||
          wav.readUInt16LE(start + 2) !== 1 || wav.readUInt16LE(start + 14) !== 16)
        throw new Error('WAV must be signed PCM16 mono');
      rate = wav.readUInt32LE(start + 4);
    }
    if (id === 'data') pcm = wav.subarray(start, start + size);
    offset = start + size + (size % 2);
  }
  if (!pcm?.length || pcm.length % 2 || rate < 8000 || rate > 96000)
    throw new Error('Invalid WAV data/rate');
  return { pcm, rate };
}

// Windowed-sinc low-pass resampling: avoids aliasing when converting TTS/music.
export function resample(pcm: Buffer, from: number, to = RATE): Buffer {
  if (from < 8000 || from > 96000 || pcm.length % 2) throw new Error('Invalid PCM');
  if (from === to) return pcm;
  const samples = pcm.length / 2;
  const result = Buffer.alloc(Math.floor(samples * to / from) * 2);
  const cutoff = Math.min(1, to / from) * 0.9;
  for (let i = 0; i < result.length / 2; i++) {
    const position = i * from / to;
    let sum = 0, weights = 0;
    for (let k = Math.ceil(position - 16); k <= Math.floor(position + 16); k++) {
      if (k < 0 || k >= samples) continue;
      const d = position - k;
      const x = Math.PI * d * cutoff;
      const weight = (Math.abs(x) < 1e-9 ? cutoff : Math.sin(x) / (Math.PI * d)) *
        (0.5 + 0.5 * Math.cos(Math.PI * d / 16));
      sum += pcm.readInt16LE(k * 2) * weight; weights += weight;
    }
    result.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sum / (weights || 1)))), i * 2);
  }
  return result;
}

// Energy-based endpointing; the configured ASR/LLM handles recognition and language.
/**
 * Speaker volume (0.05-1, default SPEAKER_VOLUME=0.5). On the testboard the
 * ESP32 rebooted right after loud replies (MAX98357A current peaks on a weak
 * 5 V supply); halving the amplitude cuts the peak speaker power to a quarter.
 * Returns a copy so cached speech buffers are never modified.
 */
export function applySpeakerVolume(pcm: Buffer, volume = Number(process.env.SPEAKER_VOLUME ?? 0.5)): Buffer {
  const gain = Number.isFinite(volume) ? Math.min(1, Math.max(0.05, volume)) : 0.5;
  if (gain === 1) return pcm;
  const out = Buffer.allocUnsafe(pcm.length - (pcm.length % 2));
  for (let i = 0; i < out.length; i += 2) out.writeInt16LE(Math.round(pcm.readInt16LE(i) * gain), i);
  return out;
}

/**
 * Second-order Butterworth high-pass for the 16 kHz microphone stream.
 *
 * Measured on the INMP441 testboard: 65% of the background noise was below
 * 100 Hz (a steady hum around 82-88 Hz plus DC/rumble). Speech recognition does
 * not need that band, and it pushed the VAD over its threshold on silence.
 * State is kept across frames, so call it per device on consecutive chunks.
 */
export class HighPassFilter {
  private readonly b0: number; private readonly b1: number; private readonly b2: number;
  private readonly a1: number; private readonly a2: number;
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0;
  constructor(cutoffHz = 120, sampleRate = 16000) {
    const w0 = 2 * Math.PI * cutoffHz / sampleRate;
    const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
    const cos = Math.cos(w0), a0 = 1 + alpha;
    this.b0 = (1 + cos) / 2 / a0; this.b1 = -(1 + cos) / a0; this.b2 = this.b0;
    this.a1 = -2 * cos / a0; this.a2 = (1 - alpha) / a0;
  }
  process(chunk: Buffer): Buffer {
    const out = Buffer.allocUnsafe(chunk.length);
    for (let i = 0; i < chunk.length; i += 2) {
      const x = chunk.readInt16LE(i);
      const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
      this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
      out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(y))), i);
    }
    return out;
  }
}

export class UtteranceDetector {
  private pre: Buffer[] = [];
  private preBytes = 0;
  private chunks: Buffer[] = [];
  private elapsed = 0;
  private voiced = 0;
  private silence = 0;
  constructor(private threshold = 500, private silenceMs = 900, private maxMs = 12000) {}
  reset() {
    this.pre = []; this.preBytes = 0; this.chunks = [];
    this.elapsed = this.voiced = this.silence = 0;
  }
  push(chunk: Buffer): Buffer | undefined {
    if (!chunk.length || chunk.length % 2 || chunk.length > 4096) throw new Error('Invalid mic frame');
    let sum = 0;
    for (let i = 0; i < chunk.length; i += 2) sum += chunk.readInt16LE(i) ** 2;
    const loud = Math.sqrt(sum / (chunk.length / 2)) >= this.threshold;
    const ms = chunk.length / 32;
    if (!this.chunks.length) {
      if (!loud) {
        this.pre.push(Buffer.from(chunk)); this.preBytes += chunk.length;
        while (this.preBytes > 9600 && this.pre.length) this.preBytes -= this.pre.shift()!.length;
        return;
      }
      this.chunks = this.pre; this.pre = []; this.preBytes = 0;
    }
    this.chunks.push(Buffer.from(chunk)); this.elapsed += ms;
    if (loud) { this.voiced += ms; this.silence = 0; } else this.silence += ms;
    if (this.silence >= this.silenceMs || this.elapsed >= this.maxMs) {
      const result = this.voiced >= 160 ? Buffer.concat(this.chunks) : undefined;
      this.reset();
      return result;
    }
  }
}
