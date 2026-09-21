import test from 'node:test';
import assert from 'node:assert/strict';
import { cloneLayout } from '../../src/templates/layout.js';
import { assembleDefinition } from '../../src/templates/model.js';

const id = (n) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const SECTION = id(1); const ROW = id(2); const LEFT = id(3); const RIGHT = id(4);
const FIRST = id(5); const SECOND = id(6); const EXPRESSION = id(7); const VERSION = id(8);
const TOTAL_COLUMN = 'dddddddd-0000-4000-8000-000000000001';
const TOTAL = 'dddddddd-0000-4000-8000-000000000002';

// Two data fields, and a formula field of its own when a calculation is under
// test, because a formula may not reference the field it belongs to.
function fixture({ aliases = ['assay', 'purity'], expressions = [] } = {}) {
  const records = {
    version: { id: VERSION, status: 'draft', kind: 'datasheet', semantics: 'hyperformula-v1' },
    sections: [{ id: SECTION, parentColumnId: null, position: 0, name: 'Results' }],
    rows: [{ id: ROW, sectionId: SECTION, position: 0 }],
    columns: [{ id: LEFT, rowId: ROW, position: 0, span: 4 }, { id: RIGHT, rowId: ROW, position: 1, span: 4 }],
    fields: [
      { id: FIRST, columnId: LEFT, repeatGroupId: null, widget: 'number_widget', valueType: 'numeric', alias: aliases[0], label: 'Assay', options: [] },
      { id: SECOND, columnId: RIGHT, repeatGroupId: null, widget: 'number_widget', valueType: 'numeric', alias: aliases[1], label: 'Purity', options: [] },
    ],
    groups: [], options: [], expressions,
  };
  if (expressions.length) {
    records.columns.push({ id: TOTAL_COLUMN, rowId: ROW, position: 2, span: 4 });
    records.fields.push({ id: TOTAL, columnId: TOTAL_COLUMN, repeatGroupId: null, widget: 'formula_widget',
      valueType: 'numeric', alias: 'total', label: 'Total', options: [] });
  }
  return records;
}

const cloneRow = (records) => {
  let counter = 0;
  return cloneLayout(records, assembleDefinition(records), 'row', ROW, () => `aaaaaaaa-0000-4000-8000-${String(counter += 1).padStart(12, '0')}`);
};

test('a copied row does not reuse the keys of the row it came from', () => {
  const records = fixture();
  const { records: copy } = cloneRow(records);
  assert.deepEqual(copy.fields.map((field) => field.alias), ['assay_2', 'purity_2']);
  const every = [...records.fields, ...copy.fields].map((field) => field.alias);
  assert.equal(new Set(every).size, every.length, 'keys are unique across the version');
});

test('copied identifiers stay renewed, and record identities are renewed with them', () => {
  const records = fixture();
  const { records: copy } = cloneRow(records);
  for (const field of copy.fields) assert.ok(![FIRST, SECOND].includes(field.id));
  assert.ok(![LEFT, RIGHT].includes(copy.columns[0].id));
  assert.notEqual(copy.rows[0].id, ROW);
});

test('a key that already carries a suffix continues the sequence instead of stacking another', () => {
  const { records: copy } = cloneRow(fixture({ aliases: ['assay_2', 'purity'] }));
  assert.deepEqual(copy.fields.map((field) => field.alias), ['assay_3', 'purity_2']);
});

test('a taken suffix is skipped rather than collided with', () => {
  const records = fixture();
  // A field elsewhere in the version already holds the name the copy would want.
  records.sections.push({ id: id(9), parentColumnId: null, position: 1, name: 'Other' });
  records.rows.push({ id: 'bbbbbbbb-0000-4000-8000-000000000001', sectionId: id(9), position: 0 });
  records.columns.push({ id: 'bbbbbbbb-0000-4000-8000-000000000002', rowId: 'bbbbbbbb-0000-4000-8000-000000000001', position: 0, span: 12 });
  records.fields.push({ id: 'bbbbbbbb-0000-4000-8000-000000000003', columnId: 'bbbbbbbb-0000-4000-8000-000000000002',
    repeatGroupId: null, widget: 'number_widget', valueType: 'numeric', alias: 'assay_2', label: 'Taken', options: [] });
  const { records: copy } = cloneRow(records);
  assert.deepEqual(copy.fields.map((field) => field.alias), ['assay_3', 'purity_2']);
});

