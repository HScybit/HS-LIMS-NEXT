import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { userFormInput, userFormFingerprint } from '../../src/users/form-input.js';
import { userAccountInput, userAccountFingerprint } from '../../src/users/account-input.js';

const id = randomUUID(); const command = () => ({ requestId: randomUUID(), revision: 1, profileRevision: 0, username: 'analyst', email: 'analyst@example.invalid', displayName: 'Analyst' });
test('user forms retain sparse profile edits, explicit clears and hidden-field absence with independent revisions', () => {
  const input = command(); const parsed = userFormInput(id, { ...input, phone: ' ', canManagePeople: false, businessUnitId: null });
  assert.deepEqual(parsed.profile, { requestId: input.requestId, revision: 0, phone: null, canManagePeople: false, businessUnitId: null });
  assert.equal(parsed.account.revision, 1); assert.equal(parsed.account.password, ''); assert.equal(Object.hasOwn(parsed.account, 'id'), false);
  assert.equal(Object.hasOwn(parsed.profile, 'roleIds'), false); assert.equal(userFormInput(id, input).profile, null);
});
test('user forms validate identity and profile fields before executing either command', () => {
  const input = command();
  for (const changes of [{ password: null }, { password: 'short' }, { profileRevision: '0' }, { profileRevision: -1 }, { revision: 0 }, { roleIds: [] }, { canManagePeople: null }, { defaultRoleId: null }, { organizationId: randomUUID() }]) {
    assert.throws(() => userFormInput(id, { ...input, ...changes }), { status: 400 });
  }
});

const key = '5d'.repeat(32);
const fingerprint = value => userFormFingerprint(userFormInput(id, value), key).toString('hex');
test('optional form captures distinguish omission from an explicit empty version and retain typed raw values', () => {
  const input = command(); const original = userFormInput(id, input); assert.equal(Object.hasOwn(original, 'fieldCapture'), false);
  const empty = userFormInput(id, { ...input, customFieldRevision: 0, customFields: [] });
  assert.deepEqual(empty.fieldCapture, { id, requestId: input.requestId, revision: 0, customFields: [], customFieldTimeZone: null });
  const fields = [{ fieldId: randomUUID(), fieldRevision: 1, value: false }, { fieldId: randomUUID(), fieldRevision: 2, value: [0, false, ' raw '] }];
  const captured = userFormInput(id, { ...input, customFieldRevision: 7, customFields: fields });
  assert.deepEqual(captured.fieldCapture.customFields, fields); assert.equal(captured.fieldCapture.revision, 7);
  assert.notEqual(fingerprint(input), fingerprint({ ...input, customFieldRevision: 0, customFields: [] }));
});

test('form capture metadata requires supplied fields and an explicit valid expected revision', () => {
  const input = command();
  for (const changes of [{ customFieldRevision: 0 }, { customFieldTimeZone: null }, { customFields: [] },
    { customFieldRevision: '0', customFields: [] }, { customFieldRevision: -1, customFields: [] },
    { customFieldRevision: 0, customFields: null }, { customFieldRevision: 0, customFields: undefined },
    { customFieldRevision: 0, customFields: [], customFieldTimeZone: 'Unknown/Zone' }]) {
    assert.throws(() => userFormInput(id, { ...input, ...changes }), { status: 400 });
  }
});

test('the full form fingerprint binds profile presence, field order, raw types, revisions, time zone and password', () => {
  const fields = [{ fieldId: randomUUID(), fieldRevision: 1, value: 'value' }, { fieldId: randomUUID(), fieldRevision: 1, value: [0, false] }];
  const input = { ...command(), phone: 'Contact', password: 'Synthetic form password', customFields: fields, customFieldRevision: 1, customFieldTimeZone: 'Asia/Kolkata' };
  const original = fingerprint(input); const { phone: _phone, ...withoutProfile } = input;
  const { customFields: _fields, customFieldRevision: _revision, customFieldTimeZone: _zone, ...withoutFields } = input;
  for (const changed of [withoutProfile, withoutFields, { ...input, phone: 'Changed contact' }, { ...input, customFields: [...fields].reverse() },
    { ...input, customFields: [fields[0], { ...fields[1], value: ['0', false] }] }, { ...input, customFieldRevision: 2 },
    { ...input, customFields: [{ ...fields[0], fieldRevision: 2 }, fields[1]] }, { ...input, customFieldTimeZone: 'Asia/Calcutta' },
    { ...input, password: 'A different form password' }, { ...input, requestId: randomUUID() }]) assert.notEqual(fingerprint(changed), original);
});

test('semantically normalized inputs share a fingerprint while account and full-form keys stay separate', () => {
  const input = command(); const fields = [{ fieldId: randomUUID(), fieldRevision: 1, value: [0, false] }];
  const base = { ...input, phone: ' Contact ', customFields: fields, customFieldRevision: 0, customFieldTimeZone: 'Asia/Kolkata' };
  assert.equal(fingerprint(base), fingerprint({ ...base, username: ' analyst ', phone: 'Contact', password: '', customFieldTimeZone: ' asia/kolkata ',
    customFields: [{ ...fields[0], fieldId: fields[0].fieldId.toUpperCase(), value: ['', 0, false] }] }));
  const parsed = userFormInput(id, input);
  assert.notDeepEqual(userFormFingerprint(parsed, key), userAccountFingerprint(userAccountInput(id, parsed.account), key));
});

test('form fingerprints reject unavailable keys and contain only a fixed-length keyed digest', () => {
  const parsed = userFormInput(id, command()); const digest = userFormFingerprint(parsed, key); assert(Buffer.isBuffer(digest)); assert.equal(digest.length, 32);
  for (const invalid of [null, '', '5d', 'GG'.repeat(32)]) assert.throws(() => userFormFingerprint(parsed, invalid), { status: 503, code: 'account_command_key_unavailable' });
});
