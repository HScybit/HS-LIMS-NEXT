import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { generatedMethodCode, methodInput } from '../../src/masters/methods.js';

const input = () => ({ id: randomUUID(), requestId: randomUUID(), revision: 0, name: '  Method  ', uuid: '  Method ISO 123 / Ω  ', description: '  Raw notes  ' });

test('method input keeps free-text UUID, raw notes, ordered users and typed zero/false with source defaults', () => {
  const draft = input(); const saved = methodInput(draft);
  assert.equal(saved.name, 'Method'); assert.equal(saved.uuid, 'Method ISO 123 / Ω'); assert.equal(saved.description, draft.description);
  assert.equal(saved.decimalScale, 4); assert.equal(saved.parseNumber, false); assert.deepEqual(saved.accessUserIds, []);
  const users = [randomUUID(), randomUUID()];
  assert.deepEqual(methodInput({ ...draft, decimalScale: 0, parseNumber: false, accessUserIds: users }).accessUserIds, users);
  assert.equal(methodInput({ ...draft, decimalScale: 0 }).decimalScale, 0);
  assert.equal(generatedMethodCode(' ISO 123 / Ω '), 'ISO-123-/');
  assert.equal(generatedMethodCode('Ω'), 'METHOD'); assert.equal(generatedMethodCode('x'.repeat(100)), 'X'.repeat(64));
  assert.equal(methodInput({ ...draft, uuid: 'x'.repeat(100) }).uuid.length, 100);
});

test('method validation rejects coercion, duplicate users, hidden settings and malformed or oversized text', () => {
  const draft = input(); const user = randomUUID();
  for (const change of [{ name: '' }, { uuid: ' ' }, { uuid: 'x'.repeat(101) }, { name: 'x'.repeat(201) }, { description: '\0' },
    { decimalScale: null }, { decimalScale: -1 }, { decimalScale: 13 }, { decimalScale: '4' }, { parseNumber: 'false' }, { parseNumber: null },
    { accessUserIds: null }, { accessUserIds: [user, user.toUpperCase()] }, { accessUserIds: ['bad'] }, { accessUserIds: Array(501).fill(user) },
    { revision: null }, { revision: -1 }, { code: 'replace hidden identity' }, { active: false }, { savedBy: user }]) {
    assert.throws(() => methodInput({ ...draft, ...change }), (error) => error.status === 400, JSON.stringify(change));
  }
});
