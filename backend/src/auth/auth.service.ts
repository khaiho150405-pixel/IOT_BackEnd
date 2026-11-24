import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource, IsNull } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  AuditLog, AuditSource, Device, Permission, RefreshToken, Role, Room, User, authEntities,
} from './entities';
import { hashPassword, randomToken, sha256, signJwt, verifyJwt, verifyPassword } from './crypto';

export type Action =
  | 'device:view' | 'device:control' | 'device:chat'   // per device
  | 'device:manage' | 'user:manage' | 'audit:view';    // administration

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  expiresAt: Date | null;
}
export interface DeviceAccess { view: boolean; control: boolean; chat: boolean }
export interface UserInput {
  username?: string; displayName?: string; password?: string; role?: Role;
  active?: boolean; expiresAt?: string | null;
}
export interface AuditInput {
  user?: AuthUser | null; username?: string; source: AuditSource; action: string;
  deviceId?: string | null; detail?: string; result?: AuditLog['result']; ip?: string;
}
export interface Tokens { accessToken: string; refreshToken: string; expiresIn: number; user: PublicUser }
export type PublicUser = Omit<User, 'passwordHash' | 'tokenVersion'>;

/** Errors carry an HTTP-ish code that the controller maps to a status. */
export class AuthError extends Error {
  constructor(public readonly code: 400 | 401 | 403 | 404 | 409 | 429, message: string) { super(message); }
}

const USERNAME = /^[a-zA-Z0-9._-]{3,32}$/;
const MAX_FAILURES = 5, FAILURE_WINDOW_MS = 15 * 60_000, LOCK_MS = 5 * 60_000;
// Per address, across all usernames: stops guessing passwords by rotating usernames.
const MAX_IP_FAILURES = 20, IP_LOCK_MS = 15 * 60_000, MAX_TRACKED = 10_000;
type FailureEntry = { count: number; first: number; lockedUntil: number };

@Injectable()
export class AuthService implements OnModuleInit, OnModuleDestroy {
  private db!: DataSource;
  private secret = '';
  private readyPromise?: Promise<void>;
  private failures = new Map<string, FailureEntry>();
  private ipFailures = new Map<string, FailureEntry>();
  private readonly accessTtl = Number(process.env.AUTH_ACCESS_TTL_S || 900);           // 15 min
  private readonly refreshTtl = Number(process.env.AUTH_REFRESH_TTL_S || 30 * 86400);  // 30 days

  async onModuleInit() { await this.ready(); }

  /** Storage: PostgreSQL when DATABASE_URL is set, otherwise a SQLite file (sql.js, no native build). */
  ready(): Promise<void> {
    this.readyPromise ??= (async () => {
      const postgres = !!process.env.DATABASE_URL;
      const file = process.env.AUTH_DB_FILE || join(process.cwd(), 'data', 'aiot.sqlite');
      const memory = !postgres && file === ':memory:';
      if (!postgres && !memory) mkdirSync(dirname(file), { recursive: true });
      this.db = new DataSource(postgres ?
        { type: 'postgres', url: process.env.DATABASE_URL, entities: authEntities(true), synchronize: true } :
        { type: 'sqljs', entities: authEntities(false), synchronize: true,
          ...(memory ? {} : { location: file, autoSave: true }) });
      await this.db.initialize();
      this.secret = this.loadSecret(memory || postgres ? undefined : join(dirname(file), 'auth-secret'));
      await this.unifyAccounts();
      await this.bootstrapOwnerFromEnv();
      console.log(`[Auth] Accounts stored in ${postgres ? 'PostgreSQL' : memory ? 'memory' : file}`);
    })();
    return this.readyPromise;
  }
  async onModuleDestroy() { if (this.db?.isInitialized) await this.db.destroy(); }

  /** Shared database for other stores (sensor history); dir is the data folder (undefined in memory/PostgreSQL). */
  async storage(): Promise<{ db: DataSource; dir?: string }> {
    await this.ready();
    const postgres = !!process.env.DATABASE_URL;
    const file = process.env.AUTH_DB_FILE || join(process.cwd(), 'data', 'aiot.sqlite');
    return { db: this.db, dir: postgres || file === ':memory:' ? undefined : dirname(file) };
  }

