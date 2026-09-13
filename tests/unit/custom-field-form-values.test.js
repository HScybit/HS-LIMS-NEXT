import test from 'node:test';
import assert from 'node:assert/strict';
import { customFieldControl, customFieldInitialValue, customFieldSubmittedValue, customFieldFormDisplayValue, customFieldNeedsGeneration } from '../../src/custom-fields/form-values.js';

const field = (fieldType, other = {}) => ({ id: 'synthetic-field', revision: 1, label: 'Synthetic', fieldType, ...other });

test('custom field controls preserve source scalar, repeated text, single attachment and multiple user behavior', () => {
  const cases = [['text','text'], ['number','number'], ['date','date'], ['select','select'], ['lookup','select'], ['longtext','textarea'],
    ['attachment','file'], ['multi_user_select','relation'], ['date_time','datetime-local'], ['checkbox','boolean'], ['email','email']];
  for (const [kind, expected] of cases) {
    assert.equal(customFieldControl(field(kind)).type, expected);
    const multiple = customFieldControl(field(kind, { allowsMultiple: true, isRequired: true }));
    assert.equal(multiple.required, true);
    assert.equal(multiple.type, ['file','relation','select'].includes(expected) ? expected : 'array');
    assert.equal(multiple.multiple, expected !== 'file');
  }
  assert.equal(customFieldControl(field('multi_user_select')).multiple, true);
  const lookup = [{ value: 'line-id', label: 'Lookup row' }];
  assert.deepEqual(customFieldControl(field('lookup'), lookup).options, lookup);
  assert.deepEqual(customFieldControl(field('select', { options: [{ id: 'stable-option', key: 'A', label: 'Alpha' }] })).options, [{ value: 'A', label: 'Alpha' }]);
});

test('initial custom values preserve an untouched checkbox, explicit false/zero and date display fallback', () => {
  assert.equal(customFieldInitialValue(field('checkbox'), undefined), '');
  assert.equal(customFieldInitialValue(field('checkbox'), { value: false }), false);
  assert.equal(customFieldInitialValue(field('number'), { value: 0, displayValue: 'Fallback' }), 0);
  assert.equal(customFieldInitialValue(field('text'), { value: '', displayValue: 'Fallback' }), '');
  assert.equal(customFieldInitialValue(field('date'), { value: '', displayValue: '31/12/2026' }), '31/12/2026');
  assert.equal(customFieldInitialValue(field('date_time'), { value: null, displayValue: '31/12/2026 12:30' }), '31/12/2026 12:30');
  assert.deepEqual(customFieldInitialValue(field('date', { allowsMultiple: true }), { value: '', displayValue: '31/12/2026' }), []);
  assert.deepEqual(customFieldInitialValue(field('multi_user_select'), { value: 'user-id' }), ['user-id']);
  assert.deepEqual(customFieldInitialValue(field('select', { allowsMultiple: true }), { value: false }), [false]);
});

test('submitted arrays remove blank rows and keep meaningful zero/false values without mutating the draft', () => {
  const values = [0, false, '', null, undefined, '  ', ' A '];
  assert.deepEqual(customFieldSubmittedValue(values), [0, false, ' A ']);
  assert.equal(values.length, 7);
  for (const value of [undefined, null]) assert.equal(customFieldSubmittedValue(value), '');
  for (const value of [0, false, '', '  ']) assert.equal(customFieldSubmittedValue(value), value);
});

test('form display retains source option keys, raw date arrays and distinct false/zero array labels', () => {
  const select = field('select', { options: [{ key: 'A', label: 'Alpha' }, { key: 'a', label: 'Lowercase' }, { key: '0', label: 'Zero' }] });
  assert.equal(customFieldFormDisplayValue(['A','a','unknown'], select), 'Alpha, Lowercase, unknown');
  assert.equal(customFieldFormDisplayValue(0, select), 'Zero');
  assert.equal(customFieldFormDisplayValue('A', { ...select, fieldType: 'text' }), 'A');
  assert.equal(customFieldFormDisplayValue([0,false,'0','false','A'], field('text')), '0, false, A');
  assert.equal(customFieldFormDisplayValue(false, field('checkbox')), false);
  assert.equal(customFieldFormDisplayValue('2026-09-13', field('date')), '13/09/2026');
  assert.equal(customFieldFormDisplayValue(['2026-09-13'], field('date', { allowsMultiple: true })), '2026-09-13');
  assert.equal(customFieldFormDisplayValue('line-id', field('lookup'), [{ value: 'line-id', label: 'Selected row' }]), 'Selected row');
});

test('automatic generation retains source create-only initialization and empty on-submit editing rules', () => {
  for (const generatedAt of ['on_init','on_submit','on_demand','on_transition','on_transition_success']) {
    for (const mode of ['create','edit']) {
      const definition = field('text', { scheme: '{{entity.name}}', generatedAt });
      const expected = generatedAt === 'on_submit' || (mode === 'create' && generatedAt === 'on_init');
      for (const value of [undefined,null,'','  ',[],['',null]]) assert.equal(customFieldNeedsGeneration(definition, mode, value), expected);
      for (const value of [0,false,'value',[0],[false]]) assert.equal(customFieldNeedsGeneration(definition, mode, value), false);
    }
  }
  assert.equal(customFieldNeedsGeneration(field('text'), 'create', ''), false);
  assert.equal(customFieldNeedsGeneration(field('text', { scheme: '{{entity.name}}' }), 'create', ''), true);
});
