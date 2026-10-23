import 'reflect-metadata';
import 'dotenv/config';
import {
  BadGatewayException, BadRequestException, ConflictException, Controller, ForbiddenException,
  Get, Inject, Module, NotFoundException, Param, Post, Body, Req, Res,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AiotGateway } from './aiot/aiot.gateway';
import { AiotService } from './aiot/aiot.service';
import { HistoryStore } from './aiot/history';
import { AiotMqttService } from './aiot/mqtt.service';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

function allowLocalDashboard(req: any) {
  const address = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (address !== '127.0.0.1' && address !== '::1') throw new ForbiddenException('Dashboard API chỉ dùng trên máy chạy backend.');
  const origin = req.headers.origin;
  if (origin) {
    try {
      const parsed = new URL(origin);
      const localOrigin = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
      if (!localOrigin || parsed.host.toLowerCase() !== String(req.headers.host || '').toLowerCase())
        throw new ForbiddenException('Yêu cầu dashboard không cùng nguồn.');
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;
      throw new ForbiddenException('Origin không hợp lệ.');
    }
  }
}

function verifyAdminPin(req: any, body?: any) {
  const expectedPin = (process.env.ADMIN_PIN || '1504').trim();
  const authHeader = req.headers['authorization'] || '';
  const bearerToken = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
  const supplied = req.headers['x-admin-pin'] || bearerToken || body?.pin;
  if (!supplied || String(supplied).trim() !== expectedPin) {
    throw new ForbiddenException('Chế độ chỉ xem. Bạn cần nhập mã PIN quản trị viên để điều khiển.');
  }
}

@Controller()
class HealthController {
  constructor(@Inject(AiotGateway) private readonly gateway: AiotGateway) {}

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

  @Get('dashboard')
  async dashboard(@Res() response: any) {
    const html = await readFile(join(process.cwd(), 'public', 'dashboard.html'), 'utf8');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.type('html').send(html);
  }

  @Get('mobile')
  async mobile(@Res() response: any) {
    const html = await readFile(join(process.cwd(), 'public', 'mobile.html'), 'utf8');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.type('html').send(html);
  }

  @Post('api/mobile/auth')
  mobileAuth(@Body() body: any) {
    const expectedPin = (process.env.ADMIN_PIN || '1504').trim();
    if (!body?.pin || String(body.pin).trim() !== expectedPin) {
      throw new ForbiddenException('Mã PIN quản trị không chính xác.');
    }
    return {
      success: true,
      role: 'admin',
      message: 'Xác thực quyền quản trị thành công! Em chào đại ca.',
    };
  }

  @Get('api/mobile/info')
  mobileInfo(@Req() req: any) {
    const host = req.headers.host ? req.headers.host.split(':')[0] : '127.0.0.1';
    return {
      auth: {
        requiresPin: true,
      },
      broker: {
        host,
        port: Number(process.env.MQTT_PORT || 1883),
        topics: {
          command: 'aiot/command',
          deviceCommand: 'aiot/device/<MAC>/command',
          sensor: 'aiot/sensor',
          state: 'aiot/state',
          chat: 'aiot/chat',
          ledSet: 'aiot/led/set',
          ledStatus: 'aiot/led/status',
        },
      },
      devices: this.gateway.dashboardDevices(),
    };
  }

  @Get('api/mobile/devices')
  mobileDevices() {
    return { devices: this.gateway.dashboardDevices() };
  }

  @Post('api/mobile/devices/:deviceId/led')
  async mobileSetLed(@Req() req: any, @Param('deviceId') deviceId: string, @Body() body: any) {
    verifyAdminPin(req, body);
    if (typeof body?.enabled !== 'boolean') throw new BadRequestException('enabled phải là true hoặc false.');
    try {
      return await this.gateway.setDashboardLed(deviceId, body.enabled);
    } catch (error) {
      if ((error as Error).message === 'DEVICE_OFFLINE') throw new NotFoundException('ESP32 đang offline.');
      if ((error as Error).message === 'DEVICE_BUSY') throw new ConflictException('ESP32 đang xử lý lượt giọng nói.');
      throw error;
    }
  }

  @Post('api/mobile/devices/:deviceId/text')
  async mobileSubmitText(@Req() req: any, @Param('deviceId') deviceId: string, @Body() body: any) {
    verifyAdminPin(req, body);
    if (typeof body?.text !== 'string' || !body.text.trim() || [...body.text].length > 400)
      throw new BadRequestException('Nhập câu dài tối đa 400 ký tự.');
    try {
      return await this.gateway.submitDashboardText(deviceId, body.text);
    } catch (error) {
      if ((error as Error).message === 'DEVICE_OFFLINE') throw new NotFoundException('ESP32 đang offline.');
      if ((error as Error).message === 'DEVICE_BUSY') throw new ConflictException('ESP32 đang xử lý lượt khác.');
      if ((error as Error).message === 'TURN_FAILED') throw new BadGatewayException('AI chưa xử lý được câu này.');
      throw error;
    }
  }

  @Get('api/dashboard/devices')
  devices(@Req() req: any) {
    allowLocalDashboard(req);
    return { devices: this.gateway.dashboardDevices() };
  }

  @Post('api/dashboard/devices/:deviceId/led')
  async setLed(@Req() req: any, @Param('deviceId') deviceId: string, @Body() body: any) {
    allowLocalDashboard(req);
    if (typeof body?.enabled !== 'boolean') throw new BadRequestException('enabled phải là true hoặc false.');
    try {
      return await this.gateway.setDashboardLed(deviceId, body.enabled);
    } catch (error) {
      if ((error as Error).message === 'DEVICE_OFFLINE') throw new NotFoundException('ESP32 đang offline.');
      if ((error as Error).message === 'DEVICE_BUSY') throw new ConflictException('ESP32 đang xử lý lượt giọng nói.');
      throw error;
    }
  }

  @Post('api/dashboard/devices/:deviceId/text')
  async submitText(@Req() req: any, @Param('deviceId') deviceId: string, @Body() body: any) {
    allowLocalDashboard(req);
    if (typeof body?.text !== 'string' || !body.text.trim() || [...body.text].length > 400)
      throw new BadRequestException('Nhập câu dài tối đa 400 ký tự.');
    try {
      return await this.gateway.submitDashboardText(deviceId, body.text);
    } catch (error) {
      if ((error as Error).message === 'DEVICE_OFFLINE') throw new NotFoundException('ESP32 đang offline.');
      if ((error as Error).message === 'DEVICE_BUSY') throw new ConflictException('ESP32 đang xử lý lượt khác.');
      if ((error as Error).message === 'TURN_FAILED') throw new BadGatewayException('AI chưa xử lý được câu này. Kiểm tra backend/API rồi thử lại.');
      throw error;
    }
  }
}
@Module({ controllers: [HealthController], providers: [AiotGateway, AiotService, HistoryStore, AiotMqttService] })
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
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';
  await app.listen(port, host);
  console.log(`[AIoT] Server is listening at http://${host}:${port}`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
