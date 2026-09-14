import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { workflowEditorCommandInput, workflowEditorOperations, workflowCommandMaxBytes } from '../../src/workflows/command-input.js';

const workflowId = randomUUID();
const envelope = (operation = 'patch_state') => ({ requestId: randomUUID(), versionId: randomUUID(), revision: 1, operation,
  ...(operation.startsWith('patch_') || operation.startsWith('delete_') ? { elementId: randomUUID() } : {}),
  ...(!operation.startsWith('delete_') ? { input: { name: 'Synthetic command' } } : {}) });

test('editor commands normalize envelope identities and enforce operation-specific envelopes', () => {
  for (const operation of workflowEditorOperations) {
    const input = envelope(operation); const before = structuredClone(input);
    const result = workflowEditorCommandInput(workflowId.toUpperCase(), { ...input, requestId: input.requestId.toUpperCase() });
    assert.equal(result.workflowId, workflowId); assert.equal(result.requestId, input.requestId); assert.equal(result.operation, operation);
    assert.equal(result.fingerprint.length, 32); assert.deepEqual(input, before);
  }
});

test('command fingerprints ignore object key ordering while retaining exact array order, values and workflow identity', () => {
  const input = envelope(); input.input = { name: '0', roles: [randomUUID(), randomUUID()], metadata: { value: null, flag: false, count: 0, text: '' } };
  const reordered = { ...input, input: { metadata: { text: '', count: 0, flag: false, value: null }, roles: input.input.roles, name: '0' } };
  const first = workflowEditorCommandInput(workflowId, input);
  assert.deepEqual(first.fingerprint, workflowEditorCommandInput(workflowId, reordered).fingerprint);
  assert.notDeepEqual(first.fingerprint, workflowEditorCommandInput(randomUUID(), input).fingerprint);
  assert.notDeepEqual(first.fingerprint, workflowEditorCommandInput(workflowId, { ...input, input: { ...input.input, roles: [...input.input.roles].reverse() } }).fingerprint);
  assert.deepEqual(first.input, input.input); assert.notEqual(first.input, input.input);
});

test('editor command envelopes reject missing, extra, stale-shaped and unsupported properties', () => {
  const value = envelope();
  for (const input of [null, [], {}, { ...value, actorId: randomUUID() }, { ...value, operation: 'replace_graph' },
    { ...value, elementId: null }, { ...value, revision: 0 }, { ...value, revision: '1' }, { ...value, input: null }, { ...value, input: [] },
    { ...envelope('create_state'), elementId: randomUUID() }, { ...envelope('delete_state'), input: {} },
    { ...value, versionId: 'invalid' }]) assert.throws(() => workflowEditorCommandInput(workflowId, input), { status: 400 });
  const missingElement = envelope(); delete missingElement.elementId;
  const missingInput = envelope(); delete missingInput.input;
  assert.throws(() => workflowEditorCommandInput(workflowId, missingElement), { status: 400 });
  assert.throws(() => workflowEditorCommandInput(workflowId, missingInput), { status: 400 });
});

test('fingerprinting rejects non-JSON data, cycles, invalid Unicode and excessive depth or size', () => {
  const value = envelope(); const cyclic = {}; cyclic.self = cyclic;
  let deep = {}; for (let index = 0; index < 18; index++) deep = { child: deep };
  for (const body of [{ value: undefined }, { value: NaN }, { value: Infinity }, { value: 1n }, { value: () => {} },
    { value: new Date() }, { value: '\0' }, { value: '\uD800' }, { '\uD800': 1 }, { value: Array(1) }, cyclic, deep]) {
    assert.throws(() => workflowEditorCommandInput(workflowId, { ...value, input: body }), { status: 400 });
  }
  assert.throws(() => workflowEditorCommandInput(workflowId, { ...value, input: { name: 'x'.repeat(workflowCommandMaxBytes) } }), { status: 413 });
});

test('the existing maximum approval-stage shape fits the command envelope bounds', () => {
  const value = envelope('create_transition');
  value.input = { approverStages: Array.from({ length: 100 }, (_, index) => ({ stageNumber: index + 1, roleIds: Array.from({ length: 500 }, () => randomUUID()) })),
    conditions: Array.from({ length: 100 }, () => ({ sourceField: 'synthetic.value', operator: 'eq', comparisonValue: 'x'.repeat(5000) })) };
  const before = JSON.stringify(value); const result = workflowEditorCommandInput(workflowId, value);
  assert.equal(result.fingerprint.length, 32); assert.equal(JSON.stringify(value), before);
});
