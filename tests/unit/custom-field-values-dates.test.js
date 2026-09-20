import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import moment from 'moment';
import { customFieldDateDisplayFormat, customFieldDateDisplay, customFieldDateInput, customFieldDateTimeInput, parseCustomFieldDate } from '../../src/custom-fields/dates.js';

test('custom field date parsing preserves empty, false, epoch, wrapper and native object distinctions', () => {
  for (const value of [undefined, null, '', '  ', false, 'not a date', new Date(NaN)]) {
    assert.equal(parseCustomFieldDate(value, 'date'), null);
    assert.equal(customFieldDateInput(value, 'date'), '');
    assert.equal(customFieldDateTimeInput(value, 'date_time'), '');
  }
  assert.equal(parseCustomFieldDate(0, 'date').toISOString(), '1970-01-01T00:00:00.000Z');
  assert.equal(parseCustomFieldDate({ value: '', display_value: '31/12/2026' }, 'date'), null);
  assert.equal(customFieldDateInput({ value: null, display_value: '31/12/2026' }, 'date'), '2026-12-31');
  assert.equal(customFieldDateInput({ value: 0, display_value: '31/12/2026' }, 'date'), customFieldDateInput(0, 'date'));
  for (const key of ['label', 'name', 'key', '_id']) assert.equal(customFieldDateInput({ [key]: '31/12/2026' }, 'date'), '2026-12-31');
  const native = new Date('2026-09-13T12:00:00.123Z');
  assert.equal(parseCustomFieldDate(native, 'date_time').toISOString(), native.toISOString());
  const source = moment(native); const parsed = parseCustomFieldDate(source, 'date_time');
  assert.notEqual(parsed, source); parsed.add(1, 'day');
  assert.equal(source.toISOString(), native.toISOString());
});

test('date control formatting preserves the source passthrough while strict parsing rejects invalid dates', () => {
  for (const value of ['2026-02-29', '2026-02-31', '2026-13-01']) {
    assert.equal(parseCustomFieldDate(value, 'date'), null);
    assert.equal(customFieldDateInput(value, 'date'), value);
    assert.equal(customFieldDateDisplay(value, 'date'), value);
  }
  assert.equal(customFieldDateInput(' 2026-12-31suffix ', 'date'), '2026-12-31');
  assert.equal(customFieldDateTimeInput('2026-02-31T12:30', 'date_time'), '2026-02-31T12:30');
  assert.equal(parseCustomFieldDate('2026-02-31T12:30', 'date_time'), null);
  assert.equal(customFieldDateInput('2024-02-29', 'date'), '2024-02-29');
  assert.equal(customFieldDateDisplay({ value: '', display_value: '31/12/2026' }, 'date'), '[object Object]');
});

test('configured date formats resolve ambiguous days and preserve defaults, aliases and non-date values', () => {
  assert.equal(customFieldDateDisplayFormat({ fieldType: 'date', dateFormat: ' MM/DD/YYYY ' }), 'MM/DD/YYYY');
  assert.equal(customFieldDateDisplayFormat({ fieldType: 'date', dateFormat: 'invalid' }), 'DD/MM/YYYY');
  assert.equal(customFieldDateDisplayFormat('date_time'), 'DD/MM/YYYY HH:mm:ss');
  assert.equal(customFieldDateDisplayFormat({ fieldType: 'date', dateFormat: 'invalid' }, 'YYYY-MM-DD'), 'YYYY-MM-DD');
  assert.equal(customFieldDateDisplayFormat('text', 'source fallback'), 'source fallback');
  assert.equal(customFieldDateInput('01/02/2026', { fieldType: 'date', dateFormat: 'MM/DD/YYYY' }), '2026-01-02');
  assert.equal(customFieldDateInput('01/02/2026', { fieldType: 'date', dateFormat: 'DD/MM/YYYY' }), '2026-02-01');
  for (const alias of ['datetime', 'datetime_local', 'datetime-local', ' DATETIME-LOCAL ']) {
    assert.equal(customFieldDateDisplay('2026-09-13T12:30', { fieldType: alias }), '13/09/2026 12:30:00');
  }
  for (const value of ['unchanged', 0, false, ['unchanged'], { value: 'unchanged' }]) assert.equal(customFieldDateDisplay(value, 'text'), value);
  for (const value of [null, undefined, '']) assert.equal(customFieldDateDisplay(value, 'date'), '');
});

test('all 37 configured formats reproduce synthetic values characterized from the source formatter', () => {
  const fixtures = JSON.parse(readFileSync(new URL('../fixtures/custom-field-date-formats.json', import.meta.url)));
  assert.equal(fixtures.length, 37);
  for (const fixture of fixtures) {
    const field = { fieldType: fixture.kind, [fixture.kind === 'date' ? 'dateFormat' : 'datetimeFormat']: fixture.format };
    assert.equal(customFieldDateDisplay(fixture.input, field), fixture.input, fixture.format);
    assert.equal(customFieldDateInput(fixture.input, field), fixture.dateInput, fixture.format);
    assert.equal(customFieldDateTimeInput(fixture.input, field), fixture.dateTimeInput, fixture.format);
  }
});

test('offset display and DST gaps/folds retain the source local clock and native input behavior in four zones', () => {
  const moduleUrl = new URL('../../src/custom-fields/dates.js', import.meta.url).href;
  const fixtures = JSON.parse(readFileSync(new URL('../fixtures/custom-field-date-timezones.json', import.meta.url)));
  for (const fixture of fixtures) {
    const program = `import assert from 'node:assert/strict'; import * as dates from ${JSON.stringify(moduleUrl)};
      for (const fixture of ${JSON.stringify(fixture.cases)}) {
        assert.equal(dates.parseCustomFieldDate(fixture.input, fixture.kind)?.toISOString(), fixture.parsedIso);
        assert.equal(dates.customFieldDateDisplay(fixture.input, fixture.kind), fixture.display);
        assert.equal(dates.customFieldDateInput(fixture.input, fixture.kind), fixture.dateInput);
        assert.equal(dates.customFieldDateTimeInput(fixture.input, fixture.kind), fixture.dateTimeInput);
      }`;
    execFileSync(process.execPath, ['--input-type=module', '-e', program], { env: { ...process.env, TZ: fixture.timeZone }, timeout: 10_000 });
  }
});
