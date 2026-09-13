import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import moment from 'moment';
import { customFieldTimeZone, customFieldTimeZoneDataVersion, parseCustomFieldDateInZone, customFieldDateDisplayInZone } from '../../src/custom-fields/server-dates.js';

test('server date parsing preserves source DST gaps, folds, offsets and calendar display for explicit browser zones', () => {
  const field = { fieldType: 'date_time' };
  assert.equal(parseCustomFieldDateInZone('2026-03-08T02:30', field, 'America/New_York').toISOString(), '2026-03-08T07:30:00.000Z');
  assert.equal(customFieldDateDisplayInZone('2026-03-08T02:30', field, 'America/New_York'), '08/03/2026 03:30:00');
  assert.equal(parseCustomFieldDateInZone('2026-11-01T01:30', field, 'America/New_York').toISOString(), '2026-11-01T05:30:00.000Z');
  assert.equal(parseCustomFieldDateInZone('2026-11-01T01:30-05:00', field, 'America/New_York').toISOString(), '2026-11-01T06:30:00.000Z');
  assert.equal(customFieldDateDisplayInZone('2026-09-13T00:30:00Z', { fieldType: 'date' }, 'America/New_York'), '12/09/2026');
  assert.equal(parseCustomFieldDateInZone('2026-09-13 12:30:45+05:30', field, 'Pacific/Auckland').toISOString(), '2026-09-13T07:00:45.000Z');
  assert.equal(parseCustomFieldDateInZone('2026-12-31 11:30 PM', { ...field, datetimeFormat: 'YYYY-MM-DD hh:mm A' }, 'UTC').toISOString(), '2026-12-31T23:30:00.000Z');
});

test('explicit-zone parsing leaves native Date, Moment instances, zero epochs and empty or invalid values distinct', () => {
  const field = { fieldType: 'date_time' }; const date = new Date('2026-09-13T00:30:00Z'); const original = moment(date); const before = original.toISOString();
  for (const value of [date, original, date.getTime()]) {
    assert.equal(parseCustomFieldDateInZone(value, field, 'Asia/Kolkata').toISOString(), before);
    assert.equal(customFieldDateDisplayInZone(value, field, 'Asia/Kolkata'), '13/09/2026 06:00:00');
  }
  assert.equal(original.toISOString(), before); assert.equal(date.toISOString(), before);
  assert.equal(parseCustomFieldDateInZone(0, field, 'Asia/Kolkata').toISOString(), '1970-01-01T00:00:00.000Z');
  for (const value of [null, undefined, '', false, 'invalid', '2026-02-31', new Date(NaN)]) assert.equal(parseCustomFieldDateInZone(value, field, 'UTC'), null);
  assert.equal(customFieldDateDisplayInZone('2026-02-31', field, 'UTC'), '2026-02-31');
  assert.equal(customFieldDateDisplayInZone(false, { fieldType: 'checkbox' }, 'UTC'), false);
  assert.equal(customFieldDateDisplayInZone({ value: null, display_value: '31/12/2026' }, { fieldType: 'date' }, 'Asia/Kolkata'), '31/12/2026');
});

test('server date parser validates named zones and records a concrete timezone-data version', () => {
  assert.equal(customFieldTimeZone(' UTC '), 'UTC'); assert.equal(customFieldTimeZone('america/new_york'), 'America/New_York');
  assert.match(customFieldTimeZoneDataVersion, /^\d{4}[a-z]$/);
  for (const zone of [null, undefined, '', false, {}, 'Missing/Zone', 'GMT+05:30', 'x'.repeat(101), '__proto__', 'constructor', 'toString', '\0UTC']) {
    assert.throws(() => customFieldTimeZone(zone), { code: 'invalid_custom_field_timezone' });
  }
});

test('one server process parses all source formats in four zones without changing global timezone defaults', async () => {
  const fixtures = JSON.parse(await readFile(new URL('../fixtures/custom-field-date-formats.json', import.meta.url), 'utf8'));
  assert.ok(fixtures.length > 0);
  const beforeZone = process.env.TZ; const beforeDefault = moment.defaultZone; const beforeOffset = moment('2026-09-13T12:30').utcOffset();
  for (const timeZone of ['UTC', 'Asia/Kolkata', 'America/New_York', 'Pacific/Auckland']) {
    for (const fixture of fixtures) {
      const field = { fieldType: fixture.kind, [fixture.kind === 'date' ? 'dateFormat' : 'datetimeFormat']: fixture.format };
      assert.equal(customFieldDateDisplayInZone(fixture.input, field, timeZone), fixture.input, `${timeZone}:${fixture.format}`);
    }
  }
  assert.equal(process.env.TZ, beforeZone); assert.equal(moment.defaultZone, beforeDefault); assert.equal(moment('2026-09-13T12:30').utcOffset(), beforeOffset);
});

test('explicit-zone results are identical under different host timezone settings', () => {
  const source = `import {parseCustomFieldDateInZone,customFieldDateDisplayInZone} from './src/custom-fields/server-dates.js';
    const field={fieldType:'date_time'}; console.log(JSON.stringify(['UTC','Asia/Kolkata','America/New_York','Pacific/Auckland'].map(zone=>
      [parseCustomFieldDateInZone('2026-03-08T02:30',field,zone).toISOString(),customFieldDateDisplayInZone('2026-03-08T02:30',field,zone)])));`;
  const results = ['UTC', 'America/New_York', 'Asia/Kolkata'].map((timeZone) => {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { env: { ...process.env, TZ: timeZone }, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr); return JSON.parse(child.stdout);
  });
  assert.deepEqual(results[0], results[1]); assert.deepEqual(results[0], results[2]);
});
