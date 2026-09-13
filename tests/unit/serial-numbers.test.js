import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleDefinition } from '../../src/templates/model.js';
import { indexOccurrences } from '../../src/templates/occurrences.js';
import { createSerialNumberIndex } from '../../src/templates/serial-number.js';

function definition({ source, rowRepeat = false, nested = false, report = false } = {}) {
  const section = { id: 'section', position: 0, parentColumnId: null, isParameterLoop: source === 'test_requests' || report };
  const groups = [];
  if (source) groups.push({ id: 'sections', sectionId: section.id, parentGroupId: null, source });
  if (rowRepeat) groups.push({ id: 'rows', rowId: 'first', parentGroupId: source ? 'sections' : null, source: 'manual' });
  const rows = [
    { id: 'second', sectionId: section.id, position: 3 },
    { id: 'heading', sectionId: section.id, position: 0 },
    { id: 'first', sectionId: section.id, position: 1 },
    { id: 'text', sectionId: section.id, position: 2 },
  ];
  const columns = rows.map((row) => ({ id: `col-${row.id}`, rowId: row.id, position: 0 }));
  const fields = rows.map((row) => ({ id: `field-${row.id}`, columnId: `col-${row.id}`, valueType: 'text',
    widget: ['first', 'second'].includes(row.id) ? 'sno_widget' : 'text_widget',
    repeatGroupId: row.id === 'first' && rowRepeat ? 'rows' : source ? 'sections' : null }));
  // Two serial widgets in one row still consume just one number.
  columns.push({ id: 'duplicate', rowId: 'first', position: 1 });
  fields.push({ ...fields.find((field) => field.id === 'field-first'), id: 'field-duplicate', columnId: 'duplicate' });
  const sections = [section, { id: 'empty', position: 1, parentColumnId: null }];
  if (nested) {
    columns.push({ id: 'parent', rowId: 'second', position: 1 });
    sections.push({ id: 'nested', position: 0, parentColumnId: 'parent' });
    for (let index = 0; index < 2; index += 1) {
      const id = `nested-${index}`;
      rows.push({ id, sectionId: 'nested', position: index });
      columns.push({ id: `col-${id}`, rowId: id, position: 0 });
      fields.push({ id: `field-${id}`, columnId: `col-${id}`, widget: 'sno_widget', valueType: 'text', repeatGroupId: source ? 'sections' : null });
    }
  }
  return assembleDefinition({ version: { kind: report ? 'report' : 'datasheet' }, sections, rows, columns, fields,
    options: [], expressions: [], groups });
}

const root = { id: 'root', groupId: null, parentId: null, position: 0 };
const occurrence = (id, groupId, parentId, position) => ({ id, groupId, parentId, position });
const numbers = (frame, rowId) => [...frame.get(rowId).entries()];

test('definition order counts each eligible row once, skipping headings and ordinary text', () => {
  const model = definition(); const before = JSON.stringify(model);
  const index = createSerialNumberIndex(model);
  assert.deepEqual(numbers(index.forSection('section'), 'first'), [[undefined, 1]]);
  assert.deepEqual(numbers(index.forSection('section'), 'second'), [[undefined, 2]]);
  assert.equal(index.forSection('section').has('heading'), false);
  assert.equal(index.forSection('empty').size, 0);
  assert.equal(index.forSection('unknown').size, 0);
  assert.equal(JSON.stringify(model), before);
});

test('manual row clones follow exact fractional order and advance later static rows', () => {
  const model = definition({ rowRepeat: true });
  const runtime = indexOccurrences(model, [root,
    occurrence('later', 'rows', 'root', '0.10000000000000002'),
    occurrence('earlier', 'rows', 'root', '0.10000000000000001')]);
  const frame = createSerialNumberIndex(model, runtime).forSection('section', 'root');
  assert.deepEqual(numbers(frame, 'first'), [['earlier', 1], ['later', 2]]);
  assert.deepEqual(numbers(frame, 'second'), [['root', 3]]);
  const removed = indexOccurrences(model, [root, runtime.byId.get('later')]);
  const after = createSerialNumberIndex(model, removed).forSection('section', 'root');
  assert.deepEqual(numbers(after, 'first'), [['later', 1]]);
  assert.deepEqual(numbers(after, 'second'), [['root', 2]]);
  assert.deepEqual(numbers(frame, 'second'), [['root', 3]], 'historical index remains unchanged');
});

