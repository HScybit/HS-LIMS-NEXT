import test from 'node:test';
import assert from 'node:assert/strict';
import { masterCustomFieldDraft } from '../../src/masters/custom-field-draft.js';

const lookup = (id, key = 'place', extra = {}) => ({ id, key, fieldType: 'lookup', ...extra });
test('master lookup drafts initialize by the saved key across replacement IDs and preserve primitive types', () => {
  for (const value of [false, 0, '0', 'unknown']) {
    assert.deepEqual(masterCustomFieldDraft([lookup('new')], [{ fieldId: 'old', key: 'place', value }]), { new: value });
  }
  assert.deepEqual(masterCustomFieldDraft([lookup('new', 'other')], [{ fieldId: 'new', key: 'place', value: 'Old key' }]), { new: '' });
});
test('master lookup refresh preserves current repeated values and initializes only undefined drafts', () => {
  const value = ['A', 'A', false, 0]; const current = { old: value };
  const next = masterCustomFieldDraft([lookup('new', 'place', { allowsMultiple: true })], [], [lookup('old')], current);
  assert.equal(next.new, value); assert.deepEqual(current, { old: value });
  for (const raw of ['', false, 0, null]) assert.equal(masterCustomFieldDraft([lookup('new')], [], [lookup('old')], { old: raw }).new, raw);
  assert.equal(masterCustomFieldDraft([lookup('new')], [{ key: 'place', value: 'Saved' }], [lookup('old')], { old: undefined }).new, 'Saved');
});
test('master lookup renames do not inherit old drafts and removed fields are pruned', () => {
  assert.deepEqual(masterCustomFieldDraft([lookup('same', 'renamed')], [], [lookup('same')], { same: 'Draft' }), { same: '' });
  assert.deepEqual(masterCustomFieldDraft([], [], [lookup('old')], { old: 'Draft' }), {});
  assert.deepEqual(masterCustomFieldDraft([lookup('new', '__proto__')], [], [lookup('old', '__proto__')], { old: 'Literal key' }), Object.fromEntries([['new', 'Literal key']]));
});
test('master nonlookup drafts retain the existing ID-based initialization and refresh behavior', () => {
  const field = { id: 'new', key: 'note', fieldType: 'text' };
  assert.deepEqual(masterCustomFieldDraft([field], [{ fieldId: 'old', key: 'note', value: 'Other ID' }]), { new: '' });
  assert.deepEqual(masterCustomFieldDraft([field], [{ fieldId: 'new', key: 'prior', value: 'Same ID' }]), { new: 'Same ID' });
  assert.deepEqual(masterCustomFieldDraft([field], [], [], { new: 'Current' }), { new: 'Current' });
});
