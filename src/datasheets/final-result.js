import { HttpError } from '../auth/errors.js';
import { valueKey, valuePayload } from '../templates/calculations.js';
import { indexOccurrences } from '../templates/occurrences.js';
import { assertCaptureSize } from '../templates/runtime-limits.js';

const finalSectionWidgets = new Set(['result_widget', 'input_widget', 'formula_widget']);
const blank = (value) => value == null || typeof value === 'string' && value.trim() === '';
const missing = (message) => { throw new HttpError(422, 'final_result_required', message); };

// Compare exact decimal values without changing the source's binary-number
// calculation semantics or rounding a stored decimal through Number().
export function canonicalDecimal(value) {
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(String(value));
  if (!match || !(match[2] || match[3])) return null;
  let digits = `${match[2]}${match[3] ?? ''}`.replace(/^0+/, '');
  if (!digits) return '0';
  let exponent = Number(match[4] ?? 0) - (match[3]?.length ?? 0);
  if (!Number.isSafeInteger(exponent)) return null;
  while (digits.endsWith('0')) { digits = digits.slice(0, -1); exponent += 1; }
  return `${match[1] === '-' ? '-' : ''}${digits}e${exponent}`;
}

// Strict "digits[.digits]" only (matches PERN's own decimalParts/validateNumber, Q3): no
// scientific notation, no leading '+', no whitespace. Returns null for anything else, including
// values whose precision exceeds what BigInt-exact comparison below still keeps safe.
export function strictDecimalParts(value) {
  const text = typeof value === 'number' ? String(value) : value;
  const match = typeof text === 'string' ? /^(-?)(\d+)(?:\.(\d+))?$/.exec(text) : null;
  if (!match) return null;
  const integer = match[2].replace(/^0+(?=\d)/, '') || '0';
  const fraction = match[3] ?? '';
  if (integer.length + fraction.length > 30 || integer.length > 18 || fraction.length > 12) return null;
  const isZero = integer === '0' && !/[1-9]/.test(fraction);
  return { text, negative: match[1] === '-' && !isZero, integer, fraction };
}

// Exact decimal comparison via BigInt, never through a JS Number, so no precision is lost
// regardless of how many digits either side has (within strictDecimalParts' own bounds).
export function compareDecimals(leftValue, rightValue) {
  const left = strictDecimalParts(leftValue); const right = strictDecimalParts(rightValue);
  if (!left || !right) throw new Error('compareDecimals requires two strict decimal strings');
  if (left.negative !== right.negative) return left.negative ? -1 : 1;
  const scale = Math.max(left.fraction.length, right.fraction.length);
  const leftMagnitude = BigInt(`${left.integer}${left.fraction.padEnd(scale, '0')}`);
  const rightMagnitude = BigInt(`${right.integer}${right.fraction.padEnd(scale, '0')}`);
  const comparison = leftMagnitude === rightMagnitude ? 0 : leftMagnitude < rightMagnitude ? -1 : 1;
  return left.negative ? -comparison : comparison;
}

// Q2 (2026-09-18, show errors to the user): an invalid calculation feeding a final/reported
// result is a real, named error blocking that completion — never a generic "unresolved policy"
// placeholder, and never silently substituted with anything. Surface the calculation engine's
// own errorCode/errorMessage (already captured in calculateCapture, src/templates/calculations.js)
// rather than inventing a new message that hides what actually failed.
function sourceValue(field, value) {
  if (value?.state === 'invalid') {
    throw new HttpError(422, 'final_result_calculation_error', value.errorMessage || 'This result could not be calculated.');
  }
  if (value?.state === 'not_applicable') return 'NA';
  const payload = valuePayload(value);
  if (field.valueType === 'option' && payload != null) return field.options.find((option) => option.id === payload)?.value;
  return payload;
}

function scalar(candidate, source) {
  const { field, value, occurrenceId } = candidate;
  const payload = sourceValue(field, value);
  if (blank(payload)) missing('Final result column must have value.');
  const result = { source, fieldId: field.id, occurrenceId, valueRevision: value.revision, selectionSemantics: 'source-agreement-v1' };
  if (typeof payload === 'boolean') return { ...result, resultType: 'boolean', booleanValue: payload };
  const numericText = typeof payload === 'string' && /^-?\d+(?:\.\d+)?$/.test(payload.trim());
  const comparable = Number.parseFloat(payload);
  if (['numeric', 'result'].includes(field.valueType) && value.state === 'present' && value.numberValue != null || numericText) {
    // Q3 (follow PERN): the stored/matched text must itself be exact, strict decimal text — this is
    // a defensive integrity check (upstream save-time validation already enforces this), not a
    // second place choosing between Meteor and PERN interpretations.
    if (!strictDecimalParts(String(payload).trim())) {
      throw new HttpError(422, 'final_result_invalid_number', 'This result is not a valid number.');
    }
    return { ...result, resultType: 'numeric', numberValue: String(payload).trim() };
  }
  // Q3 (follow PERN): PERN's result family has no text path to follow (always numeric there), so a
  // qualitative text result is a Meteor-preserving extension. A payload that merely looks like a
  // botched number (has a numeric prefix but isn't itself clean numeric text) stays rejected either
  // way, since accepting it as freeform text would silently hide a likely data-entry mistake.
  if (!Number.isNaN(comparable) || typeof payload !== 'string' || payload !== payload.trim()) {
    throw new HttpError(422, 'final_result_invalid_text', 'This result is not a valid number, and does not look like plain text either.');
  }
  return { ...result, resultType: 'text', textValue: payload };
}

export function resolveRecordedResult(field, value, occurrenceId, source) {
  return scalar({ field, value, occurrenceId }, source);
}

