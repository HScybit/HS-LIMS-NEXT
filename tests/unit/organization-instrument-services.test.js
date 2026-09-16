import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { instrumentServiceSettingsInput } from '../../src/organization-settings/instrument-services.js';

const row = (changes = {}) => ({ id: randomUUID(), serviceCode: 'calibration', displayLabel: 'Calibration', isActive: true, ...changes });
const parse = instrumentServiceTypes => instrumentServiceSettingsInput({ instrumentServiceTypes });
const invalid = value => assert.throws(() => parse(value), error => error.status === 400);

test('instrument service omission, empty lists and blank editors remain distinct', () => {
  assert.equal(instrumentServiceSettingsInput({}), null); assert.deepEqual(parse([]), []);
  assert.deepEqual(parse([row({ serviceCode: ' \t', displayLabel: '\n ' })]), []);
  for (const value of [null, undefined, {}, '', 0]) invalid(value);
});

test('source key formats, trimmed values, Active and stable identity survive normalization', () => {
  const original = row({ serviceCode: ' A._/-01 ', displayLabel: ' Calibration Schedule ', isActive: false });
  assert.deepEqual(parse([{ ...original, id: original.id.toUpperCase() }]), [{ ...original, serviceCode: 'A._/-01', displayLabel: 'Calibration Schedule' }]);
  assert.equal(original.serviceCode, ' A._/-01 ');
});

test('partial, invalid, duplicate and malformed service rows are rejected', () => {
  for (const changes of [{ serviceCode: '' }, { displayLabel: '' }, { serviceCode: '-A' }, { serviceCode: 'A B' },
    { serviceCode: 'é' }, { displayLabel: 'A\0B' }, { displayLabel: '\ud800' }, { serviceCode: '\udc00' },
    { id: 'invalid' }, { isActive: 'true' }, { isActive: undefined }, { serviceCode: null }, { displayLabel: 2 }, { hidden: true }]) invalid([row(changes)]);
  invalid([null]); invalid([[]]);
  const first = row(); invalid([first, row({ id: first.id.toUpperCase(), serviceCode: 'other' })]);
  invalid([first, row({ serviceCode: 'CALIBRATION' })]);
  invalid([row({ id: first.id, serviceCode: '', displayLabel: '' }), first]);
});

test('instrument service bounds allow 100 rows and the full validated source lengths', () => {
  const entries = Array.from({ length: 100 }, (_, index) => row({ serviceCode: String(index).padStart(64, 'A'), displayLabel: 'L'.repeat(150) }));
  assert.deepEqual(parse(entries), entries); invalid([...entries, row()]);
  invalid([row({ serviceCode: 'A'.repeat(65) })]); invalid([row({ displayLabel: 'A'.repeat(151) })]);
  assert.equal(parse([row({ serviceCode: '  ' + 'A'.repeat(64) + '\n', displayLabel: ' ' + 'L'.repeat(150) + ' ' })])[0].serviceCode.length, 64);
});

test('renaming and reordering retain row identities without using names or positions as keys', () => {
  const first = row(); const second = row({ serviceCode: 'PM', displayLabel: 'Maintenance' });
  assert.deepEqual(parse([second, { ...first, serviceCode: 'CAL', displayLabel: 'Renamed' }]).map(item => item.id), [second.id, first.id]);
});
