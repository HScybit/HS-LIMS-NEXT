import { evaluateExpression, ExpressionError } from './expressions.js';
import { formatValueWithDecimalPoints } from './formatting.js';
import { assertCaptureSize } from './runtime-limits.js';
import { parameterDetailKey, parameterDetailPayload } from './parameter-detail.js';

export const valueKey = (fieldId, occurrenceId) => `${fieldId}:${occurrenceId}`;

// Runtime insertion order is an exact nonnegative decimal, separate from field/occurrence identity.
export function compareOccurrencePosition(left, right) {
  const [leftWhole, leftFraction = ''] = String(left.position).split('.');
  const [rightWhole, rightFraction = ''] = String(right.position).split('.');
  if (leftWhole.length !== rightWhole.length) return leftWhole.length - rightWhole.length;
  if (leftWhole !== rightWhole) return leftWhole < rightWhole ? -1 : 1;
  const length = Math.max(leftFraction.length, rightFraction.length);
  const a = leftFraction.padEnd(length, '0'); const b = rightFraction.padEnd(length, '0');
  return a === b ? left.id.localeCompare(right.id) : a < b ? -1 : 1;
}

export function valuePayload(value) {
  if (!value || value.state !== 'present') return null;
  if (value.valueType === 'parameter_detail') return parameterDetailPayload(value);
  if (value.valueType === 'result') return value.numberValue ?? value.textValue;
  return ({ numeric: value.numberValue, text: value.textValue, boolean: value.booleanValue, date: value.dateValue, option: value.optionId, image: value.imageId })[value.valueType];
}

export function capturedInputValue(value) {
  const payload = valuePayload(value);
  return payload != null && value.numberValue != null ? value.lexical ?? payload : payload;
}

