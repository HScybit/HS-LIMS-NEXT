import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { checklistInput, checklistRetirementInput, checklistListInput } from '../../src/checklists/input.js';

const command = (changes = {}) => ({ id: randomUUID(), requestId: randomUUID(), revision: 0, name: 'Checklist',
  items: [{ id: randomUUID(), prompt: 'First check' }], ...changes });

test('checklist input preserves stable ordered identities, trims source text and distinguishes false from omitted fields', () => {
  const input = command({ name: `  ${'N'.repeat(200)}  `, isActive: false });
  input.items[0].prompt = '  0  '; input.items.push({ id: randomUUID().toUpperCase(), prompt: 'false' });
  const result = checklistInput(input, { create: true });
  assert.equal(result.name.length, 200); assert.equal(result.isActive, false);
  assert.deepEqual(result.items, [{ id: input.items[0].id, prompt: '0' }, { id: input.items[1].id.toLowerCase(), prompt: 'false' }]);
  const omitted = checklistInput({ id: input.id, requestId: randomUUID(), revision: 0 });
  assert.equal(omitted.name, undefined); assert.equal(omitted.items, undefined); assert.equal(omitted.isActive, undefined);
  assert.equal(checklistInput(command(), { create: true }).isActive, undefined);
});

test('checklist source Unicode duplicate comparison rejects folded duplicates without locale-dependent substitutions', () => {
  for (const prompts of [[' A ', 'a'], ['İ', 'i\u0307'], ['ΟΣ', 'ος'], ['जल', 'जल']]) {
    assert.throws(() => checklistInput(command({ items: prompts.map((prompt) => ({ id: randomUUID(), prompt })) })), { code: 'duplicate_checklist_items' });
  }
  for (const prompts of [['İ', 'i'], ['ß', 'SS'], ['Σ', 'ς'], ['é', 'e\u0301']]) {
    assert.equal(checklistInput(command({ items: prompts.map((prompt) => ({ id: randomUUID(), prompt })) })).items.length, 2);
  }
});

test('checklist authoring rejects empty/null/malformed text, duplicate identities and line item boundaries', () => {
  for (const name of [null, false, 0, '', ' \n ', 'x'.repeat(201), '\uD800', 'a\0b']) assert.throws(() => checklistInput(command({ name })), { status: 400 });
  for (const isActive of [null, '', 0, 'false']) assert.throws(() => checklistInput(command({ isActive })), { status: 400 });
  for (const items of [null, {}, [], [null], [undefined], new Array(1), [{ id: randomUUID(), prompt: '' }], [{ id: randomUUID(), prompt: 'a'.repeat(501) }],
    Array.from({ length: 201 }, (_, index) => ({ id: randomUUID(), prompt: String(index) }))]) assert.throws(() => checklistInput(command({ items })), { status: 400 });
  const item = { id: randomUUID(), prompt: 'A' };
  assert.throws(() => checklistInput(command({ items: [item, { id: item.id.toUpperCase(), prompt: 'B' }] })), { code: 'invalid_checklist_items' });
  assert.equal(checklistInput(command({ items: Array.from({ length: 200 }, (_, index) => ({ id: randomUUID(), prompt: `${index}`.padEnd(500, 'a') })) })).items.length, 200);
});

test('checklist command and retirement reject unknown fields and invalid revisions without filling omitted updates', () => {
  for (const revision of [-1, null, '1', 0.1, 2147483647]) assert.throws(() => checklistInput(command({ revision })), { status: 400 });
  for (const changes of [{ revision: 1 }, { name: undefined }, { items: undefined }]) assert.throws(() => checklistInput(command(changes), { create: true }), { status: 400 });
  assert.throws(() => checklistInput(command({ organizationId: randomUUID() })), { status: 400 });
  assert.throws(() => checklistRetirementInput(command()), { status: 400 });
  const removal = { id: randomUUID(), requestId: randomUUID(), revision: 4 };
  assert.deepEqual(checklistRetirementInput(removal), removal);
});

test('checklist listings bound paging and whitelist source filters and sorting', () => {
  assert.deepEqual(checklistListInput(), { page: 1, pageSize: 10, search: '', nameFilter: '', activeFilter: undefined, sort: null });
  for (const value of [false, 'false']) assert.equal(checklistListInput({ filters: { isActive: { type: 'boolean', value } } }).activeFilter, false);
  assert.equal(checklistListInput({ search: ' %_\\ ', filters: { name: { type: 'text', value: ' A B ' } }, sort: { key: 'isActive', dir: 'desc' } }).search, '%_\\');
  for (const value of [null, [], { page: 0 }, { pageSize: 101 }, { page: 1000001 }, { filters: { name: { type: 'date' } } },
    { filters: { isActive: { type: 'boolean', value: null } } }, { sort: { key: 'name;SELECT', dir: 'asc' } }, { sort: { key: 'name', dir: 'ASC' } }]) {
    assert.throws(() => checklistListInput(value), { status: 400 });
  }
});
