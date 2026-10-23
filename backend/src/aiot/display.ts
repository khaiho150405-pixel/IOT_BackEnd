import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const CONTENT_HEIGHT = 28;
export const PAGE_BYTES = 128 * CONTENT_HEIGHT / 8;
export const MAX_PAGES = 32;

export class OledRenderer {
  constructor() {
    // Automatically register standard Windows Vietnamese-capable fonts if present
    const defaultFontPaths = [
      'C:\\Windows\\Fonts\\segoeui.ttf',
      'C:\\Windows\\Fonts\\arial.ttf',
      'C:\\Windows\\Fonts\\tahoma.ttf',
    ];
    for (const fontPath of defaultFontPaths) {
      if (existsSync(fontPath)) {
        try {
          const fontName = fontPath.includes('segoeui') ? 'Segoe UI' :
            fontPath.includes('arial') ? 'Arial' : 'Tahoma';
          GlobalFonts.registerFromPath(fontPath, fontName);
        } catch { /* Ignore if already registered */ }
      }
    }
    if (process.env.FONT_DIR && existsSync(process.env.FONT_DIR)) {
      for (const file of readdirSync(process.env.FONT_DIR)) {
        if (/\.(ttf|otf|ttc)$/i.test(file)) {
          try { GlobalFonts.registerFromPath(join(process.env.FONT_DIR, file)); }
          catch { /* Ignore registration error */ }
        }
      }
    }
  }
  // Each page keeps one question row and one answer row beneath the firmware
  // header so the 128x64 OLED stays sparse, legible, and properly displays Vietnamese.
  conversation(question: string, answer: string): Buffer[] {
    const canvas = createCanvas(128, CONTENT_HEIGHT), ctx = canvas.getContext('2d');
    ctx.font = process.env.OLED_FONT || "11px 'Segoe UI', 'Noto Sans', 'Arial', sans-serif";
    ctx.textBaseline = 'top';
    const wrap = (text: string, width: number) => {
      const lines: string[] = []; let line = '';
      for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text.normalize('NFC'))) {
        if (segment === '\n') { lines.push(line); line = ''; continue; }
        if (line && ctx.measureText(line + segment).width > width) {
          const space = line.lastIndexOf(' ');
          if (space > 0) { lines.push(line.slice(0, space)); line = line.slice(space + 1); }
          else { lines.push(line); line = ''; }
        }
        if (!line && segment === ' ') continue;
        line += segment;
      }
      if (line || !lines.length) lines.push(line);
      return lines;
    };
    const questions = wrap(question, 102), answers = wrap(answer, 106);
    const count = Math.max(questions.length, answers.length);
    if (count > MAX_PAGES) throw new Error('Conversation exceeds OLED page limit');
    return Array.from({ length: count }, (_, index) => {
      ctx.fillStyle = 'black'; ctx.fillRect(0, 0, 128, CONTENT_HEIGHT);
      ctx.fillStyle = 'white';
      const qIndex = Math.min(index, questions.length - 1);
      const aIndex = Math.min(index, answers.length - 1);
      ctx.fillText('Bạn:', 0, 0);
      ctx.fillText(questions[qIndex], 26, 0);
      ctx.fillRect(0, 13, 128, 1);
      ctx.fillText('AI:', 0, 14);
      ctx.fillText(answers[aIndex], 20, 14);
      const rgba = ctx.getImageData(0, 0, 128, CONTENT_HEIGHT).data;
      const bitmap = Buffer.alloc(PAGE_BYTES);
      for (let pixel = 0; pixel < 128 * CONTENT_HEIGHT; pixel++) {
        if (rgba[pixel * 4] > 100) bitmap[pixel >> 3] |= 0x80 >> (pixel & 7);
      }
      return bitmap;
    });
  }
  // Rasterize shaped Unicode on the server. ESP32 does not need a giant font.
  pages(text: string): Buffer[] {
    const canvas = createCanvas(128, CONTENT_HEIGHT);
    const ctx = canvas.getContext('2d');
    ctx.font = process.env.OLED_FONT || "11px 'Segoe UI', 'Noto Sans', 'Arial', sans-serif";
    ctx.textBaseline = 'top';
    const lines: string[] = [];
    let line = '';
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    for (const { segment } of segmenter.segment(text.normalize('NFC'))) {
      if (segment === '\n') { lines.push(line); line = ''; continue; }
      if (ctx.measureText(line + segment).width > 126 && line) {
        lines.push(line); line = '';
      }
      line += segment;
    }
    if (line || !lines.length) lines.push(line);
    if (lines.length > MAX_PAGES * 2) throw new Error('Text exceeds OLED page limit');
    const pages: Buffer[] = [];
    for (let start = 0; start < lines.length; start += 2) {
      ctx.fillStyle = 'black'; ctx.fillRect(0, 0, 128, CONTENT_HEIGHT);
      ctx.fillStyle = 'white';
      lines.slice(start, start + 2).forEach((value, y) => ctx.fillText(value, 1, y * 14));
      const rgba = ctx.getImageData(0, 0, 128, CONTENT_HEIGHT).data;
      const bitmap = Buffer.alloc(PAGE_BYTES);
      for (let pixel = 0; pixel < 128 * CONTENT_HEIGHT; pixel++) {
        if (rgba[pixel * 4] > 100) bitmap[pixel >> 3] |= 0x80 >> (pixel & 7);
      }
      pages.push(bitmap);
    }
    return pages;
  }
}