// Shared client/server evaluation; persisted calculations are always recomputed on the server.
export function calculateCapture(model, occurrences, savedValues) {
  if (occurrences.length > 5000) throw new ExpressionError('repeat_limit', 'Capture exceeds the supported repeat count.');
  assertCaptureSize(model, occurrences);
  const started = performance.now();
  const byId = new Map(occurrences.map((row) => [row.id, row]));
  const values = new Map(savedValues.filter((value) => byId.has(value.occurrenceId)).map((value) => [valueKey(value.fieldId, value.occurrenceId), value]));
  const byGroup = new Map();
  const children = new Map();
  for (const occurrence of occurrences) {
    const group = occurrence.groupId ?? null;
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group).push(occurrence);
    if (!children.has(occurrence.parentId)) children.set(occurrence.parentId, []);
    children.get(occurrence.parentId).push(occurrence);
  }
  for (const siblings of children.values()) siblings.sort(compareOccurrencePosition);
  for (const siblings of byGroup.values()) siblings.sort(compareOccurrencePosition);
  if (byGroup.get(null)?.length !== 1) throw new ExpressionError('repeat_structure', 'Capture needs exactly one root occurrence.');
  const descendantCache = new Map();
  function descendantOccurrences(parentId, groupId) {
    const key = `${parentId}:${groupId}`;
    if (descendantCache.has(key)) return descendantCache.get(key);
    const found = [];
    const queue = [...(children.get(parentId) ?? [])];
    const visited = new Set([parentId]);
    for (let index = 0; index < queue.length; index += 1) {
      const occurrence = queue[index];
      if (visited.has(occurrence.id)) throw new ExpressionError('repeat_structure', 'Repeat ancestry contains a cycle.');
      visited.add(occurrence.id);
      if (occurrence.groupId === groupId) found.push(occurrence);
      queue.push(...(children.get(occurrence.id) ?? []));
    }
    descendantCache.set(key, found);
    return found;
  }
  function payload(fieldId, occurrenceId) {
    const value = values.get(valueKey(fieldId, occurrenceId));
    if (value?.state === 'invalid') throw new ExpressionError('expression_dependency', 'A formula input contains an invalid result.');
    let result = valuePayload(value);
    const field = model.fieldsById[fieldId];
    if (field.widget === 'parameter_detail_widget' && field.alias !== parameterDetailKey(field.label)) return null;
    if (field.valueType === 'option' && result !== null) result = field.options.find((option) => option.id === result)?.value ?? null;
    // The source server normalizes numeric strings before passing variables to its parser.
    // Frozen option IDs identify storage; formulas consume the option's source value.
    if (typeof result === 'string' && result.trim() !== '' && !Number.isNaN(Number(result.trim()))) return Number(result.trim());
    return result;
  }
  function resolver(occurrence) {
    return (fieldId, scope) => {
      const field = model.fieldsById[fieldId];
      if (!field) throw new ExpressionError('expression_reference', 'A referenced field is missing.');
      if (scope === 'current') return payload(fieldId, occurrence.id);
      if (scope === 'descendants') {
        const found = descendantOccurrences(occurrence.id, field.repeatGroupId).map((child) => payload(fieldId, child.id))
          .filter((value) => value !== null && value !== undefined && value !== '');
        // Source variables with one present descendant are scalar, including zero/false.
        return found.length === 1 ? found[0] : found;
      }
      let ancestor = byId.get(occurrence.parentId);
      const visited = new Set();
      while (ancestor) {
        if (visited.has(ancestor.id)) throw new ExpressionError('repeat_structure', 'Repeat ancestry contains a cycle.');
        visited.add(ancestor.id);
        if ((ancestor.groupId ?? null) === (field.repeatGroupId ?? null)) return payload(fieldId, ancestor.id);
        ancestor = byId.get(ancestor.parentId);
      }
      throw new ExpressionError('expression_reference', 'The required ancestor occurrence is missing.');
    };
  }
  const calculated = [];
  for (const fieldId of model.calculationOrder) {
    const field = model.fieldsById[fieldId];
    const expression = model.expressions[`${fieldId}:calculate`];
    const onMissingValue = field.formulaOnMissingValue ?? 'error';
    const onError = field.formulaOnError ?? 'show_error';
    for (const occurrence of byGroup.get(field.repeatGroupId ?? null) ?? []) {
      const value = { fieldId, occurrenceId: occurrence.id, valueType: field.valueType, origin: 'calculated', state: 'present' };
      try {
        const result = evaluateExpression(expression.compiled, resolver(occurrence), { onMissingValue });
        if (typeof result !== 'number' || !Number.isFinite(result)) throw new ExpressionError('expression_result_type', 'A numeric formula did not return a finite number.');
        value.numberValue = String(result);
        value.lexical = String(result);
      } catch (error) {
        if (!(error instanceof ExpressionError)) throw error;
        if (error.code === 'expression_missing_blank' || onError === 'blank') { value.state = 'absent'; }
        else { value.state = 'invalid'; value.errorCode = error.code; value.errorMessage = error.message; }
      }
      values.set(valueKey(fieldId, occurrence.id), value);
      calculated.push(value);
    }
  }
  const validation = {};
  for (const field of Object.values(model.fieldsById)) {
    for (const occurrence of byGroup.get(field.repeatGroupId ?? null) ?? []) {
      const key = valueKey(field.id, occurrence.id);
      const value = values.get(key);
      const result = { visible: true, required: field.required, errors: [] };
      for (const purpose of ['visible', 'required']) {
        const expression = model.expressions[`${field.id}:${purpose}`];
        if (!expression) continue;
        try {
          const evaluated = evaluateExpression(expression.compiled, resolver(occurrence));
          if (typeof evaluated !== 'boolean' && (typeof evaluated !== 'number' || !Number.isFinite(evaluated))) throw new ExpressionError('condition_result_type', 'A condition must return a boolean or finite number.');
          result[purpose] = Boolean(evaluated);
        } catch (error) {
          if (!(error instanceof ExpressionError)) throw error;
          result[purpose] = null;
          result.errors.push({ code: error.code, message: error.message });
        }
      }
      if (value?.state === 'invalid') result.errors.push({ code: value.errorCode, message: value.errorMessage });
      if (!['product_detail_widget', 'tr_data_widget'].includes(field.widget) && result.required && (!value || ['absent', 'empty'].includes(value.state) || (value.state === 'present' && value.textValue === ''))) result.errors.push({ code: 'required', message: 'This field is required.' });
      if (value?.state === 'present' && value.numberValue != null && ['numeric', 'result'].includes(field.valueType)) {
        const numeric = Number(value.numberValue);
        if (field.numeric?.minimum != null && numeric < Number(field.numeric.minimum)) result.errors.push({ code: 'below_minimum', message: `Value must be at least ${field.numeric.minimum}.` });
        if (field.numeric?.maximum != null && numeric > Number(field.numeric.maximum)) result.errors.push({ code: 'above_maximum', message: `Value must not exceed ${field.numeric.maximum}.` });
      }
      validation[key] = result;
    }
  }
  return { calculated, values: [...values.values()], validation, durationMs: performance.now() - started };
}

// Server-side view enforcement (unlike PERN, which only enforces edit access server-side and
// leaves view access to the client to honor). Applied at the boundary where capture values are
// about to reach an HTTP response for an actual interactive session, never inside an internal
// recompute — passing viewerRoleIds null leaves values untouched, matching every existing caller
// that isn't a client-facing read.
export function filterCaptureValues(model, values, viewerRoleIds) {
  if (!viewerRoleIds) return values;
  return values.map((value) => {
    const restricted = model.fieldsById[value.fieldId]?.viewRoleIds;
    if (!restricted?.length || restricted.some((roleId) => viewerRoleIds.includes(roleId))) return value;
    return { fieldId: value.fieldId, occurrenceId: value.occurrenceId, valueType: value.valueType, origin: 'restricted', state: 'absent' };
  });
}

export function displayValue(field, value) {
  if (!value || value.state === 'absent' || value.state === 'empty') return '';
  if (value.state === 'not_applicable') return 'NA';
  if (value.state === 'invalid') return '';
  if (field.widget === 'result_widget') return capturedInputValue(value);
  const payload = valuePayload(value);
  if (['numeric', 'result'].includes(field.valueType) && value.numberValue != null) return formatValueWithDecimalPoints(payload, field.numeric?.displayScale, field.numeric?.padDecimals);
  if (field.valueType === 'option') return field.options.find((option) => option.id === payload)?.label ?? '';
  return payload;
}
