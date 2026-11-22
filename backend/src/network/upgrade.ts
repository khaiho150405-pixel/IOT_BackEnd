import type { Server as HttpServer } from 'node:http';
import type { WebSocketServer } from 'ws';

/**
 * Several WebSocket endpoints (ESP32 /aiot, browser /api/live) share the HTTP and HTTPS
 * servers. A WebSocketServer bound with { server, path } rejects every other path, so
 * each endpoint uses { noServer: true } and this router dispatches upgrades by path.
 */
const routes = new WeakMap<HttpServer, Map<string, WebSocketServer>>();

export function routeUpgrade(server: HttpServer, path: string, wss: WebSocketServer) {
  let table = routes.get(server);
  if (!table) {
    const created = new Map<string, WebSocketServer>();
    table = created;
    routes.set(server, created);
    server.on('upgrade', (req, socket, head) => {
      let pathname = '/';
      try { pathname = new URL(req.url ?? '/', 'http://local').pathname; } catch { /* invalid URL */ }
      const target = created.get(pathname);
      if (!target) { socket.destroy(); return; }
      target.handleUpgrade(req, socket, head, ws => target.emit('connection', ws, req));
    });
  }
  table.set(path, wss);
}
