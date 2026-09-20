import test from 'node:test';
import assert from 'node:assert/strict';
import { customFieldValidationError, customFieldSubmittedValue } from '../../src/custom-fields/form-values.js';
import { customFieldTypes } from '../../src/masters/custom-field-config.js';

const field = (fieldType, changes = {}) => ({ fieldType, isRequired: true, allowsMultiple: false, label: 'Synthetic field', ...changes });

test('required scalar Custom Fields retain source false, zero and whitespace distinctions', () => {
  for (const fieldType of ['text', 'longtext', 'checkbox', 'number', 'email', 'date', 'date_time', 'select', 'lookup', 'attachment']) {
    for (const value of [undefined, null, '']) assert.equal(customFieldValidationError(field(fieldType), value), 'Required');
    for (const value of [false, 0, ' ', '0']) assert.equal(customFieldValidationError(field(fieldType), value), null);
    assert.equal(customFieldValidationError(field(fieldType, { isRequired: false }), ''), null);
  }
});

test('required repeated plain-text controls distinguish validation from cleanup and retain invalid-looking items', () => {
  for (const fieldType of ['text', 'longtext', 'checkbox', 'number', 'email', 'date', 'date_time']) {
    const definition = field(fieldType, { allowsMultiple: true });
    for (const value of [undefined, null, '', [], [''], ['  '], [false], [null, false, ' ']]) {
      assert.equal(customFieldValidationError(definition, value), 'Required');
    }
    for (const value of [[0], [true], ['false'], ['not a number/date/email'], [false, 0]]) {
      assert.equal(customFieldValidationError(definition, value), null);
    }
    assert.equal(customFieldValidationError({ ...definition, isRequired: false }, [false]), null);
  }
  assert.deepEqual(customFieldSubmittedValue([false, ' ', 0]), [false, 0]);
});

test('multiple selections and user controls require an array while a file stays scalar despite its multiple flag', () => {
  for (const definition of [field('select', { allowsMultiple: true }), field('lookup', { allowsMultiple: true }), field('multi_user_select'),
    field('multi_user_select', { allowsMultiple: true })]) {
    for (const value of [null, undefined, '', [], 'selected', false, 0]) assert.equal(customFieldValidationError(definition, value), 'Required');
    for (const value of [['selected'], [''], [false], [0]]) assert.equal(customFieldValidationError(definition, value), null);
  }
  assert.equal(customFieldValidationError(field('attachment', { allowsMultiple: true }), 'file-id'), null);
});

test('source scalar number validation converts values without introducing email/date rules or a scientific finite-number policy', () => {
  for (const value of ['12x', 'NaN', '1.2.3']) assert.equal(customFieldValidationError(field('number'), value), 'Please enter a valid number!');
  assert.equal(customFieldValidationError(field('number'), NaN), 'Required');
  assert.equal(customFieldValidationError(field('number', { isRequired: false }), NaN), 'Please enter a valid number!');
  for (const value of ['01.00', '1e3', '0x10', 'Infinity', '-Infinity', Infinity, false, -0]) assert.equal(customFieldValidationError(field('number'), value), null);
  for (const fieldType of ['email', 'date', 'date_time']) assert.equal(customFieldValidationError(field(fieldType), 'invalid legacy representation'), null);
  for (const { value: fieldType } of customFieldTypes) assert.equal(customFieldValidationError(field(fieldType, { isRequired: false }), undefined), null);
});
