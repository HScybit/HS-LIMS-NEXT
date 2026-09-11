import { HttpError } from '../auth/errors.js';

export const MAX_CAPTURE_CELLS = 50_000;
export const MAX_CAPTURE_LAYOUT_NODES = 200_000;

// Count before allocating defaults, calculations or DOM nodes. Definition size
// and repeat count alone do not bound their product.
export function assertCaptureSize(model, occurrences) {
  const counts = new Map();
  for (const occurrence of occurrences) {
    const groupId = occurrence.groupId ?? null;
    counts.set(groupId, (counts.get(groupId) ?? 0) + 1);
  }
  const count = (groupId) => counts.get(groupId ?? null) ?? 0;
  let cells = 0;
  for (const field of Object.values(model.fieldsById)) cells += count(field.repeatGroupId);
  let layoutNodes = 0;
  for (const section of Object.values(model.sectionsById ?? {})) layoutNodes += count(section.repeatGroupId);
  for (const row of Object.values(model.rowsById ?? {})) layoutNodes += count(row.repeatGroupId) * (1 + row.columnIds.length);
  if (cells > MAX_CAPTURE_CELLS || layoutNodes > MAX_CAPTURE_LAYOUT_NODES) {
    throw new HttpError(422, 'capture_size_limit', 'This datasheet exceeds the supported repeated layout size. Reduce the template or repeat count.');
  }
  return { cells, layoutNodes };
}
