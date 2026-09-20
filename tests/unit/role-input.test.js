import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { roleInput, roleRetirementInput, roleListInput } from '../../src/roles/input.js';
import { roleCapabilityKeys, roleBadges, visibleRoleCapabilities } from '../../src/roles/capabilities.js';

const input = (changes = {}) => ({ id: randomUUID(), requestId: randomUUID(), revision: 0, name: 'Analyst', ...changes });

test('role input preserves case and Unicode while normalizing names and opaque stable identities', () => {
  const value = input({ name: '  Analyst – जल  ', description: '  Notes\n  ', defaultPath: ' /samples ',
    permissionCodes: ['templates.read', 'samples.read'], capabilityKeys: ['can_create_sample', 'can_access_all_ds'] });
  const parsed = roleInput({ ...value, id: value.id.toUpperCase(), requestId: value.requestId.toUpperCase() });
  assert.equal(parsed.id, value.id); assert.equal(parsed.requestId, value.requestId);
  assert.equal(parsed.name, 'Analyst – जल'); assert.equal(parsed.description, 'Notes'); assert.equal(parsed.defaultPath, '/samples');
  assert.deepEqual(parsed.permissionCodes, ['samples.read', 'templates.read']);
  assert.deepEqual(parsed.capabilityKeys, ['can_access_all_ds', 'can_create_sample']);
  assert.deepEqual(value.permissionCodes, ['templates.read', 'samples.read'], 'normalization does not mutate a pending form');
});

test('omitted role metadata and permission sets remain distinguishable from explicit clearing', () => {
  const omitted = roleInput(input());
  for (const key of ['description', 'defaultPath', 'permissionCodes', 'capabilityKeys']) assert.equal(omitted[key], undefined);
  const cleared = roleInput(input({ description: null, defaultPath: ' ', permissionCodes: [], capabilityKeys: [] }));
  assert.equal(cleared.description, ''); assert.equal(cleared.defaultPath, null);
  assert.deepEqual(cleared.permissionCodes, []); assert.deepEqual(cleared.capabilityKeys, []);
  assert.equal(roleInput(input({ defaultPath: null })).defaultPath, null);
});

test('role text enforces source PERN bounds without silently truncating or accepting malformed strings', () => {
  assert.equal(roleInput(input({ name: 'x'.repeat(150), description: 'x'.repeat(2000), defaultPath: 'x'.repeat(300) })).name.length, 150);
  for (const changes of [{ name: '' }, { name: '  ' }, { name: null }, { name: false }, { name: 0 }, { name: 'x'.repeat(151) },
    { description: 'x'.repeat(2001) }, { defaultPath: 'x'.repeat(301) }, { description: {} }, { defaultPath: [] }]) {
    assert.throws(() => roleInput(input(changes)), { status: 400 });
  }
  for (const key of ['name', 'description', 'defaultPath']) for (const value of ['a\0b', '\ud800', '\udfff']) {
    assert.throws(() => roleInput(input({ [key]: value })), { code: 'invalid_role_text' });
  }
});

test('capability and permission sets are bounded, distinct and independent', () => {
  const permissions = Array.from({ length: 500 }, (_, index) => `synthetic.permission_${index}`);
  assert.equal(roleInput(input({ permissionCodes: permissions })).permissionCodes.length, 500);
  assert.deepEqual(roleInput(input({ capabilityKeys: roleCapabilityKeys })).capabilityKeys, [...roleCapabilityKeys].sort());
  for (const changes of [{ permissionCodes: null }, { permissionCodes: {} }, { permissionCodes: [...permissions, 'extra'] },
    { permissionCodes: ['samples.read', ' samples.read '] }, { permissionCodes: [''] }, { permissionCodes: [false] },
    { capabilityKeys: null }, { capabilityKeys: ['can_admin', 'can_admin'] }, { capabilityKeys: ['unknown'] },
    { capabilityKeys: ['can_access_dms'] }, { capabilityKeys: ['can_gen_prof_inv'] }]) assert.throws(() => roleInput(input(changes)), { status: 400 });
  assert.equal(roleInput(input({ capabilityKeys: ['can_admin'] })).permissionCodes, undefined, 'admin capability does not infer any API grant');
});

test('source badge order and setting visibility preserve hidden capability values', () => {
  const selected = ['is_creator', 'can_self_allocate', 'can_create_sample', 'can_admin']; const before = [...selected];
  assert.deepEqual(roleBadges(selected).map((item) => item.badgeLabel), ['CAN ADMIN', 'CAN CREATE SAMPLE']);
  assert.deepEqual(roleBadges(selected, { selfAllocationEnabled: true }).map((item) => item.key), ['can_admin', 'can_create_sample', 'can_self_allocate']);
  assert.equal(visibleRoleCapabilities().some((item) => item.key === 'can_self_allocate'), false);
  assert.equal(visibleRoleCapabilities({ selfAllocationEnabled: true }).length, 18);
  assert.deepEqual(selected, before);
  assert.deepEqual(roleInput(input({ capabilityKeys: selected })).capabilityKeys, [...selected].sort());
});

test('role commands reject forged authority, identity, retirement state and revision metadata', () => {
  for (const changes of [{ id: null }, { requestId: 'missing' }, { revision: -1 }, { revision: 0.5 }, { revision: 2_147_483_647 },
    { revision: '1' }, { organizationId: randomUUID() }, { savedBy: randomUUID() }, { active: false }, { protected: true }, { code: 'admin' }]) {
    assert.throws(() => roleInput(input(changes)), { status: 400 });
  }
  const value = input(); const command = { id: value.id.toUpperCase(), requestId: value.requestId.toUpperCase(), revision: 0 };
  assert.deepEqual(roleRetirementInput(command), { ...command, id: value.id, requestId: value.requestId });
  assert.throws(() => roleRetirementInput({ ...command, name: 'retarget' }), { status: 400 });
  assert.throws(() => roleInput(null), { status: 400 }); assert.throws(() => roleInput([]), { status: 400 });
});

test('role lists bound pagination and allow only source name filtering and sorting', () => {
  assert.deepEqual(roleListInput(), { page: 1, pageSize: 10, search: '', nameFilter: '', sort: null });
  assert.deepEqual(roleListInput({ search: '  100%_  ', filters: { name: { type: 'text', value: ' Lab Analyst ' } }, sort: { key: 'name', dir: 'desc' } }),
    { page: 1, pageSize: 10, search: '100%_', nameFilter: 'Lab Analyst', sort: { key: 'name', dir: 'desc' } });
  for (const value of [{ page: 0 }, { pageSize: 101 }, { page: '1' }, { page: 1_000_001 }, { search: '\0' }, { search: '\ud800' },
    { filters: { description: { type: 'text', value: '' } } }, { filters: { name: { type: 'select', value: '' } } },
    { sort: { key: 'name; SELECT 1', dir: 'asc' } }, { sort: { key: 'name', dir: 'sideways' } }, { organizationId: randomUUID() }]) {
    assert.throws(() => roleListInput(value), { status: 400 });
  }
});
