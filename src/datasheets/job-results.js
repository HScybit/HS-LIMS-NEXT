import { HttpError } from '../auth/errors.js';
import { canonicalDecimal } from './final-result.js';

// Only the common numeric interpretation is enabled while the source policy
// differences remain unresolved. Never round a value or accept a numeric prefix
// on the analyst's behalf. Qualitative/spreadsheet modes remain a separate gate.
export function agreedResultNumber(field, input) {
  const value = String(input);
  const match = /^-?(\d+)(?:\.(\d+))?$/.exec(value);
  const number = Number(value);
  const fraction = match?.[2] ?? '';
  if (!['number', 'string'].includes(typeof input) || !match || !Number.isFinite(number)
    || match[1].replace(/^0+(?=\d)/, '').length > 18 || fraction.length > 12
    || canonicalDecimal(value) !== canonicalDecimal(number)
    || canonicalDecimal(value) !== canonicalDecimal(number.toFixed(2))
    || field.numeric?.displayScale != null && fraction.length > field.numeric.displayScale
    || field.numeric?.minimum != null && number < Number(field.numeric.minimum)
    || field.numeric?.maximum != null && number > Number(field.numeric.maximum)) {
    throw new HttpError(409, 'scientific_policy_unresolved', 'This result needs a confirmed scientific interpretation before it can be recorded.');
  }
  return value;
}

export async function recordJobResultEntries(client, instanceId, model, entered) {
  const results = entered.map((value, position) => ({ ...value, position }))
    .filter((value) => model.fieldsById[value.fieldId].widget === 'result_widget');
  if (!results.length || Object.values(model.sectionsById).some((section) => section.isFinalResult)) return;
  await client.query('SELECT laboratory_record_job_results($1,$2::uuid[],$3::uuid[],$4::integer[])',
    [instanceId, results.map((value) => value.fieldId), results.map((value) => value.occurrenceId), results.map((value) => value.position)]);
}
