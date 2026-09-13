import { HttpError } from '../auth/errors.js';
import { fieldsOnly, integer, uuid } from '../templates/input.js';
import { customFieldSubmittedValue } from './form-values.js';

function primitiveValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length <= 16000 && value.isWellFormed() && !value.includes('\0')) return value;
  throw new HttpError(400, 'invalid_custom_field_value', 'Custom Field values must be text of at most 16,000 characters, a finite number or true/false.');
}

// This validates transport shape. The owning service still validates each pinned definition and its references.
export function customFieldValuesInput(input) {
  if (!Array.isArray(input) || input.length > 500) throw new HttpError(400, 'invalid_custom_field_values', 'Provide at most 500 Custom Fields.');
  const ids = new Set(); let itemCount = 0;
  return Array.from(input, (entry) => {
    fieldsOnly(entry, ['fieldId', 'fieldRevision', 'value']);
    const fieldId = uuid(entry.fieldId, 'Custom Field').toLowerCase();
    const fieldRevision = integer(entry.fieldRevision, 'Custom Field revision', 1, 2_147_483_647);
    if (ids.has(fieldId)) throw new HttpError(400, 'duplicate_custom_field_value', 'Each Custom Field can be provided only once.');
    ids.add(fieldId);
    if (!Object.hasOwn(entry, 'value')) throw new HttpError(400, 'missing_custom_field_value', 'Provide a value for each Custom Field, including an explicit empty value.');
    const multiple = Array.isArray(entry.value);
    const count = multiple ? entry.value.length : 1;
    itemCount += count;
    if (count > 500 || itemCount > 5000) throw new HttpError(400, 'custom_field_value_limit', 'Provide at most 500 items per Custom Field and 5,000 items in total.');
    const value = multiple ? Array.from(entry.value, primitiveValue) : primitiveValue(entry.value);
    return { fieldId, fieldRevision, value: customFieldSubmittedValue(value) };
  });
}
