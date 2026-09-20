import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareSelectOptions, selectOptionForValue } from '../../src/components/ui/selectUtils.js';

const id = 'AFAAF09D-723B-4A1C-9A88-44D4237FE0AC';
test('case-insensitive option matching retains original UUID spelling and labels', () => {
  const options = [{ value: id, label: 'Saved person' }]; const before = structuredClone(options);
  const prepared = prepareSelectOptions(options, { caseInsensitiveValues: true });
  assert.equal(prepared.byValue.get(id.toLowerCase())?.value, id);
  assert.equal(prepared.byValue.get(id.toLowerCase())?.label, 'Saved person');
  assert.deepEqual(options, before);
});
test('ordinary choices preserve case distinctions and existing zero/false keys', () => {
  const options = [{ value: 'A', label: 'Upper' }, { value: 'a', label: 'Lower' }, { value: 0, label: 'Zero' }, { value: false, label: 'False' }];
  const prepared = prepareSelectOptions(options);
  assert.equal(prepared.byValue.get('A').label, 'Upper'); assert.equal(prepared.byValue.get('a').label, 'Lower');
  assert.equal(prepared.byValue.get('0').value, 0); assert.equal(prepared.byValue.get('false').value, false);
});
test('grouped case-insensitive choices preserve their original ordered catalog', () => {
  const options = [{ label: 'People', options: [{ value: id, label: 'Saved person' }] }, { value: false, label: 'False' }];
  const prepared = prepareSelectOptions(options, { caseInsensitiveValues: true });
  assert.deepEqual(prepared.options, options); assert.equal(prepared.byValue.get(id.toLowerCase())?.label, 'Saved person');
  assert.equal(prepared.byValue.get('false').value, false);
});

test('resolving a canonical user option keeps each selected raw spelling without mutating the catalog', () => {
  const options = [{ value: id.toLowerCase(), label: 'Saved person' }];
  const model = prepareSelectOptions(options, { caseInsensitiveValues: true }); const original = structuredClone(model.options);
  const values = [id, id.toLowerCase(), id]; const selections = values.map(value => selectOptionForValue(value, model));
  assert.deepEqual(selections.map(option => option.value), values); assert(selections.every(option => option.label === 'Saved person'));
  assert.deepEqual(model.options, original); assert.equal(model.byValue.get(id.toLowerCase()).value, id.toLowerCase());
});

test('async choice fallbacks retain raw aliases and unavailable selections retain their own values', () => {
  const model = prepareSelectOptions([], { caseInsensitiveValues: true }); const option = { value: id.toLowerCase(), label: 'Found asynchronously' };
  assert.deepEqual(selectOptionForValue(id, model, [option]), { value: id, label: option.label }); assert.equal(option.value, id.toLowerCase());
  for (const value of [0, false, '', 'Unavailable']) assert.deepEqual(selectOptionForValue(value, model), { value, label: String(value) });
  assert.equal(prepareSelectOptions(null, { caseInsensitiveValues: true }).byValue.size, 0);
});

test('ordinary option resolution preserves existing canonical values and case-sensitive fallbacks', () => {
  const model = prepareSelectOptions([{ value: 0, label: 'Zero' }, { value: 'A', label: 'Upper' }]);
  assert.equal(selectOptionForValue('0', model).value, 0);
  assert.deepEqual(selectOptionForValue('a', model), { value: 'a', label: 'a' });
  assert.deepEqual(selectOptionForValue('a', model, [{ value: 'a', label: 'Lower' }]), { value: 'a', label: 'Lower' });
});
