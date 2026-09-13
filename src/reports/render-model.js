import { HttpError } from '../auth/errors.js';
import { indexOccurrences } from '../templates/occurrences.js';
import { MAX_CAPTURE_CELLS, MAX_CAPTURE_LAYOUT_NODES } from '../templates/runtime-limits.js';
import { parameterDetailBytes, parameterDetailValue } from '../templates/parameter-detail.js';
import { assertSampleLineCounts } from '../templates/sample-line.js';

// Bound the expanded document, including every repeated final-result section,
// before React allocates it. Repeated report widgets count their content again.
export function assertReportSize(model, results, finalCaptures = {}, datasheetModels = {}, { parameterDetailFallback, lineItem } = {}) {
  let cells = 0; let layoutNodes = 0;
  const imageCounts = {}; const capturedValues = new Map();
  const details = [];
  const lineItemCounts = {};
  function add(nextCells, nextNodes) {
    cells += nextCells; layoutNodes += nextNodes;
    if (cells > MAX_CAPTURE_CELLS || layoutNodes > MAX_CAPTURE_LAYOUT_NODES) throw new HttpError(422, 'report_size_limit', 'This report exceeds the supported document size. Select fewer parameters or reduce the template.');
  }
  function visitSection(definition, sectionId, parentId, runtime, parameter, onlyOccurrenceId, values) {
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
            if (field?.widget === 'sample_line_item_data_widget' && field.sourceField) lineItemCounts[field.sourceField] = (lineItemCounts[field.sourceField] ?? 0) + 1;
            if (field?.widget === 'parameter_detail_widget') {
              const value = runtime ? values?.get(`${field.id}:${rowOccurrence.id}`)
                : parameterDetailValue((selected ?? parameterDetailFallback)?.parameterDetailValues?.[field.label]);
              if (value) details.push(value);
            }
            if (field?.widget === 'template_image_widget') {
              const value = values?.get(`${field.id}:${rowOccurrence.id}`);
              const imageId = value?.state === 'present' && value.imageId ? value.imageId : field.defaultImageId;
              if (imageId) imageCounts[imageId] = (imageCounts[imageId] ?? 0) + 1;
            }
            if (!runtime && field?.widget === 'tr_result_widget') {
              for (const result of selected ? [selected] : results) {
                const capture = finalCaptures[result.instanceId];
                if (result.source !== 'section' || !capture) continue;
                const capturedModel = datasheetModels[capture.versionId];
                const capturedRuntime = indexOccurrences(capturedModel, capture.occurrences);
                if (!capturedValues.has(result.instanceId)) capturedValues.set(result.instanceId, new Map((capture.values ?? []).map((value) => [`${value.fieldId}:${value.occurrenceId}`, value])));
                for (const root of capture.sectionRoots) visitSection(capturedModel, root.sectionId, root.parentOccurrenceId, capturedRuntime, null, root.occurrenceId, capturedValues.get(result.instanceId));
              }
            }
            for (const child of column.childSectionIds) visitSection(definition, child, rowOccurrence.id, runtime, selected, undefined, values);
          }
        }
      }
    }
  }
  for (const sectionId of model.rootSectionIds) visitSection(model, sectionId, null, null, null);
  parameterDetailBytes(details);
  if (lineItem) assertSampleLineCounts(lineItemCounts, lineItem);
  return { cells, layoutNodes, ...(Object.keys(imageCounts).length ? { imageCounts } : {}), ...(Object.keys(lineItemCounts).length ? { lineItemCounts } : {}) };
}
