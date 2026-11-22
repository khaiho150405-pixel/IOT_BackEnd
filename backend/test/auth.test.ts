import test from 'node:test';
import assert from 'node:assert/strict';
import 'reflect-metadata';
import { AuthError, AuthService, AuthUser } from '../src/auth/auth.service';
import { hashPassword, signJwt, verifyJwt, verifyPassword } from '../src/auth/crypto';

process.env.AUTH_DB_FILE = ':memory:';
delete process.env.DATABASE_URL;
delete process.env.OWNER_USERNAME;

async function fresh() {
  const auth = new AuthService();
  await auth.ready();
  await auth.setup({ username: 'owner', password: 'owner-pass-123' });
  const owner = (await auth.authenticate((await auth.login('owner', 'owner-pass-123')).accessToken))!;
  return { auth, owner };
}
const as = async (auth: AuthService, username: string, password: string) =>
  (await auth.authenticate((await auth.login(username, password)).accessToken))!;
const code = (promise: Promise<unknown>) => promise.then(() => 0, (e: AuthError) => e.code);

test('passwords are salted scrypt hashes and JWTs reject tampering and expiry', async () => {
  const a = await hashPassword('mật khẩu dài');
  const b = await hashPassword('mật khẩu dài');
  assert.notEqual(a, b, 'random salt');
  assert.ok(await verifyPassword('mật khẩu dài', a));
  assert.ok(!await verifyPassword('mat khau dai', a));
  const token = signJwt({ sub: 'u1', role: 'member', tv: 0 }, 'x'.repeat(32), 60);
  assert.equal(verifyJwt(token, 'x'.repeat(32))?.sub, 'u1');
  assert.equal(verifyJwt(token, 'y'.repeat(32)), undefined, 'wrong secret');
  const [h, p, s] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), role: 'owner' })).toString('base64url');
  assert.equal(verifyJwt(`${h}.${forged}.${s}`, 'x'.repeat(32)), undefined, 'payload tampering');
  assert.equal(verifyJwt(signJwt({ sub: 'u1', role: 'member', tv: 0 }, 'x'.repeat(32), -1), 'x'.repeat(32)), undefined, 'expired');
});

test('setup creates exactly one owner; roles follow the management rules', async () => {
  const { auth, owner } = await fresh();
  assert.equal(await code(auth.setup({ username: 'second', password: 'second-pass-1' })), 409);
  assert.equal(await code(auth.createUser(owner, { username: 'x-owner', password: 'password-123', role: 'owner' })), 403);
  const admin = await auth.createUser(owner, { username: 'admin1', password: 'admin-pass-1', role: 'admin' });
  const adminUser = await as(auth, 'admin1', 'admin-pass-1');
  // Admins manage members/guests only.
  assert.equal(await code(auth.createUser(adminUser, { username: 'admin2', password: 'admin-pass-2', role: 'admin' })), 403);
  const member = await auth.createUser(adminUser, { username: 'member1', password: 'member-pass-1', role: 'member' });
  assert.equal(member.role, 'member');
  assert.equal(await code(auth.updateUser(adminUser, owner.id, { displayName: 'x' })), 403);
  assert.equal(await code(auth.updateUser(adminUser, admin.id, { active: false })), 403);
  // The owner can never be demoted, locked or deleted.
  assert.equal(await code(auth.updateUser(owner, owner.id, { role: 'admin' })), 403);
  assert.equal(await code(auth.updateUser(owner, owner.id, { active: false })), 403);
  assert.equal(await code(auth.deleteUser(owner, owner.id)), 403);
  // Input validation.
  assert.equal(await code(auth.createUser(owner, { username: 'ab', password: 'password-123' })), 400);
  assert.equal(await code(auth.createUser(owner, { username: 'shortpw', password: '123' })), 400);
  assert.equal(await code(auth.createUser(owner, { username: 'member1', password: 'password-123' })), 409);
  // Public objects never contain the password hash.
  assert.ok((await auth.listUsers()).every(u => !('passwordHash' in u)));
});

test('members see only granted devices or rooms; guests expire and never chat', async () => {
  const { auth, owner } = await fresh();
  await auth.touchDevice('desk'); await auth.touchDevice('bed'); await auth.touchDevice('hall');
  const bedroom = await auth.createRoom('Phòng ngủ');
  await auth.updateDevice('bed', { roomId: bedroom.id });
  const member = await auth.createUser(owner, { username: 'member1', password: 'member-pass-1' });
  await auth.setPermissions(owner, member.id, [
    { deviceId: 'desk', canControl: false, canChat: true },
    { roomId: bedroom.id, canControl: true },
  ]);
  const m = await as(auth, 'member1', 'member-pass-1');
  const access = await auth.deviceAccess(m);
  assert.deepEqual([...access.keys()].sort(), ['bed', 'desk']);
  assert.ok(await auth.can(m, 'device:control', 'bed'), 'room grant');
  assert.ok(!await auth.can(m, 'device:control', 'desk'), 'view+chat only');
  assert.ok(await auth.can(m, 'device:chat', 'desk'));
  assert.ok(!await auth.can(m, 'device:view', 'hall'));
  assert.ok(!await auth.can(m, 'user:manage'));

  const guest = await auth.createUser(owner, { username: 'guest1', password: 'guest-pass-1', role: 'guest' });
  assert.ok(guest.expiresAt && new Date(guest.expiresAt).getTime() > Date.now(), 'guests get a default expiry');
  await auth.setPermissions(owner, guest.id, [{ deviceId: 'hall', canControl: true, canChat: true }]);
  const g = await as(auth, 'guest1', 'guest-pass-1');
  assert.ok(await auth.can(g, 'device:control', 'hall'));
  assert.ok(!await auth.can(g, 'device:chat', 'hall'), 'guests never chat even if requested');
  assert.equal(await code(auth.updateUser(owner, guest.id, { expiresAt: '2000-01-01T00:00:00Z' })), 400, 'expiry must be future');
});

test('tokens die with password change, deactivation and refresh reuse; logins lock after failures', async () => {
  const { auth, owner } = await fresh();
  const member = await auth.createUser(owner, { username: 'member1', password: 'member-pass-1' });
  const session = await auth.login('member1', 'member-pass-1');
  const m = (await auth.authenticate(session.accessToken)) as AuthUser;
  await auth.changePassword(m, 'member-pass-1', 'member-pass-2');
  assert.equal(await auth.authenticate(session.accessToken), undefined, 'old access token revoked');
  assert.equal(await code(auth.refresh(session.refreshToken)), 401, 'old refresh token revoked');

  const second = await auth.login('member1', 'member-pass-2');
  await auth.updateUser(owner, member.id, { active: false });
  assert.equal(await auth.authenticate(second.accessToken), undefined, 'deactivated');
  assert.equal(await code(auth.login('member1', 'member-pass-2')), 403);
  await auth.updateUser(owner, member.id, { active: true });

  const r1 = await auth.login('member1', 'member-pass-2');
  const r2 = await auth.refresh(r1.refreshToken);
  assert.equal(await code(auth.refresh(r1.refreshToken)), 401, 'reuse detected');
  assert.equal(await code(auth.refresh(r2.refreshToken)), 401, 'whole family revoked after reuse');

  for (let i = 0; i < 5; i++) assert.equal(await code(auth.login('member1', 'nope-nope', '10.0.0.9')), i < 5 ? 401 : 429);
  assert.equal(await code(auth.login('member1', 'member-pass-2', '10.0.0.9')), 429, 'locked even with the right password');
  assert.equal(await code(auth.login('member1', 'member-pass-2', '10.0.0.10')), 0, 'other clients unaffected');
});
