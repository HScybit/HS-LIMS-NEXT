import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { userCustomFieldInput } from '../../src/users/custom-field-input.js';

const command = changes => ({ requestId: randomUUID(), revision: 0, customFields: [], ...changes });
test('user capture input normalizes command identities and time zones while retaining typed values and explicit emptiness', () => {
  const userId = randomUUID(); const requestId = randomUUID(); const fieldId = randomUUID();
  const value = userCustomFieldInput(userId.toUpperCase(), command({ requestId: requestId.toUpperCase(), customFieldTimeZone: ' asia/kolkata ',
    customFields: [{ fieldId: fieldId.toUpperCase(), fieldRevision: 2, value: [0, false, '', '  ', 'raw  text'] }] }));
  assert.deepEqual(value, { id: userId, requestId, revision: 0, customFieldTimeZone: 'Asia/Kolkata',
    customFields: [{ fieldId, fieldRevision: 2, value: [0, false, 'raw  text'] }] });
  assert.equal(userCustomFieldInput(userId, command()).customFieldTimeZone, null);
  assert.deepEqual(userCustomFieldInput(userId, command()).customFields, []);
});

test('user capture input rejects missing capture values, unsupported metadata, invalid revision ranges and zones', () => {
  const userId = randomUUID();
  for (const [changes, code] of [[{ revision: -1 }, 'invalid_input'], [{ revision: 2_147_483_647 }, 'invalid_input'],
    [{ requestId: 'invalid' }, 'invalid_id'], [{ customFields: undefined }, 'invalid_custom_field_values'],
    [{ customFields: null }, 'invalid_custom_field_values'], [{ customFieldTimeZone: 'invalid/zone' }, 'invalid_custom_field_timezone'],
    [{ organizationId: randomUUID() }, 'invalid_input'], [{ savedBy: randomUUID() }, 'invalid_input']]) {
    assert.throws(() => userCustomFieldInput(userId, command(changes)), { code });
  }
});
