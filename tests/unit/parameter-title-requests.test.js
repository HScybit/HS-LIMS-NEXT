import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleDefinition } from '../../src/templates/model.js';
import { parameterTitleRequests } from '../../src/templates/parameter-title-requests.js';

function definition({ report = false } = {}) {
  const records = { version: { kind: report ? 'report' : 'datasheet' },
    sections: [{ id: 'loop', position: 0, isParameterLoop: true }, { id: 'nested', position: 0, parentColumnId: 'container' },
      { id: 'literal', position: 1 }, { id: 'hidden', position: 2, visible: false }],
    rows: [{ id: 'loop-row', sectionId: 'loop', position: 0 }, { id: 'nested-row', sectionId: 'nested', position: 0 },
      { id: 'literal-row', sectionId: 'literal', position: 0 }, { id: 'hidden-row', sectionId: 'hidden', position: 0 }],
    columns: [{ id: 'text-col', rowId: 'loop-row', position: 0 }, { id: 'vertical-col', rowId: 'loop-row', position: 1 },
      { id: 'container', rowId: 'loop-row', position: 2 }, { id: 'nested-col', rowId: 'nested-row', position: 0 },
      { id: 'literal-col', rowId: 'literal-row', position: 0 }, { id: 'hidden-col', rowId: 'hidden-row', position: 0 }],
    fields: [
      { id: 'text', columnId: 'text-col', widget: 'text_widget', label: 'project_field_data.zero', editable: true, repeatGroupId: report ? null : 'parameters' },
      { id: 'vertical', columnId: 'vertical-col', widget: 'vertical_text_widget', label: 'prefix.flag', repeatGroupId: report ? null : 'parameters' },
      { id: 'nested-text', columnId: 'nested-col', widget: 'text_widget', label: 'prefix.nested', repeatGroupId: report ? null : 'manual' },
      { id: 'literal-text', columnId: 'literal-col', widget: 'text_widget', label: 'project_field_data' },
      { id: 'hidden-text', columnId: 'hidden-col', widget: 'text_widget', label: 'prefix.hidden' },
    ], options: [], expressions: [], groups: report ? [] : [
      { id: 'parameters', sectionId: 'loop', parentGroupId: null, source: 'test_requests' },
      { id: 'manual', rowId: 'nested-row', parentGroupId: 'parameters', source: 'manual' },
    ] };
  return assembleDefinition(records);
}
const capture = () => ({ occurrences: [
  { id: 'root', groupId: null, parentId: null, position: 0 },
  { id: 'first', groupId: 'parameters', parentId: 'root', position: 0, subject: { testRequestId: 'one' } },
  { id: 'second', groupId: 'parameters', parentId: 'root', position: 1, subject: { testRequestId: 'two' } },
  { id: 'child', groupId: 'manual', parentId: 'first', position: 0 },
  { id: 'child-two', groupId: 'manual', parentId: 'second', position: 0 },
], values: [{ fieldId: 'text', occurrenceId: 'first', state: 'present', origin: 'entered', textValue: 'other.edited' },
  { fieldId: 'text', occurrenceId: 'second', state: 'present', origin: 'default', textValue: 'other.default' }] });
const results = [{ testRequestId: 'one' }, { testRequestId: 'two' }];

test('title selectors follow actual inherited subjects, entered values, visibility and literal unbound rows', () => {
  const selected = parameterTitleRequests(definition(), results, { capture: capture(), validation: { 'vertical:first': { visible: false } } });
  assert.deepEqual([...selected.get('one').keys], ['edited', 'nested']);
  assert.deepEqual([...selected.get('two').keys], ['zero', 'flag', 'nested']);
  assert.equal(selected.get('one').all, false); assert.equal(selected.size, 2);
  const unbound = capture(); unbound.occurrences.forEach((row) => { delete row.subject; });
  assert.equal(parameterTitleRequests(definition(), results, { capture: unbound }).size, 0);
  assert.deepEqual([...parameterTitleRequests(definition(), [results[0]], { capture: capture() }).keys()], ['one']);
});

test('report titles inherit only actual parameter loops and nested loops do not multiply the same context', () => {
  const model = definition({ report: true }); model.sectionsById.nested.isParameterLoop = true;
  model.fieldsById.text.label = 'project_field_data';
  const selected = parameterTitleRequests(model, results);
  for (const result of results) {
    const request = selected.get(result.testRequestId);
    assert.equal(request.all, true); assert.equal(request.titles.get('project_field_data'), 1);
    assert.deepEqual([...request.keys], ['flag', 'nested']);
  }
});

test('only expanded frozen final sections and their selected result subject request custom-field titles', () => {
  const model = definition({ report: true });
  for (const field of Object.values(model.fieldsById)) field.label = 'name';
  model.fieldsById.text.widget = 'tr_result_widget';
  const frozen = definition();
  const saved = { ...capture(), versionId: 'frozen', sectionRoots: [{ sectionId: 'loop', parentOccurrenceId: 'root', occurrenceId: 'first' }] };
  const reportResults = [{ ...results[0], source: 'section', instanceId: 'capture' }, { ...results[1], source: 'numeric' }];
  const options = { finalCaptures: { capture: saved }, datasheetModels: { frozen } };
  const selected = parameterTitleRequests(model, reportResults, options);
  assert.deepEqual([...selected.keys()], ['one']);
  assert.deepEqual([...selected.get('one').keys], ['edited', 'flag', 'nested']);
  assert.equal(selected.get('one').all, false);
  model.sectionsById.loop.visible = false;
  assert.equal(parameterTitleRequests(model, reportResults, options).size, 0);
});
