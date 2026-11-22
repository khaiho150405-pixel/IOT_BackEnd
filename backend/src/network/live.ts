import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import type { Server as HttpServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { AuthService, AuthUser } from '../auth/auth.service';
import { DevicesService } from '../aiot/devices.service';
import { routeUpgrade } from './upgrade';

interface LiveClient { ws: WebSocket; token?: string; user?: AuthUser; guest?: boolean; last?: string; busy?: boolean }

/**
 * /api/live: pushes each browser its device view whenever something changes (connection,
 * sensor, LED, busy), instead of the page polling every 2 s. Signed-in browsers get the full
 * view; visitors send {type:'guest'} and get the read-only public view (sensors + LED state).
 * The access token travels in the first message (never in the URL); the client sends a
 * new one after refreshing, and the server stops pushing when a token expires.
 */
@Injectable()
export class LiveHub implements OnModuleDestroy {
  private wss = new WebSocketServer({ noServer: true, maxPayload: 8192, perMessageDeflate: false });
  private clients = new Set<LiveClient>();
  private timer?: NodeJS.Timeout;
  private readonly maxClients = Number(process.env.LIVE_MAX_CLIENTS || 50);

  constructor(@Inject(AuthService) private auth: AuthService, @Inject(DevicesService) private devices: DevicesService) {
    this.wss.on('connection', ws => this.connect(ws));
  }

  attach(server: HttpServer) {
    routeUpgrade(server, '/api/live', this.wss);
    if (!this.timer) {
      // Change detection: compare each client's view twice a second, send only differences.
      this.timer = setInterval(() => { for (const c of this.clients) void this.push(c); }, 500);
      this.timer.unref();
    }
  }

  private connect(ws: WebSocket) {
    if (this.clients.size >= this.maxClients) { ws.close(1013, 'busy'); return; }
    const client: LiveClient = { ws };
    this.clients.add(client);
    const deadline = setTimeout(() => { if (!client.user && !client.guest) ws.close(4401, 'auth required'); }, 10_000);
    ws.on('message', async data => {
      let message: any;
      try { message = JSON.parse(data.toString()); } catch { return; }
      if (message?.type === 'guest') {
        client.guest = true; client.token = undefined; client.user = undefined; client.last = undefined;
        clearTimeout(deadline);
        this.send(client, { type: 'ready', user: null });
        await this.push(client);
        return;
      }
      if (message?.type !== 'auth' || typeof message.token !== 'string') return;
      const user = await this.auth.authenticate(message.token);
      if (!user) { this.send(client, { type: 'auth_failed' }); ws.close(4401, 'auth failed'); return; }
      client.token = message.token; client.user = user; client.guest = false; client.last = undefined;
      clearTimeout(deadline);
      this.send(client, { type: 'ready', user });
      await this.push(client);
    });
    ws.on('close', () => { clearTimeout(deadline); this.clients.delete(client); });
    ws.on('error', () => ws.terminate());
  }

  private async push(client: LiveClient) {
    if (client.busy || client.ws.readyState !== WebSocket.OPEN) return;
    if (!client.guest && (!client.user || !client.token)) return;
    client.busy = true;
    try {
      if (client.guest) {
        const devices = await this.devices.publicDevices();
        const signature = JSON.stringify(devices);
        if (signature !== client.last) { client.last = signature; this.send(client, { type: 'devices', devices }); }
        return;
      }
      const user = await this.auth.authenticate(client.token!);
      if (!user) {
        client.user = undefined;
        this.send(client, { type: 'auth_required' });
        return;
      }
      client.user = user;
      const devices = await this.devices.visibleDevices(user);
      const signature = JSON.stringify(devices);
      if (signature !== client.last) {
        client.last = signature;
        this.send(client, { type: 'devices', devices });
      }
    } catch (error) {
      console.warn(`[Live] push failed: ${(error as Error).message}`);
    } finally {
      client.busy = false;
    }
  }

  private send(client: LiveClient, message: unknown) {
    if (client.ws.readyState === WebSocket.OPEN && client.ws.bufferedAmount < 256 * 1024) client.ws.send(JSON.stringify(message));
  }

  onModuleDestroy() {
    clearInterval(this.timer);
    for (const c of this.clients) c.ws.terminate();
    this.wss.close();
  }
}
