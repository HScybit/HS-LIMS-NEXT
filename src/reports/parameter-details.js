import { loadParameterDetails } from '../datasheets/parameter-details.js';
import { parameterDetailPayload } from '../templates/parameter-detail.js';

export function reportParameterDetailFallback(results) {
  if (!results.length || results.some((row) => !row.parameterId || !row.parameterRevision)) return null;
  const versions = new Set(results.map((row) => `${row.parameterId}:${row.parameterRevision}`));
  return versions.size === 1 ? results[0] : null;
}

// A submitted datasheet already owns its cached Detail values. Only the report
// definition needs a parameter lookup, using actual loop ancestry or the
// selected child report's own parameter membership.
export function reportParameterDetailRequests(model, results, fallback, requests = new Map()) {
  function visit(sectionId, parameter) {
    const section = model.sectionsById[sectionId];
    if (section.visible === false) return;
    const selected = section.isParameterLoop && !parameter ? results : [parameter];
    for (const result of selected) for (const rowId of section.rowIds) for (const columnId of model.rowsById[rowId].columnIds) {
      const column = model.columnsById[columnId]; const field = model.fieldsById[column.fieldId];
      const subject = result ?? fallback;
      if (field?.widget === 'parameter_detail_widget' && field.label && subject) {
        if (!requests.has(subject.testRequestId)) requests.set(subject.testRequestId, new Set());
        requests.get(subject.testRequestId).add(field.label);
      }
      for (const childId of column.childSectionIds) visit(childId, result);
    }
  }
  for (const id of model.rootSectionIds) visit(id, null);
  return requests;
}

export async function reportParameterDetails(client, identity, results, requests, { rows } = {}) {
  const loaded = await loadParameterDetails(client, identity, new Map(results.map((row) => [row.testRequestId, row])), requests, { rows, silent: true });
  for (const result of results) {
    const values = loaded.get(result.testRequestId);
    // Different columns can have Titles that normalize to the same key but
    // ask different RPC questions. Keep each configured Title's projection.
    if (values) result.parameterDetailValues = Object.fromEntries([...values].map(([title, value]) => [title, parameterDetailPayload(value)]));
  }
}
