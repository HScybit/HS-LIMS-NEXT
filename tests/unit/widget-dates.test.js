import test from 'node:test';
import assert from 'node:assert/strict';
import { widgetDateFormat, widgetDateDisplay } from '../../src/templates/widget-dates.js';
import { widgetTimeZone, widgetDateDisplayInZone } from '../../src/templates/server-widget-dates.js';

test('widget dates retain source absence and invalid-value behavior', () => {
  for (const value of [undefined, null, '', 0, false, NaN, new Date(NaN)]) assert.equal(widgetDateDisplay(value), '');
  assert.equal(widgetDateDisplay('2024-02-29'), '29/02/2024');
  assert.equal(widgetDateDisplay('31/01/2026'), '31/01/2026');
  assert.equal(widgetDateDisplay('01/31/2026'), '31/01/2026');
  assert.equal(widgetDateDisplay('1st February 2026'), '01/02/2026');
  assert.equal(widgetDateDisplay('2026-01-31 13:42', 'datetime'), '31/01/2026 13:42:00');
});

test('widget format selection retains exact organization text and valid field overrides', () => {
  for (const mode of ['datetime', 'date_time', 'datetime-local']) {
    assert.equal(widgetDateFormat(mode), 'DD/MM/YYYY HH:mm:ss');
    assert.equal(widgetDateFormat(mode, { datetimeFormat: '[at] HH:mm Z ' }), '[at] HH:mm Z ');
  }
  assert.equal(widgetDateFormat('date', { dateFormat: '  YYYY  ' }), '  YYYY  ');
  assert.equal(widgetDateFormat('date', { dateFormat: '' }), 'DD/MM/YYYY');
  assert.equal(widgetDateFormat('date', { dateFormat: 'YYYY', field: { fieldType: 'date', dateFormat: 'MM/DD/YYYY' } }), 'MM/DD/YYYY');
  assert.equal(widgetDateFormat('datetime', { datetimeFormat: '[source] YYYY', field: { fieldType: 'date_time', datetimeFormat: 'unsupported' } }), '[source] YYYY');
});

test('recorded widget zones control calendar boundaries, wall times and daylight saving without global defaults', () => {
  const options = { datetimeFormat: 'YYYY-MM-DD HH:mm:ss Z' };
  const date = '2026-01-01T01:30:00Z';
  assert.equal(widgetDateDisplayInZone(date, 'datetime', options, 'Asia/Kolkata'), '2026-01-01 07:00:00 +05:30');
  assert.equal(widgetDateDisplayInZone(date, 'datetime', options, 'America/Los_Angeles'), '2025-12-31 17:30:00 -08:00');
  assert.equal(widgetDateDisplayInZone('2026-03-08T07:30:00Z', 'datetime', options, 'America/New_York'), '2026-03-08 03:30:00 -04:00');
  assert.equal(widgetDateDisplayInZone('2026-11-01T05:30:00Z', 'datetime', options, 'America/New_York'), '2026-11-01 01:30:00 -04:00');
  assert.equal(widgetDateDisplayInZone('2026-11-01T06:30:00Z', 'datetime', options, 'America/New_York'), '2026-11-01 01:30:00 -05:00');
  assert.equal(widgetDateDisplayInZone(new Date(date), 'datetime', options, 'UTC'), '2026-01-01 01:30:00 +00:00');
  assert.equal(widgetDateDisplayInZone(date, 'datetime', options, 'Asia/Kolkata'), '2026-01-01 07:00:00 +05:30');
  assert.equal(widgetTimeZone(' asia/kolkata '), 'Asia/Kolkata');
  for (const value of [null, '', 'local', 'Server', {}, 'x'.repeat(101)]) {
    assert.throws(() => widgetDateDisplayInZone(date, 'datetime', options, value), { code: 'invalid_widget_timezone' });
  }
  for (const value of ['01/31/2026', '2026-01-31 13:42', '2026-01-01', 1, true, { value: date }]) {
    assert.throws(() => widgetDateDisplayInZone(value, 'datetime', options, 'UTC'), { code: 'ambiguous_widget_timestamp' });
  }
  for (const value of [null, '', false, 0, new Date(NaN), '2026-02-30T01:30:00Z']) {
    assert.equal(widgetDateDisplayInZone(value, 'datetime', options, 'UTC'), '');
  }
});