  private loadSecret(file?: string): string {
    const configured = process.env.AUTH_JWT_SECRET?.trim();
    if (configured) {
      if (configured.length < 32) throw new Error('AUTH_JWT_SECRET must be at least 32 characters.');
      return configured;
    }
    if (file && existsSync(file)) return readFileSync(file, 'utf8').trim();
    const generated = randomToken(48);
    if (file) writeFileSync(file, generated, { mode: 0o600 });
    return generated;
  }

  /**
   * One kind of account: everyone who signs in may control every device, chat and manage
   * accounts. Older member/guest accounts become full accounts and their per-device grants
   * are dropped. The first account ("owner") is only protected against lock-out.
   */
  private async unifyAccounts() {
    const users = this.users();
    const limited = await users.find({ where: [{ role: 'member' }, { role: 'guest' }] });
    if (!limited.length) return;
    for (const u of limited) await users.update({ id: u.id }, { role: 'admin', tokenVersion: u.tokenVersion + 1, updatedAt: new Date() });
    await this.permissions().clear();
    console.log(`[Auth] ${limited.length} limited account(s) now have full access (single account type).`);
  }

  private async bootstrapOwnerFromEnv() {
    // Runs inside ready(): must not call public methods that await ready() (deadlock).
    const username = process.env.OWNER_USERNAME?.trim(), password = process.env.OWNER_PASSWORD;
    if (!username || !password || await this.users().count()) return;
    await this.insertUser({ username, password, displayName: 'Chủ nhà', role: 'owner' });
    console.log(`[Auth] Owner account "${username}" created from OWNER_USERNAME/OWNER_PASSWORD.`);
  }

  private users() { return this.db.getRepository<User>('User'); }
  private rooms() { return this.db.getRepository<Room>('Room'); }
  private devices() { return this.db.getRepository<Device>('Device'); }
  private permissions() { return this.db.getRepository<Permission>('Permission'); }
  private refreshTokens() { return this.db.getRepository<RefreshToken>('RefreshToken'); }
  private audits() { return this.db.getRepository<AuditLog>('AuditLog'); }

  // ---------------------------------------------------------------- accounts

  async hasUsers(): Promise<boolean> {
    await this.ready();
    return (await this.users().count()) > 0;
  }

  /** First-run: creates the single owner. Refused once any account exists. */
  async setup(input: UserInput): Promise<PublicUser> {
    await this.ready();
    if (await this.users().count()) throw new AuthError(409, 'Hệ thống đã có tài khoản chủ nhà.');
    return this.publicUser(await this.insertUser({ ...input, role: 'owner' }));
  }

  async login(username: string, password: string, ip = '', userAgent = ''): Promise<Tokens> {
    const user = await this.checkCredentials(username, password, ip);
    return this.issueTokens(user, userAgent);
  }

  /** Username/password check shared by web login and MQTT, with lockout after repeated failures. */
  async checkCredentials(username: string, password: string, ip = ''): Promise<User> {
    await this.ready();
    const key = `${ip}|${String(username).toLowerCase()}`;
    const entry = this.failures.get(key);
    const ipEntry = this.ipFailures.get(ip);
    const lockedUntil = Math.max(entry?.lockedUntil ?? 0, ipEntry?.lockedUntil ?? 0);
    if (lockedUntil > Date.now())
      throw new AuthError(429, `Đăng nhập sai quá nhiều lần. Thử lại sau ${Math.ceil((lockedUntil - Date.now()) / 60000)} phút.`);
    const user = typeof username === 'string' ? await this.users().findOneBy({ username }) : null;
    const ok = !!user && typeof password === 'string' && await verifyPassword(password, user.passwordHash);
    if (!ok || !this.isUsable(user!)) {
      this.recordFailure(this.failures, key, MAX_FAILURES, LOCK_MS);
      this.recordFailure(this.ipFailures, ip, MAX_IP_FAILURES, IP_LOCK_MS);
      if (ok && user && !this.isUsable(user)) throw new AuthError(403, 'Tài khoản đã bị khóa hoặc hết hạn.');
      throw new AuthError(401, 'Sai tên đăng nhập hoặc mật khẩu.');
    }
    this.failures.delete(key);
    return user!;
  }

