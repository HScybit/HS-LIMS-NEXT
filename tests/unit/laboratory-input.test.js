import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { laboratoryInput, loadLaboratory, saveLaboratory, retireLaboratory, listLaboratories } from '../../src/masters/laboratories.js';

const command = () => ({ id: randomUUID(), revision: 0, requestId: randomUUID(), code: 'LAB-1', name: 'Lab', minimumTemperature: '0', maximumTemperature: '25C', minimumHumidity: ' ', maximumHumidity: 'Infinity' });
test('Lab inputs preserve raw text, zero, empty and absent values with canonical reference identities', () => {
  const value = { ...command(), name: '  Lab  ', abbreviation: '', description: null, headUserId: randomUUID().toUpperCase(), businessUnitId: '' };
  const parsed = laboratoryInput(value);
  assert.equal(parsed.name, value.name); assert.equal(parsed.minimumTemperature, '0'); assert.equal(parsed.maximumTemperature, '25C');
  assert.equal(parsed.minimumHumidity, ' '); assert.equal(parsed.maximumHumidity, 'Infinity'); assert.equal(parsed.abbreviation, '');
  assert.equal(parsed.description, null); assert.equal(parsed.businessUnitId, null); assert.equal(parsed.delegateUserId, null);
  assert.equal(parsed.headUserId, value.headUserId.toLowerCase()); assert.equal(parsed.active, true);
});
test('Lab inputs reject malformed shapes, identities, revisions, booleans and non-text range values', () => {
  for (const value of [null, [], { ...command(), unexpected: true }, { ...command(), revision: -1 }, { ...command(), revision: 2_147_483_647 },
    { ...command(), id: '' }, { ...command(), headUserId: false }, { ...command(), active: 'false' }, { ...command(), name: ' ' },
    { ...command(), minimumTemperature: 0 }, { ...command(), maximumHumidity: false }, { ...command(), abbreviation: '\ud800' },
    { ...command(), description: 'text\0suffix' }, { ...command(), minimumHumidity: 'x'.repeat(1_048_577) }]) assert.throws(() => laboratoryInput(value), { status: 400 });
});
test('Lab service permission checks run before any query', async () => {
  const client = { query: () => { throw new Error('Unexpected database query'); } }; const identity = { permission_codes: ['masters.manage'] };
  for (const action of [() => loadLaboratory(client, identity, randomUUID()), () => listLaboratories(client, identity),
    () => saveLaboratory(client, identity, command()), () => retireLaboratory(client, identity, {})]) await assert.rejects(action, { status: 403 });
});
