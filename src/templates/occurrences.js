import { compareOccurrencePosition } from './calculations.js';
import { TemplateError } from './model.js';

// Build once per capture revision. Rendering nested sections/rows only looks up their
// direct occurrences; it never scans the entire capture for each field.
export function indexOccurrences(model, occurrences) {
  const invalid = () => { throw new TemplateError('repeat_structure', 'Capture repeat structure is invalid.'); };
  if (!Array.isArray(occurrences) || !occurrences.length || occurrences.length > 5000) invalid();
  const byId = new Map();
  const children = new Map();
  let root;
  for (const occurrence of occurrences) {
    if (!occurrence.id || byId.has(occurrence.id) || !/^\d+(?:\.\d+)?$/.test(String(occurrence.position))) invalid();
    byId.set(occurrence.id, occurrence);
    if (occurrence.groupId == null) {
      if (root || occurrence.parentId != null) invalid();
      root = occurrence;
    } else {
      const key = `${occurrence.parentId}:${occurrence.groupId}`;
      if (!children.has(key)) children.set(key, []);
      children.get(key).push(occurrence);
    }
  }
  if (!root) invalid();
  for (const occurrence of occurrences) {
    if (occurrence === root) continue;
    const group = model.groupsById[occurrence.groupId];
    const parent = byId.get(occurrence.parentId);
    if (!group || !parent || (parent.groupId ?? null) !== (group.parentGroupId ?? null)) invalid();
    const visited = new Set([occurrence.id]);
    let ancestor = parent;
    while (ancestor) {
      if (visited.has(ancestor.id)) invalid();
      visited.add(ancestor.id);
      ancestor = byId.get(ancestor.parentId);
    }
  }
  for (const siblings of children.values()) siblings.sort(compareOccurrencePosition);
  return { root, byId, forGroup: (parentId, groupId) => children.get(`${parentId}:${groupId}`) ?? [] };
}
