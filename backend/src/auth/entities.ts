import { EntitySchema } from 'typeorm';

export type Role = 'owner' | 'admin' | 'member' | 'guest';
export const ROLES: readonly Role[] = ['owner', 'admin', 'member', 'guest'];
export type AuditSource = 'web' | 'app' | 'voice' | 'mqtt' | 'system';

export interface User {
  id: string;
  username: string;
  displayName: string;
  passwordHash: string;
  role: Role;
  active: boolean;
  /** Guests (and optionally others) lose access after this moment. */
  expiresAt: Date | null;
  /** Bumped to invalidate every issued access token at once (password change, role change). */
  tokenVersion: number;
  createdAt: Date;
  updatedAt: Date;
}
export interface Room { id: string; name: string; createdAt: Date }
export interface Device { id: string; name: string; roomId: string | null; createdAt: Date; lastSeenAt: Date | null }
/** Grants a member/guest access to one device or to every device of one room. */
export interface Permission {
  id: string;
  userId: string;
  deviceId: string | null;
  roomId: string | null;
  canControl: boolean;
  canChat: boolean;
  createdAt: Date;
}
export interface RefreshToken {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
  revokedAt: Date | null;
  userAgent: string;
}
export interface AuditLog {
  id: string;
  at: Date;
  userId: string | null;
  username: string;
  source: AuditSource;
  action: string;
  deviceId: string | null;
  detail: string;
  result: 'ok' | 'denied' | 'error';
  ip: string;
}

/** Column types differ between PostgreSQL and the SQLite (sql.js) fallback. */
export function authEntities(postgres: boolean) {
  const date = postgres ? 'timestamptz' : 'datetime';
  const id = { type: String, length: 64, primary: true } as const;
  return [
    new EntitySchema<User>({
      name: 'User', tableName: 'aiot_users',
      columns: {
        id,
        username: { type: String, length: 64, unique: true },
        displayName: { type: String, length: 120 },
        passwordHash: { type: String, length: 255 },
        role: { type: String, length: 16 },
        active: { type: Boolean, default: true },
        expiresAt: { type: date, nullable: true },
        tokenVersion: { type: Number, default: 0 },
        createdAt: { type: date },
        updatedAt: { type: date },
      },
    }),
    new EntitySchema<Room>({
      name: 'Room', tableName: 'aiot_rooms',
      columns: { id, name: { type: String, length: 120 }, createdAt: { type: date } },
    }),
    new EntitySchema<Device>({
      name: 'Device', tableName: 'aiot_devices',
      columns: {
        id, name: { type: String, length: 120 },
        roomId: { type: String, length: 64, nullable: true },
        createdAt: { type: date }, lastSeenAt: { type: date, nullable: true },
      },
    }),
    new EntitySchema<Permission>({
      name: 'Permission', tableName: 'aiot_permissions',
      columns: {
        id, userId: { type: String, length: 64 },
        deviceId: { type: String, length: 64, nullable: true },
        roomId: { type: String, length: 64, nullable: true },
        canControl: { type: Boolean, default: false },
        canChat: { type: Boolean, default: false },
        createdAt: { type: date },
      },
      indices: [{ columns: ['userId'] }],
    }),
    new EntitySchema<RefreshToken>({
      name: 'RefreshToken', tableName: 'aiot_refresh_tokens',
      columns: {
        id, userId: { type: String, length: 64 },
        tokenHash: { type: String, length: 128, unique: true },
        expiresAt: { type: date }, createdAt: { type: date },
        revokedAt: { type: date, nullable: true },
        userAgent: { type: String, length: 200, default: '' },
      },
    }),
    new EntitySchema<AuditLog>({
      name: 'AuditLog', tableName: 'aiot_audit_logs',
      columns: {
        id, at: { type: date },
        userId: { type: String, length: 64, nullable: true },
        username: { type: String, length: 64 },
        source: { type: String, length: 16 },
        action: { type: String, length: 64 },
        deviceId: { type: String, length: 64, nullable: true },
        detail: { type: 'text' },
        result: { type: String, length: 16 },
        ip: { type: String, length: 64, default: '' },
      },
      indices: [{ columns: ['at'] }, { columns: ['userId'] }],
    }),
  ];
}
