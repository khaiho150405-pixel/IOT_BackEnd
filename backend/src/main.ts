import 'reflect-metadata';
import 'dotenv/config';
import {
  BadGatewayException, BadRequestException, ConflictException, Controller,
  Get, Inject, Module, NotFoundException, Param, Post, Body, Req, Res,
} from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { AuthController } from './auth/auth.controller';
import { AuthGuard, Require, clientIp, clientSource, currentUser } from './auth/auth.guard';
import { AuthService, AuthUser } from './auth/auth.service';
import { AiotGateway } from './aiot/aiot.gateway';
import { AiotService } from './aiot/aiot.service';
import { HistoryStore } from './aiot/history';
import { AiotMqttService } from './aiot/mqtt.service';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer as createHttpsServer, Server as HttpsServer } from 'node:https';
import { DevicesService } from './aiot/devices.service';
import { LiveHub } from './network/live';
import { ensureTls, TlsMaterial } from './network/tls';
import { MdnsHandle, startMdns } from './network/mdns';
import { MANIFEST, SERVICE_WORKER, appIcon } from './network/pwa';

const PAGE_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/** Runtime network facts shared with the routes below (filled in by main()). */
const network: { tls?: TlsMaterial; httpsPort: number; mdnsName?: string } = { httpsPort: 3443 };

function isLocalRequest(req: any) {
  const host = String(req.hostname || req.headers?.host || '').split(':')[0].toLowerCase();
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host);
}

/**
 * Browsers on other machines are sent to HTTPS so passwords never cross the LAN in clear
 * text. localhost stays on HTTP (already private), and so do /trust and /ca.crt, which
 * phones need before they trust the certificate. HTTPS_REDIRECT=false disables this.
 */
function redirectToHttps(req: any, response: any): boolean {
  if (!network.tls || req.socket?.encrypted || isLocalRequest(req) || process.env.HTTPS_REDIRECT === 'false') return false;
  const host = String(req.hostname || req.headers?.host || '').split(':')[0];
  response.redirect(302, `https://${host}:${network.httpsPort}${req.originalUrl || req.url}`);
  return true;
}

async function sendPage(response: any, file: string, req?: any) {
  if (req && redirectToHttps(req, response)) return;
  const html = await readFile(join(process.cwd(), 'public', file), 'utf8');
  response.setHeader('Content-Security-Policy', PAGE_CSP);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.type('html').send(html);
}

function deviceError(error: unknown, busyMessage: string): never {
  const message = (error as Error).message;
  if (message === 'DEVICE_OFFLINE') throw new NotFoundException('ESP32 đang offline.');
  if (message === 'DEVICE_BUSY') throw new ConflictException(busyMessage);
  if (message === 'TURN_FAILED') throw new BadGatewayException('AI chưa xử lý được câu này. Kiểm tra backend/API rồi thử lại.');
  throw error;
}

@Controller()
class HealthController {
  constructor(@Inject(AiotGateway) private readonly gateway: AiotGateway,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(DevicesService) private readonly devicesView: DevicesService) {}

  @Get('health') health() {
    return {
      status: 'ok',
      protocol: 'aiot-pcm16-v2',
      mqtt: {
        enabled: process.env.MQTT_ENABLED !== 'false',
        port: Number(process.env.MQTT_PORT || 1883),
      },
    };
  }

  // Pages are public; every API they call requires a signed-in account.
  @Get() root(@Req() req: any, @Res() response: any) {
    if (!redirectToHttps(req, response)) response.redirect(302, '/dashboard');
  }
  @Get('dashboard') dashboard(@Req() req: any, @Res() response: any) { return sendPage(response, 'dashboard.html', req); }
  @Get('mobile') mobile(@Req() req: any, @Res() response: any) { return sendPage(response, 'mobile.html', req); }
  /** Certificate install guide; stays reachable over plain HTTP on purpose. */
  @Get('trust') trust(@Res() response: any) { return sendPage(response, 'trust.html'); }

