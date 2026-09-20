import { HttpError } from '../auth/errors.js';
import { compareDecimals, strictDecimalParts } from './final-result.js';

// Q3 (2026-09-18, follow PERN): a result must be strict full-match numeric text — no numeric
// prefix extraction (Meteor's parseFloat behavior), no rounding on the analyst's behalf, no
// scientific notation. Matches PERN's own validateNumber (templateInstances.js), including its
// exact BigInt decimal comparison for scale/range so no precision is lost through a JS Number.
export function agreedResultNumber(field, input) {
  if (!['number', 'string'].includes(typeof input) || String(input).length > 1000) {
    throw new HttpError(422, 'invalid_result_value', 'Enter a number.');
  }
  const parts = strictDecimalParts(input);
  if (!parts) throw new HttpError(422, 'invalid_result_value', 'Enter a number using only digits, an optional leading minus sign and a decimal point.');
  if (field.numeric?.displayScale != null && parts.fraction.length > field.numeric.displayScale) {
    throw new HttpError(422, 'result_decimal_scale', `Enter at most ${field.numeric.displayScale} decimal place${field.numeric.displayScale === 1 ? '' : 's'}.`);
  }
  if (field.numeric?.minimum != null && compareDecimals(parts.text, field.numeric.minimum) < 0) {
    throw new HttpError(422, 'result_below_minimum', `Enter a value of at least ${field.numeric.minimum}.`);
  }
  if (field.numeric?.maximum != null && compareDecimals(parts.text, field.numeric.maximum) > 0) {
    throw new HttpError(422, 'result_above_maximum', `Enter a value of at most ${field.numeric.maximum}.`);
  }
  return parts.text;
}

export function agreedResultValue(field, input) {
  if (typeof input === 'number' || typeof input === 'string' && /^-?\d+(?:\.\d+)?$/.test(input)) {
    return { numberValue: agreedResultNumber(field, input), lexical: String(input) };
  }
  // Meteor preserves nonnumeric text; PERN's result family has no text path to follow (it is
  // always numeric there), so this qualitative-text allowance is a deliberate Meteor-preserving
  // extension, not something Q3 revisits. An input that merely LOOKS like a botched number
  // (a leading digit that isn't itself a clean full number) stays rejected either way, since
  // accepting it as freeform text would silently hide a likely data-entry mistake.
  if (typeof input !== 'string' || !input.length || input.length > 16000 || input.includes('\0')
    || input !== input.trim() || !Number.isNaN(Number.parseFloat(input))) {
    throw new HttpError(422, 'invalid_result_value', 'Enter a number, or text that does not begin like one.');
  }
  return { textValue: input };
}

export async function recordJobResultEntries(client, instanceId, model, entered) {
  const results = entered.map((value, position) => ({ ...value, position }))
    .filter((value) => model.fieldsById[value.fieldId].widget === 'result_widget');
  if (!results.length || Object.values(model.sectionsById).some((section) => section.isFinalResult)) return;
  await client.query('SELECT laboratory_record_job_results($1,$2::uuid[],$3::uuid[],$4::integer[])',
    [instanceId, results.map((value) => value.fieldId), results.map((value) => value.occurrenceId), results.map((value) => value.position)]);
}
