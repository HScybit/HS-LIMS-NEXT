import { indexOccurrences } from './occurrences.js';
import { valueKey } from './calculations.js';
import { textWidgetTitle } from './text.js';

// Follow the same visible layout and parameter bindings as TemplateCanvas.
// Ordinary titles and unrendered final sections must not request master data.
export function parameterTitleRequests(model, results, { capture, validation = {}, finalCaptures = {}, datasheetModels = {} } = {}, requests = new Map()) {
  const captures = new Map();
  function runtimeFor(definition, saved) {
    if (!captures.has(saved)) captures.set(saved, { runtime: indexOccurrences(definition, saved.occurrences),
      values: new Map(saved.values.map((value) => [valueKey(value.fieldId, value.occurrenceId), value])) });
    return captures.get(saved);
  }
  function request(testRequestId, title) {
    if (!testRequestId || typeof title !== 'string' || (title !== 'project_field_data' && !title.includes('.'))) return;
    if (!requests.has(testRequestId)) requests.set(testRequestId, { all: false, keys: new Set(), titles: new Map() });
    const selected = requests.get(testRequestId);
    if (title === 'project_field_data') selected.all = true;
    else selected.keys.add(title.split('.').at(-1));
    selected.titles.set(title, (selected.titles.get(title) ?? 0) + 1);
  }
  function visit(definition, sectionId, parentId, parameter, state, allowed, checks, onlyOccurrenceId) {
    const section = definition.sectionsById[sectionId];
    if (section.visible === false) return;
    const { runtime, values } = state ?? {};
    const instances = runtime && section.ownRepeatGroupId ? runtime.forGroup(parentId, section.ownRepeatGroupId) : [{ id: parentId }];
    for (const instance of instances) {
      if (onlyOccurrenceId && instance.id !== onlyOccurrenceId) continue;
      const parameters = !runtime && section.isParameterLoop && !parameter ? results : [parameter];
      for (const selected of parameters) for (const rowId of section.rowIds) {
        const row = definition.rowsById[rowId];
        const rows = runtime && row.ownRepeatGroupId ? runtime.forGroup(instance.id, row.ownRepeatGroupId) : [instance];
        for (const occurrence of rows) for (const columnId of row.columnIds) {
          const column = definition.columnsById[columnId]; const field = definition.fieldsById[column.fieldId];
          const key = field && valueKey(field.id, occurrence.id);
          if (checks[key]?.visible === false) continue;
          const subject = runtime?.subjectFor(occurrence.id);
          const requestId = runtime ? (allowed.has(subject?.testRequestId) ? subject.testRequestId : null) : selected?.testRequestId;
          if (field?.widget === 'text_widget') request(requestId, textWidgetTitle(field, values?.get(key), null));
          if (field?.widget === 'vertical_text_widget') request(requestId, field.label);
          if (!runtime && field?.widget === 'tr_result_widget') for (const result of selected ? [selected] : results) {
            const saved = finalCaptures[result.instanceId];
            if (result.source !== 'section' || !saved) continue;
            const frozen = datasheetModels[saved.versionId]; const captured = runtimeFor(frozen, saved);
            const selectedRequests = new Set([result.testRequestId]);
            for (const root of saved.sectionRoots) visit(frozen, root.sectionId, root.parentOccurrenceId, null, captured, selectedRequests, {}, root.occurrenceId);
          }
          for (const childId of column.childSectionIds) visit(definition, childId, occurrence.id, selected, state, allowed, checks);
        }
      }
    }
  }
  const state = capture ? runtimeFor(model, capture) : null;
  const allowed = new Set(results.map((result) => result.testRequestId));
  for (const id of model.rootSectionIds) visit(model, id, state?.runtime.root.id, null, state, allowed, validation);
  return requests;
}