function sectionOccurrences(model, occurrences, savedValues) {
  assertCaptureSize(model, occurrences);
  const runtime = indexOccurrences(model, occurrences);
  const values = new Map(savedValues.map((value) => [valueKey(value.fieldId, value.occurrenceId), value]));
  const sections = [];
  function visit(sectionId, parentId) {
    const section = model.sectionsById[sectionId];
    const instances = section.ownRepeatGroupId ? runtime.forGroup(parentId, section.ownRepeatGroupId) : [{ id: parentId }];
    for (const instance of instances) {
      const current = { section, parentOccurrenceId: parentId, occurrenceId: instance.id, fields: [] }; const children = [];
      sections.push(current);
      for (const rowId of section.rowIds) {
        const row = model.rowsById[rowId];
        const rows = row.ownRepeatGroupId ? runtime.forGroup(instance.id, row.ownRepeatGroupId) : [instance];
        for (const occurrence of rows) for (const columnId of row.columnIds) {
          const column = model.columnsById[columnId]; const field = model.fieldsById[column.fieldId];
          if (field?.alias) current.fields.push({ field, column, occurrenceId: occurrence.id, value: values.get(valueKey(field.id, occurrence.id)) });
          for (const child of column.childSectionIds) children.push([child, occurrence.id]);
        }
      }
      for (const [child, occurrenceId] of children) visit(child, occurrenceId);
    }
  }
  for (const id of model.rootSectionIds) visit(id, runtime.root.id);
  return sections;
}

export function finalResultSectionRoots(model, occurrences) {
  return sectionOccurrences(model, occurrences, []).filter(({ section }) => section.isFinalResult)
    .map(({ section, parentOccurrenceId, occurrenceId }) => ({ sectionId: section.id, parentOccurrenceId, occurrenceId }));
}

// The included Meteor screen passes its captured payload through the workflow
// to storage; it and PERN both select the later explicit final section. The
// standalone Meteor extractor is only a fallback in that path. Numeric-prefix
// interpretation and erroneous scientific results remain explicit release gates.
// All display sections are reconstructed from the frozen definition/capture,
// rather than accepting or persisting client-supplied HTML or a results object.
export function resolveFinalResult(model, occurrences, savedValues) {
  const sections = sectionOccurrences(model, occurrences, savedValues);
  const finalSections = sections.filter(({ section }) => section.isFinalResult);
  let selectedSectionValue;
  for (const { fields } of finalSections) {
    const eligible = fields.filter(({ field }) => finalSectionWidgets.has(field.widget));
    for (const candidate of eligible) {
      if (blank(sourceValue(candidate.field, candidate.value))) missing('All fields must have values in final result section.');
    }
    const explicit = eligible.find(({ column }) => column.isFinalResult);
    if (explicit) selectedSectionValue = explicit;
    else selectedSectionValue ??= eligible[0];
  }
  if (selectedSectionValue) return scalar(selectedSectionValue, 'section');
  if (finalSections.length) missing('Results not found in the final result sections.');
  const candidates = sections.flatMap(({ fields }) => fields.filter(({ column }) => column.isFinalResult));
  const selected = candidates.find(({ field, value }) => !blank(sourceValue(field, value)));
  if (selected) {
    return scalar(selected, 'column');
  }
  missing(candidates.length ? 'Final result column must have value.' : 'Results not found or no section/column is marked as final result.');
}

export function validateSubmissionValues(model, capture, calculation) {
  const saved = new Map(capture.values.map((value) => [valueKey(value.fieldId, value.occurrenceId), value]));
  for (const [key, validation] of Object.entries(calculation.validation)) {
    // These widgets display their domain context. The source's
    // shared Required setting does not turn it into an entered result.
    if (['product_detail_widget', 'tr_data_widget'].includes(model.fieldsById[key.split(':')[0]]?.widget)) continue;
    const label = model.fieldsById[key.split(':')[0]]?.label || 'This field';
    // Q2 (show errors to the user): a required-condition expression that itself failed to
    // evaluate is a real, named calculation error blocking submission, surfaced with the
    // engine's own message rather than a generic "unresolved policy" placeholder.
    if (validation.required == null) {
      const conditionError = validation.errors.find((error) => error.code !== 'required' && error.code !== 'below_minimum' && error.code !== 'above_maximum');
      throw new HttpError(422, 'final_result_calculation_error', conditionError?.message || `${label}'s required condition could not be calculated.`);
    }
    if (!validation.required) continue;
    const value = saved.get(key);
    const blockingError = validation.errors.find((error) => error.code !== 'required' && error.code !== 'below_minimum' && error.code !== 'above_maximum');
    if (value?.state === 'invalid' || blockingError) {
      throw new HttpError(422, 'final_result_calculation_error', value?.errorMessage || blockingError?.message || `${label} could not be calculated.`);
    }
    if (!value || ['absent', 'empty'].includes(value.state) || value.state === 'present' && blank(valuePayload(value))) {
      throw new HttpError(422, 'required_template_values_missing', `Enter a value for ${model.fieldsById[value?.fieldId ?? key.split(':')[0]]?.label || 'every required field'}.`);
    }
  }
  for (const value of calculation.calculated) {
    const prior = saved.get(valueKey(value.fieldId, value.occurrenceId));
    if (!prior || prior.state !== value.state || canonicalDecimal(prior.numberValue) !== canonicalDecimal(value.numberValue)
      || (prior.errorCode ?? null) !== (value.errorCode ?? null)) {
      throw new HttpError(409, 'datasheet_calculation_stale', 'Calculate and save the datasheet before submitting.');
    }
  }
}