  private recordFailure(map: Map<string, FailureEntry>, key: string, max: number, lockMs: number) {
    const now = Date.now();
    if (map.size >= MAX_TRACKED) {
      // Bounded memory: forget entries that are neither recent nor locked.
      for (const [k, e] of map) if (e.lockedUntil <= now && now - e.first >= FAILURE_WINDOW_MS) map.delete(k);
      if (map.size >= MAX_TRACKED) map.delete(map.keys().next().value!);
    }
    const entry = map.get(key);
    const next = entry && now - entry.first < FAILURE_WINDOW_MS ?
      { ...entry, count: entry.count + 1 } : { count: 1, first: now, lockedUntil: 0 };
    if (next.count >= max) next.lockedUntil = now + lockMs;
    map.set(key, next);
  }

  private isUsable(user: User): boolean {
    return user.active && (!user.expiresAt || new Date(user.expiresAt).getTime() > Date.now());
  }

  private async issueTokens(user: User, userAgent: string): Promise<Tokens> {
    const refreshToken = randomToken(32);
    await this.refreshTokens().insert({
      id: randomUUID(), userId: user.id, tokenHash: sha256(refreshToken),
      expiresAt: new Date(Date.now() + this.refreshTtl * 1000), createdAt: new Date(), revokedAt: null,
      userAgent: String(userAgent).slice(0, 200),
    });
    return {
      accessToken: signJwt({ sub: user.id, role: user.role, tv: user.tokenVersion }, this.secret, this.accessTtl),
      refreshToken, expiresIn: this.accessTtl, user: this.publicUser(user),
    };
  }

  /** Rotates the refresh token. Presenting an already-used token revokes the whole family (theft). */
  async refresh(refreshToken: string, userAgent = ''): Promise<Tokens> {
    await this.ready();
    const row = typeof refreshToken === 'string' ?
      await this.refreshTokens().findOneBy({ tokenHash: sha256(refreshToken) }) : null;
    if (!row) throw new AuthError(401, 'Phiên đăng nhập không hợp lệ.');
    if (row.revokedAt) {
      await this.revokeAllRefreshTokens(row.userId);
      throw new AuthError(401, 'Phiên đăng nhập đã bị thu hồi. Hãy đăng nhập lại.');
    }
    if (new Date(row.expiresAt).getTime() <= Date.now()) throw new AuthError(401, 'Phiên đăng nhập đã hết hạn.');
    const user = await this.users().findOneBy({ id: row.userId });
    if (!user || !this.isUsable(user)) throw new AuthError(403, 'Tài khoản đã bị khóa hoặc hết hạn.');
    await this.refreshTokens().update({ id: row.id }, { revokedAt: new Date() });
    return this.issueTokens(user, userAgent);
  }

  async logout(refreshToken: string) {
    await this.ready();
    if (typeof refreshToken !== 'string') return;
    await this.refreshTokens().update({ tokenHash: sha256(refreshToken), revokedAt: IsNull() }, { revokedAt: new Date() });
  }

  private async revokeAllRefreshTokens(userId: string) {
    await this.refreshTokens().update({ userId, revokedAt: IsNull() }, { revokedAt: new Date() });
  }

  /** Validates an access token against the current account (active, not expired, same token version). */
  async authenticate(accessToken?: string): Promise<AuthUser | undefined> {
    await this.ready();
    const claims = accessToken ? verifyJwt(accessToken, this.secret) : undefined;
    if (!claims) return undefined;
    const user = await this.users().findOneBy({ id: claims.sub });
    if (!user || !this.isUsable(user) || user.tokenVersion !== claims.tv) return undefined;
    return this.authUser(user);
  }

  async changePassword(actor: AuthUser, oldPassword: string, newPassword: string) {
    const user = await this.users().findOneByOrFail({ id: actor.id });
    if (!await verifyPassword(String(oldPassword), user.passwordHash)) throw new AuthError(403, 'Mật khẩu hiện tại không đúng.');
    this.checkPassword(newPassword);
    await this.users().update({ id: user.id }, {
      passwordHash: await hashPassword(newPassword), tokenVersion: user.tokenVersion + 1, updatedAt: new Date(),
    });
    await this.revokeAllRefreshTokens(user.id);
  }

