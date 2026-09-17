import test from 'node:test';
import assert from 'node:assert/strict';
import { lookupOptionsForValue } from '../../src/masters/master-custom-field-values.js';

test('lookup display options stay bounded to each field selection and preserve zero/false labels, order and unavailable values', () => {
  const source = new Map(Array.from({ length: 5000 }, (_, index) => [String(index), { value: String(index), label: index }]));
  source.set('false', { value: 'false', label: false }); source.set('missing', null);
  source.values = () => { throw new Error('Do not enumerate choices selected in unrelated fields.'); };
  const selections = new Map([['source', source], ['other', new Map([['0', { value: '0', label: 'Other label' }]])]]);
  assert.deepEqual(lookupOptionsForValue(selections, 'source', ['2', 0, '2', false, 'missing', 'unknown']),
    [{ value: '2', label: 2 }, { value: '0', label: 0 }, { value: 'false', label: false }]);
  assert.deepEqual(lookupOptionsForValue(selections, 'source', false), [{ value: 'false', label: false }]);
  assert.deepEqual(lookupOptionsForValue(selections, 'other', 0), [{ value: '0', label: 'Other label' }]);
  assert.deepEqual(lookupOptionsForValue(selections, 'absent', ['0']), []);
  assert.deepEqual(lookupOptionsForValue(selections, 'source', []), []);
});
