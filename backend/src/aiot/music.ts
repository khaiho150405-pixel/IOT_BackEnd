import { existsSync } from 'node:fs';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve, relative, isAbsolute, join, basename, extname } from 'node:path';
import { z } from 'zod';
import { readWav, RATE } from './audio';

const Catalog = z.array(z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  title: z.string().min(1).max(120), file: z.string().min(1).max(200),
})).max(100);

const MAX_SOURCE_BYTES = 100_000_000;
const MAX_PCM_BYTES = 300 * RATE * 2; // five minutes of mono PCM16
const MAX_DECODE_MS = 30_000;

function trackId(file: string) {
  const slug = basename(file, extname(file)).normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56) || 'track';
  return `mp4-${slug}`;
}

export class MusicLibrary {
  constructor(private root = resolve('music')) {}
  async catalog() {
    const catalogPath = resolve(this.root, 'catalog.json');
    let configured: unknown = [];
    try { configured = JSON.parse(await readFile(catalogPath, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const rows = Catalog.parse(configured);
    const ids = new Set(rows.map(row => row.id));
    if (ids.size !== rows.length) throw new Error('Duplicate track IDs');

    // MP4 tracks are discovered by filename so adding a song does not require
    // editing a second manifest. Only regular files in this dedicated folder
    // are considered; symlinks and nested paths are intentionally ignored.
    const mp4Root = resolve(this.root, 'mp4');
    let entries;
    try { entries = await readdir(mp4Root, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    for (const entry of (entries ?? []).filter(item => item.isFile() && extname(item.name).toLowerCase() === '.mp4')
      .sort((a, b) => a.name.localeCompare(b.name, 'vi'))) {
      let id = trackId(entry.name), suffix = 2;
      while (ids.has(id)) id = `${trackId(entry.name).slice(0, 58)}-${suffix++}`;
      ids.add(id);
      rows.push({ id, title: basename(entry.name, extname(entry.name)).slice(0, 120), file: `mp4/${entry.name}` });
    }
    if (rows.length > 100) throw new Error('Music library supports up to 100 tracks');
    return rows;
  }
  async read(id: string) {
    const track = (await this.catalog()).find(row => row.id === id);
    if (!track) throw new Error('Track not in music catalog');
    const root = await realpath(this.root);
    const path = await realpath(resolve(root, track.file));
    const rel = relative(root, path);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Invalid music path');
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_SOURCE_BYTES) throw new Error('Track too large (max 100 MB)');
    if (extname(path).toLowerCase() === '.mp4') return this.decodeMp4(path);
    const { pcm, rate } = readWav(await readFile(path));
    if (rate !== RATE) throw new Error('Convert WAV music to mono PCM16, 16000 Hz first');
    return pcm;
  }

  private async decodeMp4(path: string): Promise<Buffer> {
    const python = process.env.LOCAL_VOICE_PYTHON || join(
      process.env.LOCALAPPDATA || '', 'AIoT', 'xiaozhi-esp32-server', 'main', 'xiaozhi-server', '.venv', 'Scripts', 'python.exe');
    const scriptCandidates = [
      resolve(process.cwd(), 'scripts', 'decode-music.py'),
      resolve(process.cwd(), 'backend', 'scripts', 'decode-music.py'),
      resolve(__dirname, '../../../scripts/decode-music.py'),
    ];
    const script = scriptCandidates.find(candidate => existsSync(candidate));
    if (!script) throw new Error('MP4 decoder script is missing from backend/scripts.');

    return new Promise((resolvePcm, reject) => {
      const child = spawn(python, [script, path], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const chunks: Buffer[] = [];
      let outputBytes = 0, errorText = '', settled = false;
      const finishError = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill();
        reject(error);
      };
      const timer = setTimeout(() => finishError(new Error('MP4 decoding exceeded 30 seconds.')), MAX_DECODE_MS);
      child.stdout.on('data', (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_PCM_BYTES) { finishError(new Error('MP4 track is longer than five minutes.')); return; }
        chunks.push(Buffer.from(chunk));
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (errorText.length < 1200) errorText += chunk.toString('utf8').slice(0, 1200 - errorText.length);
      });
      child.once('error', error => finishError(new Error(`Could not start MP4 decoder (${error.message}).`)));
      child.once('close', code => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) { reject(new Error(`Could not decode MP4 audio: ${errorText.trim() || `decoder exited ${code}`}`)); return; }
        if (!outputBytes || outputBytes % 2) { reject(new Error('MP4 file has no valid audio track.')); return; }
        resolvePcm(Buffer.concat(chunks, outputBytes));
      });
    });
  }
}