  @Get('ca.crt')
  caCertificate(@Res() response: any) {
    if (!network.tls) throw new NotFoundException('HTTPS đang tắt.');
    response.setHeader('Content-Type', 'application/x-x509-ca-cert');
    response.setHeader('Content-Disposition', 'attachment; filename="aiot-smart-room-ca.crt"');
    response.send(network.tls.caCert);
  }

  /** Addresses for the /trust page (this server's own LAN names, nothing about users). */
  @Get('api/network')
  networkInfo() {
    return { https: !!network.tls, httpsPort: network.httpsPort, mdnsName: network.mdnsName ?? null,
      ips: network.tls?.ips.filter(ip => ip !== '127.0.0.1') ?? [] };
  }

  @Get('manifest.webmanifest')
  manifest(@Res() response: any) {
    response.type('application/manifest+json').send(JSON.stringify(MANIFEST));
  }

  @Get('sw.js')
  serviceWorker(@Res() response: any) {
    response.setHeader('Cache-Control', 'no-cache');
    response.type('application/javascript').send(SERVICE_WORKER);
  }

  @Get('icons/:file')
  icon(@Param('file') file: string, @Res() response: any) {
    const match = /^(icon|maskable|apple-touch)-(\d+)\.png$/.exec(file);
    const size = match ? Number(match[2]) : 0;
    if (!match || ![180, 192, 512].includes(size)) throw new NotFoundException();
    response.setHeader('Cache-Control', 'public, max-age=86400');
    response.type('png').send(appIcon(size, match[1] === 'maskable'));
  }

  @Get('api/mobile/info')
  @Require('authenticated')
  async mobileInfo(@Req() req: any) {
    const host = req.headers.host ? req.headers.host.split(':')[0] : '127.0.0.1';
    return {
      user: currentUser(req),
      broker: {
        host,
        port: Number(process.env.MQTT_PORT || 1883),
        // MQTT clients sign in with the same username/password and only see their devices.
        topics: {
          deviceCommand: 'aiot/device/<MAC>/command',
          deviceLedSet: 'aiot/device/<MAC>/led/set',
          deviceSensor: 'aiot/device/<MAC>/sensor',
          deviceState: 'aiot/device/<MAC>/state',
          deviceChat: 'aiot/device/<MAC>/chat',
        },
      },
      devices: await this.devicesView.visibleDevices(currentUser(req)),
    };
  }

  /** Live devices the user may see, with names/rooms and what the user may do on each. */
  @Get(['api/devices', 'api/dashboard/devices', 'api/mobile/devices'])
  @Require('authenticated')
  async devices(@Req() req: any) {
    return { devices: await this.devicesView.visibleDevices(currentUser(req)) };
  }

  @Post(['api/devices/:deviceId/led', 'api/dashboard/devices/:deviceId/led', 'api/mobile/devices/:deviceId/led'])
  @Require('device:control', 'deviceId')
  async setLed(@Req() req: any, @Param('deviceId') deviceId: string, @Body() body: any) {
    if (typeof body?.enabled !== 'boolean') throw new BadRequestException('enabled phải là true hoặc false.');
    const entry = { user: currentUser(req), source: clientSource(req), action: body.enabled ? 'led:on' : 'led:off',
      deviceId, ip: clientIp(req) } as const;
    try {
      const result = await this.gateway.setDashboardLed(deviceId, body.enabled);
      void this.auth.audit(entry);
      return result;
    } catch (error) {
      void this.auth.audit({ ...entry, result: 'error', detail: (error as Error).message });
      deviceError(error, 'ESP32 đang xử lý lượt giọng nói.');
    }
  }

