import test from 'node:test';
import assert from 'node:assert/strict';
import { userProfileInput } from '../../src/users/profile-input.js';
import { userProfileReferenceInput } from '../../src/users/profiles.js';

const id = 'abcdef00-0000-4000-8000-000000000001'; const role = 'abcdef00-0000-4000-8000-000000000002';
const header = { requestId: id, revision: 0 };

test('profile patches preserve omission and explicit empty, null and false values', () => {
  assert.deepEqual(userProfileInput({ ...header, phone: '  ' }), { ...header, phone: null });
  assert.deepEqual(userProfileInput({ ...header, designation: null, employeeCode: ' 007 ', canManagePeople: false, businessUnitId: null, reportingManagerId: null }),
    { ...header, employeeCode: '007', designation: null, canManagePeople: false, businessUnitId: null, reportingManagerId: null });
  assert.deepEqual(userProfileInput({ ...header, phone: ' +91 0000000000 ' }), { ...header, phone: '+91 0000000000' });
});

test('explicit reference identities normalize without choosing an unrecorded role or laboratory', () => {
  const input = { ...header, requestId: id.toUpperCase(), revision: 2, defaultRoleId: role.toUpperCase(), laboratoryId: id.toUpperCase(), roleIds: [role.toUpperCase(), id] };
  assert.deepEqual(userProfileInput(input), { ...header, revision: 2, defaultRoleId: role, laboratoryId: id, roleIds: [id, role] });
  assert.deepEqual(input.roleIds, [role.toUpperCase(), id]);
  assert.deepEqual(userProfileInput({ ...header, roleIds: [role] }), { ...header, roleIds: [role] });
});

test('profile input rejects malformed fields, global identity changes and ambiguous references', () => {
  for (const patch of [{}, { displayName: 'Global name' }, { password: 'Global password' }, { organizationId: id }, { active: false },
    { canManagePeople: 'false' }, { canManagePeople: null }, { employeeCode: 'x'.repeat(101) }, { phone: 'x'.repeat(51) },
    { designation: 'x'.repeat(151) }, { phone: '\0' }, { designation: '\ud800' }, { employeeCode: [] },
    { defaultRoleId: null }, { laboratoryId: null }, { businessUnitId: '' }, { reportingManagerId: 'self' },
    { roleIds: [] }, { roleIds: [role, role.toUpperCase()] }, { roleIds: ['custom_creator_role'] }, { roleIds: Array(101).fill(role) }]) {
    assert.throws(() => userProfileInput({ ...header, ...patch }), { status: 400 });
  }
  for (const revision of [-1, 1.5, '1', 2_147_483_647]) assert.throws(() => userProfileInput({ ...header, revision, phone: null }), { status: 400 });
  for (const input of [null, [], 'profile']) assert.throws(() => userProfileInput(input), { status: 400 });
});

test('profile reference queries bound selections and preserve empty selected sets', () => {
  assert.deepEqual(userProfileReferenceInput({ kind: 'roles', selectedIds: [] }), { kind: 'roles', search: '', pageSize: 50, selectedIds: [] });
  assert.deepEqual(userProfileReferenceInput({ kind: 'managers', excludeUserId: id.toUpperCase(), search: '  %_  ', pageSize: 100 }),
    { kind: 'managers', excludeUserId: id, search: '%_', pageSize: 100 });
  for (const input of [null, [], {}, { kind: 'passwords' }, { kind: 'roles', selectedIds: [id, id.toUpperCase()] },
    { kind: 'roles', selectedIds: Array(101).fill(id) }, { kind: 'roles', pageSize: 101 }, { kind: 'roles', search: '\ud800' },
    { kind: 'roles', search: '\0' }, { kind: 'roles', unknown: true }]) assert.throws(() => userProfileReferenceInput(input), { status: 400 });
});
