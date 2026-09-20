import test from 'node:test';
import assert from 'node:assert/strict';
import { materialCategoryInput, listMaterialCategories } from '../../src/masters/material-categories.js';

const id = 'abcdef12-1234-4567-89ab-abcdef123456';
const input = () => ({ id, requestId: 'abcdef12-1234-4567-89ab-abcdef123457', revision: 0, name: '  Synthetic material  ', description: '  Description  ' });
test('material category input trims text, preserves false flags and canonicalizes identities', () => {
  assert.deepEqual(materialCategoryInput({ ...input(), id: id.toUpperCase(), reusable: false, expirable: true }),
    { ...input(), name: 'Synthetic material', description: 'Description', reusable: false, expirable: true });
  const empty = materialCategoryInput({ ...input(), description: null });
  assert.equal(empty.description, ''); assert.equal(empty.reusable, false); assert.equal(empty.expirable, false);
  assert.equal(materialCategoryInput({ ...input(), name: ' ' + 'x'.repeat(200) + ' ' }).name.length, 200);
  assert.equal(materialCategoryInput({ ...input(), description: 'x'.repeat(16000) }).description.length, 16000);
});
for (const [field, values] of [
  ['name', ['', '  ', null, 3, 'x'.repeat(201), 'a\0b']],
  ['description', [false, {}, 'x'.repeat(16001), 'a\0b']],
  ['reusable', [null, 'true', 1]], ['expirable', [null, 'false', 0]],
  ['revision', [-1, 0.5, '1', null, 2_147_483_647]], ['id', ['bad', null]], ['requestId', ['bad', null]],
]) test(`material category input rejects invalid ${field}`, () => {
  for (const value of values) assert.throws(() => materialCategoryInput({ ...input(), [field]: value }), { status: 400 });
});
test('material category input rejects unsupported properties and non-record payloads', () => {
  for (const value of [null, [], 'name', { ...input(), organizationId: id }, { ...input(), savedBy: id }, { ...input(), active: false }]) {
    assert.throws(() => materialCategoryInput(value), { code: 'invalid_input' });
  }
});
test('material category listing rejects invalid filters before issuing a database query', async () => {
  const client = { query(sql) {
    if (sql.includes('masters_can_read_party')) return { rows: [{ allowed: true }] };
    assert.fail('Invalid query must be rejected before database work.');
  } };
  const identity = { organization_id: id, permission_codes: ['masters.read'] };
  for (const value of [{ page: 0 }, { pageSize: 101 }, { search: 'x'.repeat(501) }, { search: 'a\0b' },
    { sort: { key: 'name; DROP TABLE users', dir: 'asc' } }, { sort: { key: 'name', dir: 'sideways' } },
    { filters: { hidden: { type: 'text', value: 'x' } } }, { filters: { reusable: { type: 'boolean', value: true } } },
    { filters: { expirable: { type: 'text', value: 'true' } } }, { filters: { name: { type: 'date' } } },
    { filters: { created_at: { type: 'text', value: '2026' } } }, { filters: { created_at: { type: 'date', from: '2026-02-30' } } },
    { filters: { created_at: { type: 'date', from: false } } }, { filters: { created_at: { type: 'date', from: '2026-09-17', to: '2026-09-16' } } }]) {
    await assert.rejects(listMaterialCategories(client, identity, value), { status: 400 });
  }
  await assert.rejects(listMaterialCategories(client, { permission_codes: [] }), { code: 'forbidden' });
});