  @Post(['api/devices/:deviceId/text', 'api/dashboard/devices/:deviceId/text', 'api/mobile/devices/:deviceId/text'])
  @Require('device:chat', 'deviceId')
  async submitText(@Req() req: any, @Param('deviceId') deviceId: string, @Body() body: any) {
    if (typeof body?.text !== 'string' || !body.text.trim() || [...body.text].length > 400)
      throw new BadRequestException('Nhập câu dài tối đa 400 ký tự.');
    const entry = { user: currentUser(req), source: clientSource(req), action: 'chat', deviceId, ip: clientIp(req) } as const;
    try {
      const result = await this.gateway.submitDashboardText(deviceId, body.text);
      void this.auth.audit({ ...entry, detail: `${body.text.slice(0, 200)} -> ${result.intent}` });
      return result;
    } catch (error) {
      void this.auth.audit({ ...entry, result: 'error', detail: (error as Error).message });
      deviceError(error, 'ESP32 đang xử lý lượt khác.');
    }
  }
}
@Module({
  controllers: [HealthController, AuthController],
  providers: [AuthService, { provide: APP_GUARD, useClass: AuthGuard },
    AiotGateway, AiotService, HistoryStore, AiotMqttService, DevicesService, LiveHub],
})
class AppModule {}

async function main() {
  const provider = (process.env.AI_PROVIDER || 'ollama').toLowerCase();
  if (!['gemini', 'ollama'].includes(provider)) throw new Error('AI_PROVIDER must be gemini or ollama.');
  if (provider === 'gemini' && (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY.startsWith('YOUR_')))
    throw new Error('Set GEMINI_API_KEY in backend/.env or choose AI_PROVIDER=ollama.');
  // OLLAMA_URL defaults to localhost; LOCALAPPDATA locates the local speech Python environment/models.
  if (provider === 'ollama' && !process.env.LOCALAPPDATA)
    throw new Error('LOCALAPPDATA is required to locate the local voice models.');
  if (!process.env.DEVICE_TOKEN || process.env.DEVICE_TOKEN.length < 24 || process.env.DEVICE_TOKEN.startsWith('CHANGE_ME'))
    throw new Error('Set a random DEVICE_TOKEN (24+ characters) in backend/.env and include/config.h');
  for (const [key, min, max] of [['VAD_RMS', 1, 20000], ['VAD_SILENCE_MS', 300, 3000], ['VAD_MAX_MS', 2000, 20000], ['PORT', 1, 65535]] as const) {
    if (process.env[key] && (!Number.isFinite(Number(process.env[key])) || Number(process.env[key]) < min || Number(process.env[key]) > max)) throw new Error(`Invalid ${key}`);
  }
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.init();
  app.get(AiotGateway).attach(app.getHttpServer());
  app.get(LiveHub).attach(app.getHttpServer());
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';
  await app.listen(port, host);
  console.log(`[AIoT] Server is listening at http://${host}:${port}`);

  // Local HTTPS for browsers/phones (the ESP32 keeps using plain ws:// on PORT).
  let httpsServer: HttpsServer | undefined;
  let mdns: MdnsHandle | undefined;
  const mdnsLabel = (process.env.MDNS_NAME || 'aiot').trim();
  if (process.env.HTTPS_ENABLED !== 'false') {
    network.httpsPort = Number(process.env.HTTPS_PORT || 3443);
    network.tls = ensureTls(process.env.TLS_DIR || join(process.cwd(), 'data', 'tls'), mdnsLabel);
    httpsServer = createHttpsServer({ key: network.tls.key, cert: network.tls.cert }, app.getHttpAdapter().getInstance());
    app.get(LiveHub).attach(httpsServer);
    await new Promise<void>((resolve, reject) => {
      httpsServer!.once('error', reject);
      httpsServer!.listen(network.httpsPort, host, () => resolve());
    });
    console.log(`[AIoT] HTTPS for browsers at https://${mdnsLabel}.local:${network.httpsPort} (install the CA from /trust)`);
  }
  if (process.env.MDNS_ENABLED !== 'false') {
    mdns = startMdns(mdnsLabel);
    if (mdns) network.mdnsName = mdns.name;
  }
  app.getHttpServer().once('close', () => { httpsServer?.close(); mdns?.stop(); });
}
main().catch(error => { console.error(error?.stack || error?.message || error); process.exitCode = 1; });
