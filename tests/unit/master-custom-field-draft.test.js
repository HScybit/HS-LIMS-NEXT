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
for (const fieldType of ['select', 'attachment', 'multi_user_select']) test(`master ${fieldType} drafts retain their existing reference initialization`, () => {
  const field = { id: 'new', key: 'note', fieldType };
  const empty = fieldType === 'multi_user_select' ? [] : '';
  const stored = fieldType === 'multi_user_select' ? ['Same ID'] : 'Same ID';
  assert.deepEqual(masterCustomFieldDraft([field], [{ fieldId: 'old', key: 'note', value: 'Other ID' }]), { new: empty });
  assert.deepEqual(masterCustomFieldDraft([field], [{ fieldId: 'new', key: 'prior', value: 'Same ID' }]), { new: stored });
  assert.deepEqual(masterCustomFieldDraft([field], [], [], { new: 'Current' }), { new: 'Current' });
});

for (const fieldType of ['text', 'number', 'longtext', 'date', 'date_time', 'checkbox', 'email']) {
  test(`master ${fieldType} drafts use saved keys and preserve explicit current values through refresh`, () => {
    const field = { id: 'new', key: 'note', fieldType };
    const previous = { ...field, id: 'old' };
    for (const value of ['', 0, false, 'Literal']) {
      assert.deepEqual(masterCustomFieldDraft([field], [{ fieldId: 'old', key: 'note', value }]), { new: value });
    }
    for (const value of ['', 0, false, null, ['A', 'A', 0, false]]) {
      const current = { old: value };
      const next = masterCustomFieldDraft([field], [{ key: 'note', value: 'Saved' }], [previous], current);
      assert.equal(next.new, value); assert.deepEqual(current, { old: value });
    }
    assert.deepEqual(masterCustomFieldDraft([field], [{ key: 'note', value: 'Saved' }], [previous], { old: undefined }), { new: 'Saved' });
    assert.deepEqual(masterCustomFieldDraft([{ ...field, key: 'renamed' }], [{ fieldId: 'new', key: 'note', value: 'Saved' }], [field], { new: 'Draft' }), { new: '' });
    assert.deepEqual(masterCustomFieldDraft([], [{ key: 'note', value: 'Saved' }], [previous], { old: 'Draft' }), {});
    assert.deepEqual(masterCustomFieldDraft([{ ...field, key: '__proto__' }], [], [{ ...previous, key: '__proto__' }], { old: 'Literal key' }), { new: 'Literal key' });
  });
}
