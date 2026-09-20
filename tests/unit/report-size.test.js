import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleDefinition } from '../../src/templates/model.js';
import { assertReportSize } from '../../src/reports/render-model.js';
import { reportRecords } from '../helpers/reports.js';
import { analyticalRecords } from '../helpers/templates.js';
import { finalResultSectionRoots } from '../../src/datasheets/final-result.js';

test('report bounds account for repeated parameter rows, nested final sections and empty selections', () => {
  const model = assembleDefinition({ ...reportRecords(), version: { kind: 'report' } });
  const empty = assertReportSize(model, []);
  const one = assertReportSize(model, [{ id: 'one', source: 'column' }]);
  const two = assertReportSize(model, [{ id: 'one', source: 'column' }, { id: 'two', source: 'column' }]);
  assert.equal(two.cells - one.cells, one.cells - empty.cells);
  assert.ok(one.cells > empty.cells);
  const records = analyticalRecords({ rowCount: 1 }); records.sections[0].isFinalResult = true;
  const capturedModel = assembleDefinition({ ...records, version: { id: 'datasheet' } });
  const occurrences = [{ id: 'root', groupId: null, parentId: null, position: 0 },
    ...[1, 2, 3].map((index) => ({ id: `repeat-${index}`, groupId: records.groups[0].id, parentId: 'root', position: index }))];
  const roots = finalResultSectionRoots(capturedModel, occurrences);
  const captures = { captured: { versionId: 'datasheet', occurrences, sectionRoots: roots } };
  const sections = assertReportSize(model, [{ id: 'one', source: 'section', instanceId: 'captured' }], captures, { datasheet: capturedModel });
  assert.equal(sections.cells - one.cells, 6);
  const removed = occurrences.filter((occurrence) => occurrence.id !== 'repeat-2');
  const after = assertReportSize(model, [{ id: 'one', source: 'section', instanceId: 'captured' }], { captured: { ...captures.captured, occurrences: removed } }, { datasheet: capturedModel });
  assert.equal(sections.cells - after.cells, 2);
  assert.throws(() => assertReportSize(model, Array.from({ length: 10_000 }, (_, id) => ({ id, source: 'section', instanceId: 'captured' })), captures, { datasheet: capturedModel }), { code: 'report_size_limit' });
});