for (const source of ['manual', 'test_requests']) test(`${source} section instances ${source === 'manual' ? 'reset' : 'share'} the serial sequence`, () => {
  const model = definition({ source, rowRepeat: true });
  const runtime = indexOccurrences(model, [root,
    occurrence('section-a', 'sections', 'root', 0), occurrence('section-b', 'sections', 'root', 1),
    occurrence('a1', 'rows', 'section-a', 0), occurrence('a2', 'rows', 'section-a', 1),
    occurrence('b1', 'rows', 'section-b', 0), occurrence('b2', 'rows', 'section-b', 1)]);
  let lookups = 0;
  const index = createSerialNumberIndex(model, { ...runtime, forGroup(...args) { lookups += 1; return runtime.forGroup(...args); } });
  const frame = index.forSection('section', 'root');
  assert.deepEqual(numbers(frame, 'first'), [['a1', 1], ['a2', 2], ['b1', source === 'manual' ? 1 : 4], ['b2', source === 'manual' ? 2 : 5]]);
  assert.deepEqual(numbers(frame, 'second'), [['section-a', 3], ['section-b', source === 'manual' ? 3 : 6]]);
  const firstLookups = lookups;
  for (let count = 0; count < 1000; count += 1) assert.equal(index.forSection('section', 'root'), frame);
  assert.equal(lookups, firstLookups, 'rendering frozen roots reuses one frame without rescanning their siblings');
});

test('nested designer and datasheet sections use their containing parent row subset', () => {
  const model = definition({ nested: true });
  for (const runtime of [undefined, indexOccurrences(model, [root])]) {
    const parentId = runtime?.root.id;
    const frame = createSerialNumberIndex(model, runtime).forSection('nested', parentId);
    assert.deepEqual(numbers(frame, 'nested-0'), [[parentId, 1]]);
    assert.deepEqual(numbers(frame, 'nested-1'), [[parentId, 1]]);
  }
});

test('direct COA nested sections use their own rows only when the report selection is nonempty', () => {
  const model = definition({ nested: true });
  for (const results of [[], [{ id: 'selected' }]]) {
    const frame = createSerialNumberIndex(model, undefined, { results }).forSection('nested');
    assert.deepEqual(numbers(frame, 'nested-0'), [[undefined, 1]]);
    assert.deepEqual(numbers(frame, 'nested-1'), [[undefined, results.length ? 2 : 1]]);
  }
  const frozen = createSerialNumberIndex(model, indexOccurrences(model, [root]), { results: [{ id: 'selected' }] }).forSection('nested', 'root');
  assert.deepEqual(numbers(frozen, 'nested-1'), [['root', 1]], 'frozen submissions retain datasheet numbering');
});

test('report row numbers span selected parameter rows while each cloned nested section starts anew', () => {
  const model = definition({ nested: true, report: true });
  const parameters = [{ id: 'b', serialNumber: 99 }, { id: 'a', serialNumber: 0 }];
  const index = createSerialNumberIndex(model, undefined, { results: parameters });
  const frame = index.forSection('section');
  assert.deepEqual(numbers(frame, 'first'), [['b', 1], ['a', 3]]);
  assert.deepEqual(numbers(frame, 'second'), [['b', 2], ['a', 4]]);
  for (const parameter of parameters) {
    const nested = index.forSection('nested', parameter.id, parameter);
    assert.deepEqual(numbers(nested, 'nested-1'), [[parameter.id, 2]]);
  }
  const filtered = createSerialNumberIndex(model, undefined, { results: parameters.slice(1) });
  assert.deepEqual(numbers(filtered.forSection('section'), 'second'), [['a', 2]]);
  const empty = createSerialNumberIndex(model, undefined, { results: [] });
  assert.equal(empty.forSection('section').get('first').size, 0);
});

test('an absent optional repeat contributes no number before the next static row', () => {
  const model = definition({ rowRepeat: true });
  const frame = createSerialNumberIndex(model, indexOccurrences(model, [root])).forSection('section', 'root');
  assert.deepEqual(numbers(frame, 'first'), []);
  assert.deepEqual(numbers(frame, 'second'), [['root', 1]]);
});