  // ---------------------------------------------------------------- authorization

  /** Every signed-in account sees, controls and chats with every known device. */
  async deviceAccess(_user: AuthUser): Promise<Map<string, DeviceAccess>> {
    await this.ready();
    const devices = await this.devices().find();
    return new Map(devices.map(d => [d.id, { view: true, control: true, chat: true }]));
  }

  /** Single account type: a valid, active account may do everything (visitors without one only see /api/public). */
  async can(_user: AuthUser, _action: Action, _deviceId?: string): Promise<boolean> {
    return true;
  }

  // ---------------------------------------------------------------- user management

  async listUsers(): Promise<PublicUser[]> {
    await this.ready();
    return (await this.users().find({ order: { createdAt: 'ASC' } })).map(u => this.publicUser(u));
  }

  /** Any account may add more accounts; they all get the same full access. */
  async createUser(_actor: AuthUser, input: UserInput): Promise<PublicUser> {
    return this.publicUser(await this.insertUser({ ...input, role: 'admin', expiresAt: null }));
  }

  async updateUser(actor: AuthUser, id: string, input: UserInput): Promise<PublicUser> {
    const user = await this.users().findOneBy({ id });
    if (!user) throw new AuthError(404, 'Không tìm thấy người dùng.');
    const changes: Partial<User> = { updatedAt: new Date() };
    let invalidate = false;
    if (input.displayName !== undefined) changes.displayName = this.checkDisplayName(input.displayName);
    if (input.active !== undefined && !!input.active !== user.active) {
      if (!input.active) this.assertCanRemove(actor, user, 'khóa');
      changes.active = !!input.active; invalidate ||= !input.active;
    }
    if (input.expiresAt !== undefined) changes.expiresAt = this.checkExpiry(input.expiresAt, user.role);
    if (input.password !== undefined) {
      // The first account's password is changed only by its holder (it cannot be taken over).
      if (user.role === 'owner' && actor.id !== user.id) throw new AuthError(403, 'Chỉ người dùng tài khoản đầu tiên mới đổi được mật khẩu của nó.');
      this.checkPassword(input.password);
      changes.passwordHash = await hashPassword(input.password); invalidate = true;
    }
    if (invalidate) changes.tokenVersion = user.tokenVersion + 1;
    await this.users().update({ id }, changes);
    if (invalidate) await this.revokeAllRefreshTokens(id);
    return this.publicUser({ ...user, ...changes } as User);
  }

  async deleteUser(actor: AuthUser, id: string) {
    const user = await this.users().findOneBy({ id });
    if (!user) throw new AuthError(404, 'Không tìm thấy người dùng.');
    this.assertCanRemove(actor, user, 'xóa');
    await this.permissions().delete({ userId: id });
    await this.refreshTokens().delete({ userId: id });
    await this.users().delete({ id });
  }

  /** Keeps at least one way in: the first account and your own account cannot be locked or deleted. */
  private assertCanRemove(actor: AuthUser, target: User, verb: string) {
    if (target.role === 'owner') throw new AuthError(403, `Không thể ${verb} tài khoản đầu tiên của hệ thống.`);
    if (target.id === actor.id) throw new AuthError(403, `Không thể tự ${verb} tài khoản đang dùng.`);
  }

