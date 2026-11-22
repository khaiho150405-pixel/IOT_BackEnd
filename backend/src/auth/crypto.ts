import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// Password hashing with Node's built-in scrypt (no native addon to build on Windows).
// Format: scrypt$N$r$p$salt$hash (base64url), so parameters can be raised later.
const N = 16384, R = 8, P = 1, KEYLEN = 32;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password.normalize('NFKC'), salt, KEYLEN,
    { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const key = await derive(password, Buffer.from(salt, 'base64url'), Number(n), Number(r), Number(p));
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export interface AccessClaims {
  sub: string;      // user id
  role: string;
  tv: number;       // token version
  iat: number;
  exp: number;
}

/** Minimal HS256 JWT (header.payload.signature), verified with a constant-time compare. */
export function signJwt(claims: Omit<AccessClaims, 'iat' | 'exp'>, secret: string, ttlSeconds: number): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ ...claims, iat: now, exp: now + ttlSeconds })).toString('base64url');
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

export function verifyJwt(token: string, secret: string): AccessClaims | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  const [header, payload, signature] = parts;
  try {
    if (JSON.parse(Buffer.from(header, 'base64url').toString()).alg !== 'HS256') return undefined;
    const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest();
    const given = Buffer.from(signature, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as AccessClaims;
    if (typeof claims.sub !== 'string' || typeof claims.exp !== 'number') return undefined;
    if (claims.exp <= Math.floor(Date.now() / 1000)) return undefined;
    return claims;
  } catch {
    return undefined;
  }
}
