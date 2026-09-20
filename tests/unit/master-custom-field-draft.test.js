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
test('master user selections initialize by saved key and normalize scalar stored values to arrays', () => {
  const field = { id: 'new', key: 'people', fieldType: 'multi_user_select' };
  for (const [value, expected] of [['Person', ['Person']], [null, []], ['', []], [[], []], [['B', 'A', 'A'], ['B', 'A', 'A']]]) {
    assert.deepEqual(masterCustomFieldDraft([field], [{ fieldId: 'old', key: field.key, value }]), { new: expected });
  }
  assert.deepEqual(masterCustomFieldDraft([field], [{ fieldId: 'new', key: 'old_key', value: ['Old person'] }]), { new: [] });
});
test('master user selection refresh preserves explicit drafts and clears renamed or removed keys', () => {
  const old = { id: 'old', key: 'people', fieldType: 'multi_user_select' }; const field = { ...old, id: 'new' };
  const stored = [{ fieldId: old.id, key: old.key, value: ['Saved'] }];
  for (const value of [[], ['B', 'A', 'A'], null, '']) {
    const current = { old: value }; assert.equal(masterCustomFieldDraft([field], stored, [old], current).new, value); assert.deepEqual(current, { old: value });
  }
  assert.deepEqual(masterCustomFieldDraft([field], stored, [old], { old: undefined }), { new: ['Saved'] });
  assert.deepEqual(masterCustomFieldDraft([{ ...old, key: 'renamed' }], stored, [old], { old: ['Draft'] }), { old: [] });
  assert.deepEqual(masterCustomFieldDraft([], stored, [old], { old: ['Draft'] }), {});
});

for (const fieldType of ['text', 'number', 'longtext', 'date', 'date_time', 'checkbox', 'email', 'select']) {
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
