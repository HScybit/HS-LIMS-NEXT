import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { businessUnitInput, listBusinessUnits } from '../../src/masters/business-units.js';

const command = changes => ({ id: randomUUID(), requestId: randomUUID(), revision: 0, code: 'UNIT-1', name: 'Unit', ...changes });
test('unit commands trim source fields, canonicalize identities and preserve explicit inactive/null description', () => {
  const input = command({ code: ' A./_-1 ', name: ' Quality ', description: ' ', active: false });
  assert.deepEqual(businessUnitInput({ ...input, id: input.id.toUpperCase(), requestId: input.requestId.toUpperCase() }), { ...input, code: 'A./_-1', name: 'Quality', description: null });
  assert.equal(businessUnitInput(command()).active, true);
  assert.equal(businessUnitInput(command({ description: null })).description, null);
  assert.equal(businessUnitInput(command({ code: 'A'.repeat(64), name: 'N'.repeat(200), description: 'D'.repeat(2000) })).description.length, 2000);
});
test('unit input rejects unsupported fields, invalid text, identifiers, boundaries and non-boolean flags', () => {
  for (const changes of [{ code: '' }, { code: '_ABC' }, { code: 'A B' }, { code: 'é' }, { code: 'A'.repeat(65) },
    { name: ' ' }, { name: 1 }, { name: 'N'.repeat(201) }, { name: '\ud800' }, { description: '\0' }, { description: {} },
    { description: 'D'.repeat(2001) }, { revision: -1 }, { revision: 1.5 }, { revision: 2147483647 }, { id: 'bad' },
    { requestId: '' }, { active: 'false' }, { active: null }, { workflowId: randomUUID() }]) assert.throws(() => businessUnitInput(command(changes)));
});
test('list validation fails before queries for unbounded pagination, unsafe sort and malformed filters', async () => {
  const client = { query() { assert.fail('Invalid list must not query'); } }; const identity = { permission_codes: ['users.read'] };
  for (const input of [{ page: 0 }, { pageSize: 101 }, { page: 1000001 }, { search: '\0' }, { search: '\ud800' },
    { sort: { key: 'name;delete', dir: 'asc' } }, { sort: { key: 'name', dir: 'ASC' } }, { filters: { unknown: {} } },
    { filters: { active: { type: 'boolean', value: true } } }, { filters: { created_at: { type: 'date', from: '2025-02-29' } } },
    { filters: { created_at: { type: 'date', from: '2025-02-02', to: '2025-02-01' } } }]) await assert.rejects(listBusinessUnits(client, identity, input));
  await assert.rejects(listBusinessUnits(client, { permission_codes: ['masters.manage'] }, {}), { status: 403 });
});
