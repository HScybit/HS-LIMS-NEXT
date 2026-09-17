import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { moduleAccessSettingsInput } from '../../src/organization-settings/module-access-input.js';

const settings = () => ({ moduleAccess: [
  { moduleKey: 'customer', enabled: false, roleIds: [], userIds: [] },
  { moduleKey: 'vendor', enabled: false, roleIds: [], userIds: [] },
] });
const invalid = action => assert.throws(action, error => error.status === 400);

test('module settings preserve omission, disabled assignments and selection order', () => {
  assert.equal(moduleAccessSettingsInput({ revision: 1 }), null);
  const input = settings(); const ids = [randomUUID(), randomUUID()];
  input.moduleAccess[0].roleIds = ids.map(id => id.toUpperCase());
  input.moduleAccess[0].userIds = [ids[1]];
  const before = structuredClone(input);
  const result = moduleAccessSettingsInput(input);
  assert.equal(result[0].enabled, false);
  assert.deepEqual(result[0].roleIds, ids); assert.deepEqual(result[0].userIds, [ids[1]]);
  assert.deepEqual(input, before);
});

test('a complete module set is required without duplicate or unknown modules', () => {
  for (const moduleAccess of [null, [], settings().moduleAccess.slice(0, 1), [...settings().moduleAccess, settings().moduleAccess[0]]]) {
    invalid(() => moduleAccessSettingsInput({ moduleAccess }));
  }
  const duplicate = settings(); duplicate.moduleAccess[1].moduleKey = 'customer';
  invalid(() => moduleAccessSettingsInput(duplicate));
  const unknown = settings(); unknown.moduleAccess[1].moduleKey = 'instrument';
  invalid(() => moduleAccessSettingsInput(unknown));
  const reordered = settings(); reordered.moduleAccess.reverse();
  assert.deepEqual(moduleAccessSettingsInput(reordered).map(row => row.moduleKey), ['customer', 'vendor']);
});

test('module settings reject invalid objects, booleans, missing arrays and extra fields', () => {
  for (const input of [null, undefined, [], 0, 'settings']) invalid(() => moduleAccessSettingsInput(input));
  for (const enabled of [null, undefined, 0, 1, 'false']) {
    const input = settings(); input.moduleAccess[0].enabled = enabled;
    invalid(() => moduleAccessSettingsInput(input));
  }
  for (const roleIds of [null, undefined, {}, '']) {
    const input = settings(); input.moduleAccess[0].roleIds = roleIds;
    invalid(() => moduleAccessSettingsInput(input));
  }
  const extra = settings(); extra.moduleAccess[0].administratorBypass = true;
  invalid(() => moduleAccessSettingsInput(extra));
  const missingRow = settings(); missingRow.moduleAccess[0] = null;
  invalid(() => moduleAccessSettingsInput(missingRow));
});

test('the same assignment may appear in both modules but duplicates within one module are invalid', () => {
  const id = randomUUID(); const input = settings();
  for (const access of input.moduleAccess) { access.roleIds = [id]; access.userIds = [id]; access.enabled = true; }
  assert.deepEqual(moduleAccessSettingsInput(input), input.moduleAccess);
  for (const key of ['roleIds', 'userIds']) {
    const duplicate = structuredClone(input); duplicate.moduleAccess[0][key] = [id, id.toUpperCase()];
    invalid(() => moduleAccessSettingsInput(duplicate));
  }
});

test('each module allows 500 role and user assignments and rejects overflow', () => {
  const ids = Array.from({ length: 501 }, () => randomUUID()); const input = settings();
  for (const access of input.moduleAccess) { access.roleIds = ids.slice(0, 500); access.userIds = ids.slice(0, 500); }
  assert.equal(moduleAccessSettingsInput(input)[1].userIds.length, 500);
  for (const key of ['roleIds', 'userIds']) {
    const overflow = structuredClone(input); overflow.moduleAccess[1][key] = ids;
    invalid(() => moduleAccessSettingsInput(overflow));
  }
});

test('malformed and sparse UUID selections cannot bypass validation', () => {
  for (const roleIds of [[null], [''], ['not-a-uuid'], [randomUUID() + ' '], new Array(1)]) {
    const input = settings(); input.moduleAccess[0].roleIds = roleIds;
    invalid(() => moduleAccessSettingsInput(input));
  }
});

test('Instrument access is explicit and optional only for older two-module callers', () => {
  const legacy = settings(); assert.deepEqual(moduleAccessSettingsInput(legacy), legacy.moduleAccess);
  const instrument = { moduleKey: 'instrument', enabled: true, roleIds: [randomUUID()], userIds: [randomUUID()] };
  const input = { moduleAccess: [instrument, ...legacy.moduleAccess] }; const before = structuredClone(input);
  assert.deepEqual(moduleAccessSettingsInput(input), [...legacy.moduleAccess, instrument]);
  assert.deepEqual(input, before);
  invalid(() => moduleAccessSettingsInput({ moduleAccess: [legacy.moduleAccess[0], instrument] }));
  invalid(() => moduleAccessSettingsInput({ moduleAccess: [...legacy.moduleAccess, instrument, instrument] }));
  const sparse = [...legacy.moduleAccess, instrument]; delete sparse[2];
  invalid(() => moduleAccessSettingsInput({ moduleAccess: sparse }));
});

test('Instrument selections preserve disabled access and enforce their own limits', () => {
  const ids = Array.from({ length: 501 }, () => randomUUID());
  const instrument = { moduleKey: 'instrument', enabled: false, roleIds: ids.slice(0, 500), userIds: ids.slice(0, 500) };
  const input = { moduleAccess: [...settings().moduleAccess, instrument] };
  assert.deepEqual(moduleAccessSettingsInput(input)[2], instrument);
  for (const key of ['roleIds', 'userIds']) {
    invalid(() => moduleAccessSettingsInput({ moduleAccess: [...settings().moduleAccess, { ...instrument, [key]: ids }] }));
    invalid(() => moduleAccessSettingsInput({ moduleAccess: [...settings().moduleAccess, { ...instrument, [key]: [ids[0], ids[0].toUpperCase()] }] }));
  }
});
