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
const LOOPBACK = new Set(['127.0.0.1', '::1']);
const FORWARD_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'cf-connecting-ip', 'true-client-ip'];
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function socketIp(req: any): string {
  return String(req.socket?.remoteAddress || req.connection?.remoteAddress || '').replace(/^::ffff:/, '');
}
/** True when a proxy or tunnel (cloudflared, ngrok, nginx…) forwarded the request. */
export function isForwarded(req: any): boolean {
  return FORWARD_HEADERS.some(h => req.headers?.[h] !== undefined);
}

/**
 * Address of the real client. A tunnel on this machine (cloudflared, ngrok…) connects from
 * 127.0.0.1, so every Internet visitor would look local and share one address (one visitor's
 * wrong passwords would lock everybody out). For connections from this machine only, the
 * address the tunnel reports is used: CF-Connecting-IP, else the LAST X-Forwarded-For entry
 * (the one the proxy appended; earlier entries come from the visitor and can be forged).
 * TRUST_PROXY=false turns this off.
 */
export function clientIp(req: any): string {
  const ip = socketIp(req);
  if (process.env.TRUST_PROXY !== 'false' && LOOPBACK.has(ip)) {
    const xff = String(req.headers?.['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
    const forwarded = String(req.headers?.['cf-connecting-ip'] || xff.at(-1) || req.headers?.['x-real-ip'] || '')
      .trim().replace(/^::ffff:/, '');
    if (forwarded && /^[0-9a-f:.]{2,45}$/i.test(forwarded)) return forwarded;
  }
  return ip;
}

/**
 * Already HTTPS for the visitor: a tunnel on this machine (cloudflared, ngrok…) terminated
 * TLS and says so in X-Forwarded-Proto / CF-Visitor. Trusted only from loopback, like clientIp;
 * such requests must not be redirected to :3443, which the tunnel does not carry.
 */
export function isProxiedHttps(req: any): boolean {
  if (process.env.TRUST_PROXY === 'false' || !LOOPBACK.has(socketIp(req))) return false;
  const proto = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return proto === 'https' || /"scheme"\s*:\s*"https"/i.test(String(req.headers?.['cf-visitor'] || ''));
}

/**
 * A request typed on this very machine: loopback socket, addressed to localhost, and not
 * relayed by a proxy/tunnel. Used for first-account setup and to keep localhost on HTTP.
 */
export function isDirectLocal(req: any): boolean {
  const host = String(req.headers?.host || '').toLowerCase().replace(/:\d+$/, '');
  return LOOPBACK.has(socketIp(req)) && LOCAL_HOSTS.has(host) && !isForwarded(req);
}

/** Client on this machine or the same private network (not relayed from the Internet). */
export function isPrivateClient(req: any): boolean {
  if (isForwarded(req)) return false;
  const ip = socketIp(req);
  return LOOPBACK.has(ip) || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|f[cd][0-9a-f]{2}:|fe80:)/i.test(ip);
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
