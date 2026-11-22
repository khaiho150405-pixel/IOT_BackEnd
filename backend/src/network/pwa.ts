import { createCanvas } from '@napi-rs/canvas';

/**
 * Progressive Web App pieces so the dashboard can be installed on a phone's home screen.
 * Installing needs a secure context (https://aiot.local with the local CA trusted, or localhost).
 */
export const MANIFEST = {
  name: 'AIoT Smart Room',
  short_name: 'AIoT',
  description: 'Điều khiển phòng thông minh: cảm biến, đèn, trợ lý AI.',
  id: '/dashboard',
  start_url: '/dashboard',
  scope: '/',
  display: 'standalone',
  orientation: 'portrait',
  background_color: '#f3f5f7',
  theme_color: '#456780',
  lang: 'vi',
  icons: [
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
};

const iconCache = new Map<string, Buffer>();

/** Draws the app icon (a lit bulb on the dashboard's blue). Maskable icons keep the art in the safe zone. */
export function appIcon(size: number, maskable = false): Buffer {
  const key = `${size}-${maskable}`;
  const cached = iconCache.get(key);
  if (cached) return cached;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, size, size);
  gradient.addColorStop(0, '#5b81a3');
  gradient.addColorStop(1, '#34536b');
  ctx.fillStyle = gradient;
  if (maskable) {
    ctx.fillRect(0, 0, size, size);
  } else {
    const r = size * 0.22;
    ctx.beginPath();
    ctx.moveTo(r, 0); ctx.arcTo(size, 0, size, size, r); ctx.arcTo(size, size, 0, size, r);
    ctx.arcTo(0, size, 0, 0, r); ctx.arcTo(0, 0, size, 0, r); ctx.closePath(); ctx.fill();
  }
  const scale = maskable ? 0.62 : 0.78; // maskable safe zone is the central 80% circle
  const u = (size * scale) / 100, ox = size / 2 - 50 * u, oy = size / 2 - 50 * u;
  const X = (v: number) => ox + v * u, Y = (v: number) => oy + v * u;
  // Glow
  const glow = ctx.createRadialGradient(X(50), Y(40), 0, X(50), Y(40), 45 * u);
  glow.addColorStop(0, 'rgba(255, 224, 130, 0.55)');
  glow.addColorStop(1, 'rgba(255, 224, 130, 0)');
  ctx.fillStyle = glow;
  ctx.beginPath(); ctx.arc(X(50), Y(40), 45 * u, 0, Math.PI * 2); ctx.fill();
  // Bulb
  ctx.fillStyle = '#ffe082';
  ctx.beginPath(); ctx.arc(X(50), Y(40), 22 * u, Math.PI * 0.8, Math.PI * 2.2); ctx.lineTo(X(60), Y(68)); ctx.lineTo(X(40), Y(68)); ctx.closePath(); ctx.fill();
  // Base
  ctx.fillStyle = '#e8eef3';
  ctx.fillRect(X(39), Y(72), 22 * u, 6 * u);
  ctx.fillRect(X(42), Y(81), 16 * u, 5 * u);
  const png = canvas.toBuffer('image/png');
  iconCache.set(key, png);
  return png;
}

/**
 * Service worker: keeps the app shell (pages, manifest, icons) for offline start and fast
 * launch, always tries the network first, and never caches /api (live data, accounts).
 */
export const SERVICE_WORKER = `
const CACHE = 'aiot-shell-v1';
const SHELL = ['/dashboard', '/mobile', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok && SHELL.includes(url.pathname)) {
      const copy = response.clone();
      caches.open(CACHE).then(cache => cache.put(event.request, copy));
    }
    return response;
  }).catch(() => caches.match(event.request).then(hit => hit || caches.match('/dashboard'))));
});
`;
