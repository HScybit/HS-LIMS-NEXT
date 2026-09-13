import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { workflowMetadataInput, workflowRetirementInput, workflowCodeBase, workflowListInput } from '../../src/workflows/metadata-input.js';

const input = (changes = {}) => ({ id: randomUUID(), requestId: randomUUID(), metadataRevision: 0, name: 'Synthetic workflow', ...changes });

test('workflow metadata distinguishes omitted fields from explicit false and empty values, without mutating the request', () => {
  const value = input({ id: randomUUID().toUpperCase(), name: '  Zero  ', description: '  0  ', active: false }); const before = structuredClone(value);
  const saved = workflowMetadataInput(value, { create: true });
  assert.deepEqual(value, before); assert.equal(saved.name, 'Zero'); assert.equal(saved.description, '0'); assert.equal(saved.active, false);
  assert.equal(saved.metadataRevision, 0); assert.equal(saved.id, value.id.toLowerCase()); assert.equal(saved.code, 'ZERO'); assert.equal(saved.generatedCode, true);
  assert.equal(saved.appliesTo, 'sample');
  const omitted = workflowMetadataInput(input());
  for (const field of ['description', 'code', 'active', 'appliesTo']) assert.equal(omitted[field], undefined);
  assert.equal(omitted.generatedCode, false);
  assert.equal(workflowMetadataInput(input({ description: null })).description, '');
  assert.equal(workflowMetadataInput(input({ description: '  ' })).description, '');
  const explicit = workflowMetadataInput(input({ code: 'original/code', appliesTo: 'test_request' }), { create: true });
  assert.equal(explicit.code, 'original/code'); assert.equal(explicit.generatedCode, false); assert.equal(explicit.appliesTo, 'test_request');
});

test('workflow metadata rejects malformed identities, text, revisions, flags and unsupported fields', () => {
  for (const changes of [{ id: null }, { requestId: 'bad' }, { metadataRevision: -1 }, { metadataRevision: 0.5 }, { metadataRevision: '1' },
    { metadataRevision: 2147483647 }, { name: '' }, { name: null }, { name: 'a'.repeat(201) }, { name: 'x\0' }, { name: '\ud800' },
    { description: false }, { description: '\udfff' }, { description: 'a'.repeat(10001) }, { code: '' }, { code: 'x'.repeat(65) },
    { appliesTo: null }, { appliesTo: 'unknown' }, { active: 0 }, { active: null }, { createdBy: randomUUID() }]) {
    assert.throws(() => workflowMetadataInput(input(changes)), { status: 400 });
  }
  assert.throws(() => workflowMetadataInput(input({ metadataRevision: 1 }), { create: true }), { code: 'invalid_workflow_revision' });
  const { name: _name, ...retirement } = input();
  assert.equal(workflowRetirementInput(retirement).metadataRevision, 0);
  assert.throws(() => workflowRetirementInput({ ...retirement, active: false }), { status: 400 });
});

test('automatic workflow codes preserve the source normalization, fallback and base length', () => {
  assert.equal(workflowCodeBase('  Incoming / Water_2.1  '), 'INCOMING-/-WATER_2.1');
  assert.equal(workflowCodeBase('Straße'), 'STRASSE'); assert.equal(workflowCodeBase('नमूना'), 'WORKFLOW');
  assert.equal(workflowCodeBase('---'), 'WORKFLOW'); assert.equal(workflowCodeBase('a'.repeat(100)), 'A'.repeat(56));
  assert.equal(workflowCodeBase('.Pre-check'), '.PRE-CHECK');
});

test('workflow list input bounds paging and literal filters and retains server-local date boundaries', () => {
  const value = workflowListInput({ page: 2, pageSize: 100, search: '%_\\', filters: { name: { type: 'text', value: 'A  B' },
    created_at: { type: 'date', from: '2024-02-29', to: '2024-02-29' } }, sort: { key: 'created_at', dir: 'desc' } });
  assert.equal(value.search, '%_\\'); assert.equal(value.name, 'A  B'); assert.equal(value.page, 2); assert.equal(value.pageSize, 100);
  const from = new Date('2024-02-29'); from.setHours(0, 0, 0, 0); const to = new Date('2024-02-29'); to.setHours(23, 59, 59, 999);
  assert.deepEqual(value.from, from); assert.deepEqual(value.to, to);
  for (const invalid of [{ page: 0 }, { pageSize: 101 }, { filters: { code: { type: 'text', value: 'bad' } } }, { sort: { key: 'name;DROP', dir: 'asc' } },
    { sort: { key: 'name', dir: 'ascending' } }, { filters: { name: { type: 'boolean', value: true } } },
    ...['2023-02-29', false, 0, '2024-01-01T00:00:00Z'].map((from) => ({ filters: { created_at: { type: 'date', from } } })),
    { filters: { created_at: { type: 'date', from: '2024-03-01', to: '2024-02-29' } } }]) {
    assert.throws(() => workflowListInput(invalid), { status: 400 });
  }
});
