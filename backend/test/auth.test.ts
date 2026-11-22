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

test('one account type: every account controls all devices and can add accounts', async () => {
  const { auth, owner } = await fresh();
  assert.equal(await code(auth.setup({ username: 'second', password: 'second-pass-1' })), 409);
  await auth.touchDevice('desk'); await auth.touchDevice('hall');
  // Whatever role is asked for, new accounts get the same full access and never expire.
  const friend = await auth.createUser(owner, { username: 'friend', password: 'friend-pass-1', role: 'guest' as any });
  assert.equal(friend.role, 'admin');
  assert.equal(friend.expiresAt, null);
  const f = await as(auth, 'friend', 'friend-pass-1');
  for (const action of ['device:view', 'device:control', 'device:chat'] as const)
    for (const device of ['desk', 'hall']) assert.ok(await auth.can(f, action, device), action + ' ' + device);
  assert.deepEqual([...(await auth.deviceAccess(f)).keys()].sort(), ['desk', 'hall']);
  // Accounts created by another account can create more accounts too.
  const third = await auth.createUser(f, { username: 'third', password: 'third-pass-1' });
  assert.equal(third.role, 'admin');
  // Lock-out protection: the first account and your own account cannot be locked or deleted,
  // and nobody else can change the first account's password.
  assert.equal(await code(auth.updateUser(f, owner.id, { active: false })), 403);
  assert.equal(await code(auth.deleteUser(f, owner.id)), 403);
  assert.equal(await code(auth.updateUser(f, owner.id, { password: 'taken-over-1' })), 403);
  assert.equal(await code(auth.deleteUser(f, f.id)), 403);
  assert.equal(await code(auth.updateUser(owner, owner.id, { active: false })), 403);
  assert.equal(await code(auth.updateUser(f, third.id, { password: 'third-pass-2' })), 0, 'others may reset each other');
  assert.equal(await code(auth.deleteUser(f, third.id)), 0);
  // Every account reads the whole audit log.
  await auth.audit({ user: owner, source: 'web', action: 'led:on', deviceId: 'desk' });
  assert.ok((await auth.listAudit(f)).some(e => e.username === 'owner'));
  // Input validation.
  assert.equal(await code(auth.createUser(owner, { username: 'ab', password: 'password-123' })), 400);
  assert.equal(await code(auth.createUser(owner, { username: 'shortpw', password: '123' })), 400);
  assert.equal(await code(auth.createUser(owner, { username: 'friend', password: 'password-123' })), 409);
  assert.ok((await auth.listUsers()).every(u => !('passwordHash' in u)));
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

test('older member/guest accounts become full accounts on start-up', async () => {
  const { auth } = await fresh();
  const internal = auth as any;
  await internal.insertUser({ username: 'oldguest', password: 'guest-pass-1', role: 'guest' });
  const before = await auth.login('oldguest', 'guest-pass-1');
  await internal.unifyAccounts();
  const users = await auth.listUsers();
  assert.equal(users.find(u => u.username === 'oldguest')?.role, 'admin');
  assert.equal(await auth.authenticate(before.accessToken), undefined, 'old limited token no longer valid');
});
