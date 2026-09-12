import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { emptyUncertaintyGrid, normalizeUncertaintyGrid, uncertaintySpreadsheet, updateUncertaintyGrid } from '../../src/masters/parameter-grid.js';

test('uncertainty preserves unconfigured, blank, zero, whitespace and authored formulas without evaluating metadata', () => {
  assert.equal(normalizeUncertaintyGrid(null), null); assert.equal(normalizeUncertaintyGrid(undefined), null);
  const grid = emptyUncertaintyGrid();
  assert.deepEqual(uncertaintySpreadsheet(normalizeUncertaintyGrid(grid)), { headers: ['Sr. no.', 'Text'], data: [['1', '']] });
  for (const value of ['0', '000.00', '  expanded uncertainty  ', '=SUM(A1:A5)', 'NA', '']) {
    const changed = updateUncertaintyGrid(grid, { headers: ['Sr. no.', 'Text'], data: [['999', value]] });
    assert.equal(changed.rows[0].id, grid.rows[0].id);
    assert.deepEqual(uncertaintySpreadsheet(changed).data, [['1', value]], 'Serials are derived; cell text stays exact.');
  }
  assert.equal(grid.rows[0].values[0], '', 'The adapter must not mutate earlier drafts.');
});

test('header edits and trailing row/column changes preserve surviving identities and cannot reuse removed identities', () => {
  const first = emptyUncertaintyGrid();
  const added = updateUncertaintyGrid(first, { headers: ['Sr. no.', 'Text', 'Notes'], data: [['1', '0', 'First'], ['2', '2.5', 'Second']] });
  assert.deepEqual(added.columns.slice(0, 2).map((column) => column.id), first.columns.map((column) => column.id));
  assert.equal(added.rows[0].id, first.rows[0].id);
  const renamed = updateUncertaintyGrid(added, { ...uncertaintySpreadsheet(added), headers: ['No.', 'Coverage', 'Notes'] });
  assert.deepEqual(renamed.columns.map((column) => column.id), added.columns.map((column) => column.id));
  const removed = updateUncertaintyGrid(renamed, { headers: ['No.', 'Coverage'], data: [['1', '0']] });
  const replaced = updateUncertaintyGrid(removed, { headers: ['No.', 'Coverage', 'New notes'], data: [['1', '0', ''], ['2', '', '']] });
  assert.notEqual(replaced.rows[1].id, added.rows[1].id); assert.notEqual(replaced.columns[2].id, added.columns[2].id);
});

test('grid validation rejects malformed identities, jagged rows, nested values and bounded text before persistence', () => {
  const grid = emptyUncertaintyGrid();
  const malformed = [false, [], {}, { ...grid, extra: true }, { ...grid, rows: [] }, { ...grid, columns: grid.columns.slice(0, 1) },
    { ...grid, columns: [grid.columns[0], grid.columns[0]] }, { ...grid, rows: [grid.rows[0], grid.rows[0]] },
    { ...grid, rows: [{ ...grid.rows[0], id: 'not-a-uuid' }] },
    ...[['extra', 'cell'], [{}], [null], ['\0'], ['x'.repeat(2001)]].map((values) => ({ ...grid, rows: [{ ...grid.rows[0], values }] })),
  ];
  for (const input of malformed) assert.throws(() => normalizeUncertaintyGrid(input));
  assert.throws(() => updateUncertaintyGrid(grid, { headers: ['Sr. no.', 'Text'], data: [['1']] }), { code: 'invalid_uncertainty' });
  assert.throws(() => updateUncertaintyGrid(grid, { headers: ['Sr. no.', 'Text'], data: [['1', {}]] }), { code: 'invalid_uncertainty' });
  const large = { columns: grid.columns, rows: Array.from({ length: 501 }, () => ({ id: randomUUID(), values: [''] })) };
  assert.throws(() => normalizeUncertaintyGrid(large), { code: 'invalid_uncertainty' });
  const multibyte = { columns: grid.columns, rows: Array.from({ length: 500 }, () => ({ id: randomUUID(), values: ['界'.repeat(1000)] })) };
  assert.throws(() => normalizeUncertaintyGrid(multibyte), { code: 'uncertainty_too_large' });
});
