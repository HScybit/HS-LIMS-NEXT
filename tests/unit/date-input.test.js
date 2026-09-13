import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { parseVisibleDate, formatDateInput } from '../../src/components/ui/date-input.js';

const originalTimeZone = process.env.TZ;
before(() => { process.env.TZ = 'UTC'; });
after(() => { if (originalTimeZone === undefined) delete process.env.TZ; else process.env.TZ = originalTimeZone; });

test('source date control separates its visible date and calendar value for supported text inputs', () => {
  for (const value of ['31/12/2026','31/12/2026, 23:30','31 December 2026','2026-12-31']) {
    assert.deepEqual(parseVisibleDate(value),{display:'31/12/2026',iso:'2026-12-31'});
  }
  assert.deepEqual(parseVisibleDate('29/02/2024'),{display:'29/02/2024',iso:'2024-02-29'});
  assert.deepEqual(parseVisibleDate(''),{display:'',iso:''});
  assert.equal(parseVisibleDate('not a date'),null);
  // The source control's native-Date fallback rolls this ISO date forward. Captured validation remains separate.
  assert.deepEqual(parseVisibleDate('2026-02-31'),{display:'03/03/2026',iso:'2026-03-03'});
});

test('source date typing strips non-digits, inserts separators progressively and stops after eight digits', () => {
  assert.equal(formatDateInput('3'),'3'); assert.equal(formatDateInput('311'),'31/1');
  assert.equal(formatDateInput('31 / 12 / 2026 extra 987'),'31/12/2026');
  assert.equal(formatDateInput('letters'),'');
});
