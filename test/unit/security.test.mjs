import assert from 'node:assert/strict';
import test from 'node:test';
import { PasswordService } from '../../dist/modules/auth/password.service.js';
import { SessionService, staffETag, fingerprint } from '../../dist/modules/auth/security.js';

test('password policy counts Unicode code points, preserves spaces and rejects common passwords', () => {
  const service = new PasswordService();
  assert.throws(() => service.validate('x'.repeat(14)));
  assert.throws(() => service.validate('😀'.repeat(14)));
  assert.throws(() => service.validate('x'.repeat(129)));
  assert.throws(() => service.validate('PasswordPassword'));
  assert.throws(() => service.validate('A synthetic password ' + '\ud800'));
  service.validate('😀'.repeat(15));
  service.validate(' a correct horse battery staple ');
});

test('Argon2id hashes are salted and verify only the exact submitted password', async () => {
  const service = new PasswordService();
  const password = ' synthetic correct horse battery ';
  const first = await service.hash(password), second = await service.hash(password);
  assert.match(first, /^\$argon2id\$v=19\$/);
  assert.deepEqual(first.split('$')[3].split(',').sort(), ['m=19456', 'p=1', 't=2']);
  assert.notEqual(first, second);
  assert.equal(await service.verify(first, password), true);
  assert.equal(await service.verify(first, password.trim()), false);
  assert.equal(await service.verify('invalid hash', password), false);
});

test('opaque session tokens enforce canonical 32-byte base64url and bound CSRF', () => {
  const security = new SessionService(Buffer.alloc(32, 1));
  const token = security.issue();
  assert.equal(token.length, 43);
  assert.equal(security.digest(token).length, 32);
  assert.equal(security.validCsrf(token, security.csrf(token)), true);
  assert.equal(security.validCsrf(token, security.csrf(security.issue())), false);
  assert.equal(security.validCsrf(token, 'malformed'), false);
  assert.throws(() => security.digest(token + '='));
  assert.throws(() => security.digest('A'.repeat(42) + 'B'));
});

test('password verification rejects lone Unicode surrogates without aliasing replacement characters', async () => {
  const service = new PasswordService();
  const valid = 'Synthetic password \ufffd';
  const hash = await service.hash(valid);
  assert.equal(await service.verify(hash, valid), true);
  assert.equal(await service.verify(hash, 'Synthetic password \ud800'), false);
  assert.equal(await service.verify(hash, 'Synthetic password \udfff'), false);
});

test('ETags and fingerprints bind resource, epoch and the unchanged original intent', () => {
  const tag = staffETag('staff-a', 1, 'epoch-a');
  assert.notEqual(tag, staffETag('staff-a', 2, 'epoch-a'));
  assert.notEqual(tag, staffETag('staff-b', 1, 'epoch-a'));
  assert.notEqual(tag, staffETag('staff-a', 1, 'epoch-b'));
  const key = Buffer.alloc(32, 3);
  const a = fingerprint(key, 'epoch-a', {currentPassword:'original',newPassword:'chosen'}, tag);
  assert.deepEqual(a, fingerprint(key, 'epoch-a', {newPassword:'chosen',currentPassword:'original'}, tag));
  assert.notDeepEqual(a, fingerprint(key, 'epoch-b', {currentPassword:'original',newPassword:'chosen'}, tag));
  assert.notDeepEqual(a, fingerprint(key, 'epoch-a', {currentPassword:'original',newPassword:'other'}, tag));
});
