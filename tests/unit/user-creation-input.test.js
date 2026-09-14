import test from 'node:test';
import assert from 'node:assert/strict';
import { userCreationInput, userCreationFingerprint } from '../../src/users/creation-input.js';

const id = 'abcdef00-0000-4000-8000-000000000001'; const role = 'abcdef00-0000-4000-8000-000000000002';
const input = () => ({ id, requestId: id, revision: 0, username: ' Employee007 ', email: ' Person@Example.invalid ', displayName: ' Synthetic Person ',
  password: '  Raw password  ', defaultRoleId: role, laboratoryId: id });
const key = '01'.repeat(32);

test('new account input preserves exact passwords and source identity case while normalizing explicit references', () => {
  const result = userCreationInput({ ...input(), id: id.toUpperCase(), defaultRoleId: role.toUpperCase(), phone: ' ', canManagePeople: false });
  assert.equal(result.id, id); assert.equal(result.defaultRoleId, role); assert.equal(result.username, 'Employee007'); assert.equal(result.email, 'Person@Example.invalid');
  assert.equal(result.displayName, 'Synthetic Person'); assert.equal(result.password, '  Raw password  '); assert.equal(result.phone, null); assert.equal(result.canManagePeople, false);
  assert.equal(Object.hasOwn(result, 'employeeCode'), false); assert.equal(Object.hasOwn(result, 'roleIds'), false);
  for (const password of ['12345678', 'x'.repeat(200), 'éabcdefg', 'e\u0301abcdefg', 'abc\0defg']) assert.equal(userCreationInput({ ...input(), password }).password, password);
});

test('new accounts require the actual fields and references without a temporary-password or first-role fallback', () => {
  for (const changed of [{ username: '' }, { username: 'x'.repeat(101) }, { displayName: '\ud800' }, { displayName: 'x'.repeat(201) },
    { email: 'invalid' }, { email: 'x\0@example.invalid' }, { password: '' }, { password: '1234567' }, { password: 'x'.repeat(201) }, { password: '\ud800abcdefg' },
    { password: null }, { defaultRoleId: null }, { laboratoryId: null }, { revision: 1 }, { revision: '0' }, { organizationId: id }, { active: false }, { mustChangePassword: true }]) {
    assert.throws(() => userCreationInput({ ...input(), ...changed }), { status: 400 });
  }
  for (const field of ['defaultRoleId', 'laboratoryId']) { const value = input(); delete value[field]; assert.throws(() => userCreationInput(value), { status: 422 }); }
  for (const value of [null, [], 'account']) assert.throws(() => userCreationInput(value), { status: 400 });
});

test('keyed request fingerprints are stable for equivalent input and distinguish exact sparse commands and credentials', () => {
  assert.equal(userCreationFingerprint(input(), key).toString('hex'), '9295bfd5030d408665882de4dd8b91f2f0610d5b3e71eacb34628cbcaecce4ef');
  const first = { ...input(), roleIds: [role, id] }; const equivalent = Object.fromEntries(Object.entries({ ...first,
    id: id.toUpperCase(), requestId: id.toUpperCase(), username: 'Employee007', roleIds: [id, role.toUpperCase()],
  }).reverse());
  const fingerprint = userCreationFingerprint(first, key); assert.equal(fingerprint.length, 32); assert.deepEqual(userCreationFingerprint(equivalent, key), fingerprint);
  for (const value of [{ ...first, password: first.password.trim() }, { ...first, employeeCode: null }, { ...first, requestId: role },
    { ...first, id: role }, { ...first, displayName: 'Different name' }, { ...first, email: 'person@example.invalid' }, { ...first, roleIds: [role] }]) {
    assert.notDeepEqual(userCreationFingerprint(value, key), fingerprint);
  }
  assert.notDeepEqual(userCreationFingerprint(first, '02'.repeat(32)), fingerprint);
  for (const invalid of [null, '', '1'.repeat(63), 'NOT A KEY']) {
    assert.throws(() => userCreationFingerprint(first, invalid), { status: 503, message: 'Account creation is temporarily unavailable.' });
  }
});

test('creation fields preserve omission, explicit empty and typed captures in the exact keyed command', () => {
  const original = input(); assert.equal(Object.hasOwn(userCreationInput(original), 'customFields'), false);
  const empty = { ...original, customFields: [] }; assert.deepEqual(userCreationInput(empty).customFields, []);
  assert.notDeepEqual(userCreationFingerprint(empty, key), userCreationFingerprint(original, key));
  const fields = [{ fieldId: role, fieldRevision: 1, value: [0, false, ' ', 'kept'] }];
  const populated = { ...original, customFields: fields, customFieldTimeZone: ' asia/kolkata ' };
  const parsed = userCreationInput(populated); assert.deepEqual(parsed.customFields[0].value, [0, false, 'kept']); assert.equal(parsed.customFieldTimeZone, 'Asia/Kolkata');
  assert.deepEqual(userCreationFingerprint(populated, key), userCreationFingerprint({ ...populated, customFieldTimeZone: 'Asia/Kolkata',
    customFields: [{ ...fields[0], fieldId: role.toUpperCase(), value: [0, false, 'kept'] }] }, key));
  for (const changed of [{ customFields: [] }, { customFields: [{ ...fields[0], value: [false, 0, 'kept'] }] }, { customFieldTimeZone: 'UTC' }, { customFieldTimeZone: 'Asia/Calcutta' }]) {
    assert.notDeepEqual(userCreationFingerprint({ ...populated, ...changed }, key), userCreationFingerprint(populated, key));
  }
  for (const changed of [{ customFieldTimeZone: null }, { customFields: null }, { customFields: [] , customFieldRevision: 1 },
    { customFields: [{ ...fields[0], savedBy: id }] }, { customFields: fields, customFieldTimeZone: 'Unknown/Zone' }]) {
    assert.throws(() => userCreationInput({ ...original, ...changed }), { status: 400 });
  }
});
