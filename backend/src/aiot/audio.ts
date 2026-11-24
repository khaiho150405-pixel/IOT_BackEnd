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

const ADPCM_STEP = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
  50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371,
  408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
  2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493,
  10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767];
const ADPCM_INDEX = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];

/**
 * Decodes one microphone frame of the firmware's IMA ADPCM uplink (4 bits per sample, ~8 KB/s
 * instead of 32 KB/s of PCM16). Frame: uint16 sampleCount, int16 firstSample, uint8 stepIndex,
 * uint8 reserved, then 4-bit codes for samples 1..n-1, low nibble first. Every frame stands
 * alone, so a frame the device dropped on a congested link only loses its own 16 ms.
 */
export function decodeImaAdpcm(frame: Buffer): Buffer {
  if (frame.length < 6) throw new Error('Invalid ADPCM frame');
  const count = frame.readUInt16LE(0);
  let predictor = frame.readInt16LE(2), index = frame[4];
  if (!count || count > 2048 || index > 88 || frame.length !== 6 + Math.ceil((count - 1) / 2))
    throw new Error('Invalid ADPCM frame');
  const out = Buffer.alloc(count * 2);
  out.writeInt16LE(predictor, 0);
  for (let i = 1; i < count; i++) {
    const byte = frame[6 + ((i - 1) >> 1)];
    const code = (i & 1) ? byte & 0x0f : byte >> 4;
    const step = ADPCM_STEP[index];
    let delta = step >> 3;
    if (code & 4) delta += step;
    if (code & 2) delta += step >> 1;
    if (code & 1) delta += step >> 2;
    predictor = Math.max(-32768, Math.min(32767, predictor + (code & 8 ? -delta : delta)));
    index = Math.max(0, Math.min(88, index + ADPCM_INDEX[code]));
    out.writeInt16LE(predictor, i * 2);
  }
  return out;
}

/** Reference encoder matching the firmware (used by tests and the fake device). */
export function encodeImaAdpcm(pcm: Buffer, startIndex = 0): { frame: Buffer; index: number } {
  const count = pcm.length / 2;
  const frame = Buffer.alloc(6 + Math.ceil((count - 1) / 2));
  let predictor = pcm.readInt16LE(0), index = startIndex;
  frame.writeUInt16LE(count, 0); frame.writeInt16LE(predictor, 2); frame[4] = index;
  for (let i = 1; i < count; i++) {
    const step = ADPCM_STEP[index];
    let diff = pcm.readInt16LE(i * 2) - predictor, code = 0;
    if (diff < 0) { code = 8; diff = -diff; }
    let delta = step >> 3;
    if (diff >= step) { code |= 4; diff -= step; delta += step; }
    if (diff >= step >> 1) { code |= 2; diff -= step >> 1; delta += step >> 1; }
    if (diff >= step >> 2) { code |= 1; delta += step >> 2; }
    predictor = Math.max(-32768, Math.min(32767, predictor + (code & 8 ? -delta : delta)));
    index = Math.max(0, Math.min(88, index + ADPCM_INDEX[code]));
    const at = 6 + ((i - 1) >> 1);
    frame[at] |= (i & 1) ? code : code << 4;
  }
  return { frame, index };
}
