import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { customFieldDateRange } from '../../src/masters/custom-fields.js';

test('custom field date ranges reject invalid dates and retain open ends', () => {
  assert.deepEqual(customFieldDateRange({}), { start: null, before: null });
  assert.deepEqual(customFieldDateRange({ from: '', to: null }), { start: null, before: null });
  assert.equal(customFieldDateRange({ from: '2026-01-01' }).before, null);
  assert.equal(customFieldDateRange({ to: '2026-01-01' }).start, null);
  for (const filter of [{ from: false }, { to: 0 }, { from: '2026-02-30' }, { to: '0000-01-01' },
    { from: '2026-01-02', to: '2026-01-01' }, { from: '2026-01-01T12:00:00Z' }]) assert.throws(() => customFieldDateRange(filter), { status: 400 });
});

test('date filtering preserves source server-local parsing, including its western-zone date shift and DST', () => {
  const moduleUrl = new URL('../../src/masters/custom-fields.js', import.meta.url).href;
  const cases = [
    ['UTC', '2026-09-13', '2026-09-13T00:00:00.000Z', '2026-09-14T00:00:00.000Z'],
    ['Asia/Kolkata', '2026-09-13', '2026-09-12T18:30:00.000Z', '2026-09-13T18:30:00.000Z'],
    ['America/New_York', '2026-03-09', '2026-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z'],
    ['America/New_York', '2026-11-02', '2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z'],
  ];
  for (const [timeZone, day, start, before] of cases) {
    const program = `import { customFieldDateRange } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(customFieldDateRange({from:${JSON.stringify(day)},to:${JSON.stringify(day)}})));`;
    const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8', env: { ...process.env, TZ: timeZone }, timeout: 10_000 }));
    assert.deepEqual(result, { start, before });
  }
});
