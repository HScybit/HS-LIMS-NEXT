import { HttpError } from '../auth/errors.js';
import { valueKey, valuePayload } from '../templates/calculations.js';
import { indexOccurrences } from '../templates/occurrences.js';
import { assertCaptureSize } from '../templates/runtime-limits.js';

const finalSectionWidgets = new Set(['result_widget', 'input_widget', 'formula_widget']);
const blank = (value) => value == null || typeof value === 'string' && value.trim() === '';
const unresolved = () => { throw new HttpError(409, 'scientific_policy_unresolved', 'This result needs a confirmed scientific interpretation before submission.'); };
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

function sourceValue(field, value) {
  if (value?.state === 'invalid') unresolved();
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
    if (!Number.isFinite(comparable) || canonicalDecimal(String(payload).trim()) !== canonicalDecimal(comparable)) unresolved();
    return { ...result, resultType: 'numeric', numberValue: String(payload).trim() };
  }
  // Meteor accepts numeric prefixes, while PERN only accepts full numeric text.
  // Until Q3 is answered, neither interpretation is silently chosen.
  if (!Number.isNaN(comparable) || typeof payload !== 'string' || payload !== payload.trim()) unresolved();
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
    if (validation.required == null) unresolved();
    if (!validation.required) continue;
    const value = saved.get(key);
    if (value?.state === 'invalid' || validation.errors.some((error) => error.code !== 'required' && error.code !== 'below_minimum' && error.code !== 'above_maximum')) unresolved();
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
