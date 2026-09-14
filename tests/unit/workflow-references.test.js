import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { workflowReferenceInput } from '../../src/workflows/references.js';

test('workflow reference searches retain literal wildcard text and normalize distinct typed selections', () => {
  assert.deepEqual(workflowReferenceInput('roles'), { search: '', selectedIds: [] });
  const id = randomUUID(); const input = { search: '  0 %_\\  ', selectedIds: [id.toUpperCase()] }; const before = structuredClone(input);
  assert.deepEqual(workflowReferenceInput('templates', input), { search: '0 %_\\', selectedIds: [id] }); assert.deepEqual(input, before);
  const selectedIds = Array.from({ length: 500 }, () => randomUUID());
  assert.deepEqual(workflowReferenceInput('roles', { selectedIds }).selectedIds, selectedIds);
  assert.deepEqual(workflowReferenceInput('roles', { search: null }), { search: '', selectedIds: [] });
});

test('workflow reference inputs reject unsupported kinds, hidden fields, invalid text and invalid selection shapes', () => {
  for (const kind of ['role', 'users', '__proto__', 'constructor', '', null, undefined]) assert.throws(() => workflowReferenceInput(kind), { status: 400 });
  for (const input of [null, [], { organizationId: randomUUID() }, { search: 'x'.repeat(501) }, { search: '\uD800' }, { search: '\0' },
    { search: false }, { selectedIds: null }, { selectedIds: 'id' }, { selectedIds: ['self'] }, { selectedIds: Array.from({ length: 501 }, () => randomUUID()) }]) {
    assert.throws(() => workflowReferenceInput('roles', input), { status: 400 });
  }
  const id = randomUUID(); assert.throws(() => workflowReferenceInput('roles', { selectedIds: [id, id.toUpperCase()] }), { status: 400 });
});
