import test from 'node:test';
import assert from 'node:assert/strict';
import { organizationDateFormatsInput, organizationDateFormatDefaults } from '../../src/organization-settings/date-formats.js';
import { customFieldDateFormats, customFieldDateTimeFormats } from '../../src/masters/custom-field-config.js';

test('organization date formats preserve omission, explicit clearing and custom format text', () => {
  assert.deepEqual(organizationDateFormatsInput({}), {});
  for (const input of [{ dateFormat: null }, { datetimeFormat: '' }, { dateFormat: '  YYYY [year]  ', datetimeFormat: 'HH:mm Z' },
    { dateFormat: 'x'.repeat(40), datetimeFormat: 'x'.repeat(60) }]) {
    assert.deepEqual(organizationDateFormatsInput(input), input);
  }
  assert.deepEqual(organizationDateFormatsInput(Object.create({ dateFormat: 'YYYY' })), {});
});

test('organization date settings accept every source dropdown choice and default', () => {
  assert.equal(customFieldDateFormats.length, 15); assert.equal(customFieldDateTimeFormats.length, 22);
  for (const [key, formats] of [['dateFormat', customFieldDateFormats], ['datetimeFormat', customFieldDateTimeFormats]]) {
    assert.equal(formats[0].value, organizationDateFormatDefaults[key]);
    for (const { value } of formats) assert.equal(organizationDateFormatsInput({ [key]: value })[key], value);
  }
});

test('malformed, non-text and oversized date settings fail before persistence', () => {
  for (const key of ['dateFormat', 'datetimeFormat']) {
    for (const value of [undefined, 0, false, [], {}, '\0', '\ud800', 'x'.repeat(key === 'dateFormat' ? 41 : 61)]) {
      assert.throws(() => organizationDateFormatsInput({ [key]: value }), { status: 400, code: 'invalid_date_format' });
    }
  }
});
