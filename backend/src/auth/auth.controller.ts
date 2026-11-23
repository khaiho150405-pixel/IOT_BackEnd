import {
  Body, Controller, Delete, ForbiddenException, Get, Inject, Param, Patch, Post, Query, Req,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { Require, clientIp, clientSource, currentUser, httpError, isDirectLocal } from './auth.guard';


@Controller('api')
export class AuthController {
  constructor(@Inject(AuthService) private auth: AuthService) {}

  // ------------------------------------------------------------ session

  /** Lets the login page decide between "create owner" and "sign in". */
  @Get('auth/status')
  async status() {
    return { setupRequired: !(await this.auth.hasUsers()) };
  }

  /** First run only, and only typed on the machine running the backend (never through a tunnel). */
  @Post('auth/setup')
  async setup(@Req() req: any, @Body() body: any) {
    if (!isDirectLocal(req)) throw new ForbiddenException('Tạo tài khoản chủ nhà chỉ làm được trên máy chạy backend.');
    try {
      const user = await this.auth.setup({ username: body?.username, password: body?.password, displayName: body?.displayName });
      void this.auth.audit({ username: user.username, source: clientSource(req), action: 'auth:setup', ip: clientIp(req) });
      return this.auth.login(body.username, body.password, clientIp(req), req.headers['user-agent']);
    } catch (error) { httpError(error); }
  }

  @Post('auth/login')
  async login(@Req() req: any, @Body() body: any) {
    try {
      const tokens = await this.auth.login(body?.username, body?.password, clientIp(req), req.headers['user-agent']);
      void this.auth.audit({ user: { ...tokens.user }, source: clientSource(req), action: 'auth:login', ip: clientIp(req) });
      return tokens;
    } catch (error) {
      void this.auth.audit({ username: String(body?.username ?? '').slice(0, 64), source: clientSource(req),
        action: 'auth:login', result: 'denied', ip: clientIp(req) });
      httpError(error);
    }
  }

  @Post('auth/refresh')
  async refresh(@Req() req: any, @Body() body: any) {
    try { return await this.auth.refresh(body?.refreshToken, req.headers['user-agent']); } catch (error) { httpError(error); }
  }

  @Post('auth/logout')
  async logout(@Body() body: any) {
    await this.auth.logout(body?.refreshToken);
    return { ok: true };
  }

  @Get('auth/me')
  @Require('authenticated')
  async me(@Req() req: any) {
    const user = currentUser(req);
    const access = await this.auth.deviceAccess(user);
    return { user, devices: Object.fromEntries(access) };
  }

  @Post('auth/password')
  @Require('authenticated')
  async changePassword(@Req() req: any, @Body() body: any) {
    try {
      await this.auth.changePassword(currentUser(req), body?.oldPassword, body?.newPassword);
      void this.auth.audit({ user: currentUser(req), source: clientSource(req), action: 'auth:password', ip: clientIp(req) });
      return { ok: true };
    } catch (error) { httpError(error); }
  }

  // ------------------------------------------------------------ users (every account)

  @Get('users')
  @Require('user:manage')
  async users() { return { users: await this.auth.listUsers() }; }

  @Post('users')
  @Require('user:manage')
  async createUser(@Req() req: any, @Body() body: any) {
    try {
      const user = await this.auth.createUser(currentUser(req), body ?? {});
      void this.auth.audit({ user: currentUser(req), source: clientSource(req), action: 'user:create',
        detail: user.username, ip: clientIp(req) });
      return user;
    } catch (error) { httpError(error); }
  }

  @Patch('users/:id')
  @Require('user:manage')
  async updateUser(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    try {
      const user = await this.auth.updateUser(currentUser(req), id, body ?? {});
      const fields = Object.keys(body ?? {}).map(k => (k === 'password' ? 'password(*)' : k)).join(', ');
      void this.auth.audit({ user: currentUser(req), source: clientSource(req), action: 'user:update',
        detail: `${user.username}: ${fields}`, ip: clientIp(req) });
      return user;
    } catch (error) { httpError(error); }
  }

  @Delete('users/:id')
  @Require('user:manage')
  async deleteUser(@Req() req: any, @Param('id') id: string) {
    try {
      await this.auth.deleteUser(currentUser(req), id);
      void this.auth.audit({ user: currentUser(req), source: clientSource(req), action: 'user:delete', detail: id, ip: clientIp(req) });
      return { ok: true };
    } catch (error) { httpError(error); }
  }

  // ------------------------------------------------------------ rooms & device settings (every account)

  @Get('rooms')
  @Require('authenticated')
  async rooms() { return { rooms: await this.auth.listRooms() }; }

  @Post('rooms')
  @Require('device:manage')
  async createRoom(@Req() req: any, @Body() body: any) {
    try {
      const room = await this.auth.createRoom(body?.name);
      void this.auth.audit({ user: currentUser(req), source: clientSource(req), action: 'room:create', detail: room.name, ip: clientIp(req) });
      return room;
    } catch (error) { httpError(error); }
  }

  @Delete('rooms/:id')
  @Require('device:manage')
  async deleteRoom(@Req() req: any, @Param('id') id: string) {
    await this.auth.deleteRoom(id);
    void this.auth.audit({ user: currentUser(req), source: clientSource(req), action: 'room:delete', detail: id, ip: clientIp(req) });
    return { ok: true };
  }

  @Patch('devices/:deviceId')
  @Require('device:manage')
  async updateDevice(@Req() req: any, @Param('deviceId') deviceId: string, @Body() body: any) {
    try {
      const device = await this.auth.updateDevice(deviceId, { name: body?.name, roomId: body?.roomId });
      void this.auth.audit({ user: currentUser(req), source: clientSource(req), action: 'device:update',
        deviceId, detail: JSON.stringify(body ?? {}).slice(0, 200), ip: clientIp(req) });
      return device;
    } catch (error) { httpError(error); }
  }

  // ------------------------------------------------------------ audit

  @Get('audit')
  @Require('audit:view')
  async audit(@Req() req: any, @Query('limit') limit?: string) {
    return { entries: await this.auth.listAudit(currentUser(req), Number(limit) || 100) };
  }
}
