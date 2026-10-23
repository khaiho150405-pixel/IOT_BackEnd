import { createCanvas } from '@napi-rs/canvas';
import { mkdirSync, writeFileSync } from 'node:fs';
import { OledRenderer } from '../src/aiot/display';
// Use the same question/answer path as AiotGateway.show().
const pages = new OledRenderer().conversation(
  'Nhiệt độ và độ ẩm trong phòng?',
  'Nhiệt độ 28,5°C, độ ẩm 65%. Đã tắt đèn.',
);
const scale = 4;
const canvas = createCanvas(128 * scale, 64 * scale * pages.length);
const ctx = canvas.getContext('2d');
ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
ctx.fillStyle = '#fff'; ctx.font = '28px monospace'; ctx.textBaseline = 'top';
pages.forEach((page, index) => {
  const y = index * 64 * scale;
  // Match the 128x64 firmware coordinates; 4x zoom makes individual pixels visible.
  ctx.font = '28px monospace';
  ctx.fillText('TEMP', 0, y);
  ctx.fillText('HUMIDITY', 72 * scale, y);
  ctx.font = '56px monospace';
  ctx.fillText('28.5C', 0, y + 9 * scale);
  ctx.fillText('65%', 72 * scale, y + 9 * scale);
  ctx.font = '28px monospace';
  ctx.fillText('LISTEN', 0, y + 27 * scale);
  ctx.fillText('LED:OFF', 50 * scale, y + 27 * scale);
  ctx.fillText(`${index + 1}/${pages.length}`, 98 * scale, y + 27 * scale);
  ctx.fillRect(0, y + 35 * scale, 128 * scale, scale);
  for (let pixel = 0; pixel < 128 * 28; pixel++) {
    if (page[pixel >> 3] & (0x80 >> (pixel & 7))) {
      ctx.fillRect((pixel % 128) * scale, y + 36 * scale + Math.floor(pixel / 128) * scale, scale, scale);
    }
  }
});
mkdirSync('../.pio', { recursive: true });
writeFileSync('../.pio/oled-preview.png', canvas.toBuffer('image/png'));
console.log(`Rendered ${pages.length} OLED pages to ../.pio/oled-preview.png`);
