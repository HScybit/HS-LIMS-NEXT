const empty = new Map();

// Number source rows, not parameters or field values. A frame is cached so
// rendering each final-section root does not recount all parameter siblings.
export function createSerialNumberIndex(model, runtime, report) {
  const cache = new Map();
  const rowsBySection = new Map(Object.values(model.sectionsById).map((section) => [section.id,
    section.rowIds.map((id) => model.rowsById[id]).filter((row) => row.serialNumber > 0)]));
  const coaSelection = !runtime && Boolean(report?.results.length);

  return { forSection(sectionId, parentId, parameter) {
    const rows = rowsBySection.get(sectionId);
    if (!rows?.length) return empty;
    const key = `${sectionId}:${parentId ?? ''}:${parameter?.id ?? ''}`;
    if (cache.has(key)) return cache.get(key);
    const section = model.sectionsById[sectionId];
    const instances = runtime && section.ownRepeatGroupId ? runtime.forGroup(parentId, section.ownRepeatGroupId) : [{ id: parentId }];
    const parameters = !runtime && report && section.isParameterLoop && !parameter ? report.results : [parameter];
    const sharedSequence = runtime && model.groupsById[section.ownRepeatGroupId]?.source === 'test_requests';
    const parentRow = section.parentColumnId && !coaSelection;
    const numbers = new Map(rows.map((row) => [row.id, new Map()]));
    let serial = 0;
    for (const instance of instances) {
      if (!sharedSequence) serial = 0;
      for (const selected of parameters) for (const row of rows) {
        const parentOccurrenceId = selected?.id ?? instance.id;
        const occurrences = runtime && row.ownRepeatGroupId ? runtime.forGroup(parentOccurrenceId, row.ownRepeatGroupId) : [{ id: parentOccurrenceId }];
        for (const occurrence of occurrences) numbers.get(row.id).set(occurrence.id, parentRow ? 1 : ++serial);
      }
    }
    cache.set(key, numbers);
    return numbers;
  } };
}
