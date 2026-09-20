import { compareOccurrencePosition } from './calculations.js';
import { TemplateError } from './model.js';

export function initialOccurrences(model, { rootId, newId, revision, subjects = [] }) {
  const occurrences = [{ id: rootId, groupId: null, parentId: null, position: 0, createdRevision: revision }];
  const bindings = []; const subjectByOccurrence = new Map(); const groupsByParent = new Map();
  if (new Set(subjects.map((subject) => subject.testRequestId)).size !== subjects.length) {
    throw new TemplateError('duplicate_parameter_subject', 'Each parameter subject must identify a distinct test request.');
  }
  for (const group of Object.values(model.groupsById)) {
    const parent = group.parentGroupId ?? null;
    if (!groupsByParent.has(parent)) groupsByParent.set(parent, []);
    groupsByParent.get(parent).push(group);
  }
  for (let index = 0; index < occurrences.length; index += 1) {
    const parent = occurrences[index]; const inheritedSubject = subjectByOccurrence.get(parent.id);
    for (const group of groupsByParent.get(parent.groupId) ?? []) {
      const sourced = group.source === 'test_requests';
      const items = sourced ? (inheritedSubject ? [inheritedSubject] : subjects) : Array.from({ length: group.minimum }, () => inheritedSubject);
      if (sourced && !items.length) throw new TemplateError('parameter_context_required', 'This parameter loop requires a test request or job.');
      if (items.length > group.maximum) throw new TemplateError('repeat_limit', 'The parameter count exceeds the template repeat limit.');
      for (const [position, subject] of items.entries()) {
        if (occurrences.length >= 5000) throw new TemplateError('repeat_limit', 'Initial repeats exceed 5,000 occurrences.');
        const occurrence = { id: newId(), groupId: group.id, parentId: parent.id, position, createdRevision: revision };
        occurrences.push(occurrence);
        if (subject) subjectByOccurrence.set(occurrence.id, subject);
        if (sourced) bindings.push({ occurrenceId: occurrence.id, testRequestId: subject.testRequestId, specificationId: subject.specificationId });
      }
    }
  }
  return { occurrences, bindings };
}

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
  const subjects = new Map();
  for (const occurrence of occurrences) {
    let ancestor = occurrence;
    while (ancestor && !ancestor.subject) ancestor = byId.get(ancestor.parentId);
    if (ancestor?.subject) subjects.set(occurrence.id, ancestor.subject);
  }
  return { root, byId, forGroup: (parentId, groupId) => children.get(`${parentId}:${groupId}`) ?? [], subjectFor: (occurrenceId) => subjects.get(occurrenceId) };
}
