import {
  CanActivate, ExecutionContext, ForbiddenException, HttpException, Inject, Injectable, SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Action, AuthError, AuthService, AuthUser } from './auth.service';
import { AuditSource } from './entities';

const REQUIRE = 'aiot:require';
interface Requirement { action: Action | 'authenticated'; deviceParam?: string }

/**
 * Marks a route as protected. `deviceParam` names the route parameter holding the
 * device id for per-device permissions (device:view/control/chat).
 */
export const Require = (action: Requirement['action'], deviceParam?: string) =>
  SetMetadata(REQUIRE, { action, deviceParam } satisfies Requirement);

export function bearer(req: any): string | undefined {
  const header = String(req.headers?.authorization || '');
  return header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : undefined;
}
export function clientIp(req: any): string {
  return String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}
/** The future native app sends X-Client: app; everything else counts as web. */
export function clientSource(req: any): AuditSource {
  return String(req.headers?.['x-client'] || '').toLowerCase() === 'app' ? 'app' : 'web';
}
export function currentUser(req: any): AuthUser {
  if (!req.user) throw new UnauthorizedException('Cần đăng nhập.');
  return req.user;
}

/** Global guard: routes without @Require stay public (health, pages, login). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(AuthService) private auth: AuthService, @Inject(Reflector) private reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requirement = this.reflector.getAllAndOverride<Requirement>(REQUIRE, [context.getHandler(), context.getClass()]);
    if (!requirement) return true;
    const req = context.switchToHttp().getRequest();
    const user = await this.auth.authenticate(bearer(req));
    if (!user) throw new UnauthorizedException('Phiên đăng nhập không hợp lệ hoặc đã hết hạn.');
    req.user = user;
    if (requirement.action === 'authenticated') return true;
    const deviceId = requirement.deviceParam ? req.params?.[requirement.deviceParam] : undefined;
    if (await this.auth.can(user, requirement.action, deviceId)) return true;
    void this.auth.audit({ user, source: clientSource(req), action: requirement.action, deviceId,
      result: 'denied', ip: clientIp(req), detail: `${req.method} ${req.url}` });
    throw new ForbiddenException('Bạn không có quyền thực hiện thao tác này.');
  }
}

/** Maps service errors to HTTP responses. */
export function httpError(error: unknown): never {
  if (error instanceof AuthError) throw new HttpException({ statusCode: error.code, message: error.message }, error.code);
  throw error;
}