  private async insertUser(input: UserInput & { role: Role }): Promise<User> {
    const username = String(input.username ?? '').trim();
    if (!USERNAME.test(username)) throw new AuthError(400, 'Tên đăng nhập 3–32 ký tự: chữ, số, dấu chấm, gạch dưới, gạch ngang.');
    this.checkPassword(input.password);
    if (await this.users().findOneBy({ username })) throw new AuthError(409, 'Tên đăng nhập đã tồn tại.');
    const now = new Date();
    const user: User = {
      id: randomUUID(), username, displayName: this.checkDisplayName(input.displayName ?? username),
      passwordHash: await hashPassword(input.password!), role: input.role, active: input.active ?? true,
      expiresAt: this.checkExpiry(input.expiresAt ?? null, input.role), tokenVersion: 0, createdAt: now, updatedAt: now,
    };
    await this.users().insert(user);
    return user;
  }
  private checkPassword(password?: string) {
    if (typeof password !== 'string' || password.length < 8 || password.length > 128)
      throw new AuthError(400, 'Mật khẩu phải từ 8 đến 128 ký tự.');
  }
  private checkDisplayName(name: string): string {
    const value = String(name).trim();
    if (!value || [...value].length > 120) throw new AuthError(400, 'Tên hiển thị không hợp lệ.');
    return value;
  }
  /** Guests always expire (default 24 h); others only when an expiry is given. */
  private checkExpiry(value: string | null | undefined, role: Role): Date | null {
    if (value === null || value === undefined || value === '') {
      return role === 'guest' ? new Date(Date.now() + 24 * 3600_000) : null;
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) throw new AuthError(400, 'Thời hạn phải là thời điểm trong tương lai.');
    return date;
  }

  // ---------------------------------------------------------------- devices & rooms

  /** Called when an ESP32 says hello: known devices get lastSeenAt, new ones are registered. */
  async touchDevice(id: string) {
    await this.ready();
    const existing = await this.devices().findOneBy({ id });
    if (existing) await this.devices().update({ id }, { lastSeenAt: new Date() });
    else await this.devices().insert({ id, name: `ESP32 ${id.slice(-5)}`, roomId: null, createdAt: new Date(), lastSeenAt: new Date() });
  }
  async listDevices(): Promise<Device[]> { await this.ready(); return this.devices().find({ order: { createdAt: 'ASC' } }); }
  async updateDevice(id: string, input: { name?: string; roomId?: string | null }): Promise<Device> {
    const device = await this.devices().findOneBy({ id });
    if (!device) throw new AuthError(404, 'Không tìm thấy thiết bị.');
    const changes: Partial<Device> = {};
    if (input.name !== undefined) changes.name = this.checkDisplayName(input.name);
    if (input.roomId !== undefined) {
      if (input.roomId && !await this.rooms().findOneBy({ id: input.roomId })) throw new AuthError(404, 'Không tìm thấy phòng.');
      changes.roomId = input.roomId || null;
    }
    await this.devices().update({ id }, changes);
    return { ...device, ...changes };
  }
  async listRooms(): Promise<Room[]> { await this.ready(); return this.rooms().find({ order: { createdAt: 'ASC' } }); }
  async createRoom(name: string): Promise<Room> {
    const room = { id: randomUUID(), name: this.checkDisplayName(name), createdAt: new Date() };
    await this.rooms().insert(room);
    return room;
  }
  async deleteRoom(id: string) {
    await this.devices().update({ roomId: id }, { roomId: null });
    await this.permissions().delete({ roomId: id });
    await this.rooms().delete({ id });
  }

  // ---------------------------------------------------------------- audit

  async audit(entry: AuditInput) {
    try {
      await this.ready();
      await this.audits().insert({
        id: randomUUID(), at: new Date(), userId: entry.user?.id ?? null,
        username: (entry.user?.username ?? entry.username ?? 'system').slice(0, 64),
        source: entry.source, action: entry.action.slice(0, 64), deviceId: entry.deviceId ?? null,
        detail: (entry.detail ?? '').slice(0, 1000), result: entry.result ?? 'ok', ip: (entry.ip ?? '').slice(0, 64),
      });
    } catch (error) {
      console.warn(`[Auth] Audit write failed: ${(error as Error).message}`);
    }
  }
  async listAudit(_user: AuthUser, limit = 100): Promise<AuditLog[]> {
    await this.ready();
    return this.audits().find({ order: { at: 'DESC' }, take: Math.min(Math.max(1, limit), 500) });
  }

  // ---------------------------------------------------------------- helpers

  publicUser(user: User): PublicUser {
    const { passwordHash: _hash, tokenVersion: _version, ...rest } = user;
    return rest;
  }
  private authUser(user: User): AuthUser {
    return { id: user.id, username: user.username, displayName: user.displayName, role: user.role, expiresAt: user.expiresAt };
  }
  /** For MQTT: account object for an already verified user. */
  toAuthUser(user: User): AuthUser { return this.authUser(user); }
}