test('a field without a key is not given one', () => {
  const { records: copy } = cloneRow(fixture({ aliases: ['', 'purity'] }));
  assert.deepEqual(copy.fields.map((field) => field.alias), ['', 'purity_2']);
});

// A copied formula must calculate from the copies, so the renewed key has to
// reach the formula text and the reference beside it.
test('a formula inside the copy is rewritten onto the renewed keys', () => {
  const records = fixture({ expressions: [{ id: EXPRESSION, fieldId: TOTAL, purpose: 'calculate',
    formulaText: 'assay * 2', references: [{ alias: 'assay', fieldId: FIRST, scope: 'current' }] }] });
  const { records: copy } = cloneRow(records);
  assert.equal(copy.expressions[0].formulaText, 'assay_2 * 2');
  assert.equal(copy.expressions[0].references[0].alias, 'assay_2');
  assert.notEqual(copy.expressions[0].references[0].fieldId, FIRST, 'the reference points at the copy');
  assert.equal(records.expressions[0].formulaText, 'assay * 2', 'the original formula is untouched');
});

test('rewriting a key never matches it inside a longer identifier', () => {
  const records = fixture({ aliases: ['assay', 'assay_rate'], expressions: [{ id: EXPRESSION, fieldId: TOTAL, purpose: 'calculate',
    formulaText: 'assay + assay_rate', references: [{ alias: 'assay', fieldId: FIRST, scope: 'current' },
      { alias: 'assay_rate', fieldId: SECOND, scope: 'current' }] }] });
  const { records: copy } = cloneRow(records);
  assert.deepEqual(copy.fields.map((field) => field.alias), ['assay_2', 'assay_rate_2', 'total_2']);
  assert.equal(copy.expressions[0].formulaText, 'assay_2 + assay_rate_2');
});

// Renaming one key onto another's old name must not then rename it again.
test('a rename chain is applied once', () => {
  const records = fixture({ aliases: ['assay', 'assay_2'], expressions: [{ id: EXPRESSION, fieldId: TOTAL, purpose: 'calculate',
    formulaText: 'assay + assay_2', references: [{ alias: 'assay', fieldId: FIRST, scope: 'current' },
      { alias: 'assay_2', fieldId: SECOND, scope: 'current' }] }] });
  const { records: copy } = cloneRow(records);
  assert.deepEqual(copy.fields.map((field) => field.alias), ['assay_3', 'assay_4', 'total_2']);
  assert.equal(copy.expressions[0].formulaText, 'assay_3 + assay_4');
});

test('a formula reaching outside the copy still names the field it came from', () => {
  const outsideField = 'cccccccc-0000-4000-8000-000000000003';
  const records = fixture({ expressions: [{ id: EXPRESSION, fieldId: TOTAL, purpose: 'calculate',
    formulaText: 'assay * outside', references: [
      { alias: 'assay', fieldId: FIRST, scope: 'current' },
      { alias: 'outside', fieldId: outsideField, scope: 'current' }] }] });
  // A field in another container, which the copy must keep pointing at.
  records.sections.push({ id: id(9), parentColumnId: null, position: 1, name: 'Elsewhere' });
  records.rows.push({ id: 'cccccccc-0000-4000-8000-000000000001', sectionId: id(9), position: 0 });
  records.columns.push({ id: 'cccccccc-0000-4000-8000-000000000002', rowId: 'cccccccc-0000-4000-8000-000000000001', position: 0, span: 12 });
  records.fields.push({ id: outsideField, columnId: 'cccccccc-0000-4000-8000-000000000002',
    repeatGroupId: null, widget: 'number_widget', valueType: 'numeric', alias: 'outside', label: 'Outside', options: [] });
  const { records: copy } = cloneRow(records);
  assert.equal(copy.expressions[0].formulaText, 'assay_2 * outside');
  const outside = copy.expressions[0].references.find((reference) => reference.alias === 'outside');
  assert.equal(outside.fieldId, outsideField, 'an outside reference is left pointing where it did');
});
