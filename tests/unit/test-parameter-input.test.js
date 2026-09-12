import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { testParameterInput } from '../../src/masters/test-parameters.js';

const input = () => ({ id: randomUUID(), requestId: randomUUID(), revision: 0, name: '  Parameter  ', description: '  authored notes  ',
  key: ' KEY_1 ', schemeAbbreviation: ' Br ', order: 0, laboratoryId: '' });

test('master input keeps authored notes and zero order while normalizing identity and visible required fields', () => {
  const command = input(); const parsed = testParameterInput({ ...command, id: command.id.toUpperCase() });
  assert.equal(parsed.id, command.id); assert.equal(parsed.name, 'Parameter'); assert.equal(parsed.description, command.description);
  assert.equal(parsed.key, 'KEY_1'); assert.equal(parsed.schemeAbbreviation, 'Br'); assert.equal(parsed.order, 0);
  assert.equal(parsed.laboratoryId, null); assert.equal(parsed.measurementUncertainty, null); assert.equal(command.name, '  Parameter  ');
});

test('master input rejects invalid revisions, keys, text and hidden scientific fields before any write', () => {
  const command = input();
  for (const change of [{ revision: -1 }, { revision: '0' }, { revision: 2_147_483_647 }, { order: -1 }, { order: 0.5 }, { order: null },
    { name: ' ' }, { name: 'x'.repeat(201) }, { name: 'bad\0name' }, { description: 'bad\0notes' }, { description: 'x'.repeat(16001) },
    { key: 'with spaces' }, { schemeAbbreviation: 'Ω' }, { key: 'x'.repeat(65) }, { laboratoryId: 'not-a-lab' },
    { defaultScale: 0 }, { methods: [] }, { active: false }, { code: 'replace identity' }, { savedBy: randomUUID() }]) {
    assert.throws(() => testParameterInput({ ...command, ...change }), (error) => error.status === 400, JSON.stringify(change));
  }
});
