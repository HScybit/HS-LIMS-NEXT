import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { workflowCloneInput } from '../../src/workflows/master-clone.js';

test('workflow cloning preserves request identities and distinguishes automatic from explicit version selection', () => {
  const input = { id: randomUUID().toUpperCase(), requestId: randomUUID().toUpperCase() }; const original = { ...input };
  const automatic = workflowCloneInput(input); assert.deepEqual(input, original);
  assert.equal(automatic.id, input.id.toLowerCase()); assert.equal(automatic.requestId, input.requestId.toLowerCase()); assert.equal(automatic.sourceVersionId, null);
  const sourceVersionId = randomUUID().toUpperCase();
  assert.equal(workflowCloneInput({ ...input, sourceVersionId }).sourceVersionId, sourceVersionId.toLowerCase());
  for (const change of [{ id: '' }, { requestId: null }, { sourceVersionId: null }, { sourceVersionId: '' }, { sourceVersionId: false },
    { createdBy: randomUUID() }, { name: 'Unrequested name' }, { active: false }]) {
    assert.throws(() => workflowCloneInput({ ...input, ...change }), { status: 400 });
  }
});
