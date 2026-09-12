import { agreedResultNumber, agreedResultValue } from '../datasheets/job-results.js';
import { text } from './input.js';

export function fieldDefaultValue(field) {
  if (field?.defaultState !== 'present') return null;
  return field.defaultLexical ?? field.defaultNumber ?? field.defaultText ?? field.defaultBoolean ?? field.defaultDate ?? null;
}

export function resultDefaultFields(field, input) {
  const value = text(typeof input === 'number' ? String(input) : input, 'Default value', 16000, { optional: true });
  const defaults = { defaultState: 'absent', defaultText: null, defaultNumber: null, defaultBoolean: null, defaultDate: null, defaultLexical: null };
  if (value === '' || value === '-') return defaults;
  const typed = field.valueType === 'numeric' ? { numberValue: agreedResultNumber(field, value) } : agreedResultValue(field, value);
  return { ...defaults, defaultState: 'present', defaultText: typed.textValue ?? null, defaultNumber: typed.numberValue ?? null, defaultLexical: typed.numberValue != null ? value : null };
}

// Match the source result-widget blur fallback without changing a runtime '-'
// into an empty value: '-' is the source's configuration sentinel only.
export function resolveResultInput(field, input) {
  const value = fieldDefaultValue(field);
  if (field?.widget !== 'result_widget' || value === null) return input;
  if (input.state === 'empty' || input.state === 'present' && typeof input.value === 'string' && input.value.trim() === '') {
    return { ...input, state: 'present', value };
  }
  return input;
}
