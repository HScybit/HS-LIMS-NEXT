import { HttpError } from '../auth/errors.js';
import { indexOccurrences } from '../templates/occurrences.js';
import { MAX_CAPTURE_CELLS, MAX_CAPTURE_LAYOUT_NODES } from '../templates/runtime-limits.js';

// Bound the expanded document, including every repeated final-result section,
// before React allocates it. Repeated report widgets count their content again.
export function assertReportSize(model, results, finalCaptures = {}, datasheetModels = {}) {
  let cells = 0; let layoutNodes = 0;
  function add(nextCells, nextNodes) {
    cells += nextCells; layoutNodes += nextNodes;
    if (cells > MAX_CAPTURE_CELLS || layoutNodes > MAX_CAPTURE_LAYOUT_NODES) throw new HttpError(422, 'report_size_limit', 'This report exceeds the supported document size. Select fewer parameters or reduce the template.');
  }
  function visitSection(definition, sectionId, parentId, runtime, parameter, onlyOccurrenceId) {
    const section = definition.sectionsById[sectionId];
    if (section.visible === false) return;
    const occurrences = runtime && section.ownRepeatGroupId ? runtime.forGroup(parentId, section.ownRepeatGroupId) : [{ id: parentId }];
    for (const occurrence of occurrences) {
      if (onlyOccurrenceId && occurrence.id !== onlyOccurrenceId) continue;
      add(0, 1);
      const parameters = !runtime && section.isParameterLoop && !parameter ? results : [parameter];
      for (const selected of parameters) for (const rowId of section.rowIds) {
        const row = definition.rowsById[rowId];
        const rowOccurrences = runtime && row.ownRepeatGroupId ? runtime.forGroup(occurrence.id, row.ownRepeatGroupId) : [occurrence];
        for (const rowOccurrence of rowOccurrences) {
          add(0, 1 + row.columnIds.length);
          for (const columnId of row.columnIds) {
            const column = definition.columnsById[columnId];
            const field = definition.fieldsById[column.fieldId];
            if (field) add(1, 0);
            if (!runtime && field?.widget === 'tr_result_widget') {
              for (const result of selected ? [selected] : results) {
                const capture = finalCaptures[result.instanceId];
                if (result.source !== 'section' || !capture) continue;
                const capturedModel = datasheetModels[capture.versionId];
                const capturedRuntime = indexOccurrences(capturedModel, capture.occurrences);
                for (const root of capture.sectionRoots) visitSection(capturedModel, root.sectionId, root.parentOccurrenceId, capturedRuntime, null, root.occurrenceId);
              }
            }
            for (const child of column.childSectionIds) visitSection(definition, child, rowOccurrence.id, runtime, selected);
          }
        }
      }
    }
  }
  for (const sectionId of model.rootSectionIds) visitSection(model, sectionId, null, null, null);
  return { cells, layoutNodes };
}
