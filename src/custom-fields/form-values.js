import { customFieldDateDisplay } from './dates.js';

const inputTypes = { text: 'text', number: 'number', date: 'date', select: 'select', lookup: 'select', longtext: 'textarea',
  attachment: 'file', multi_user_select: 'relation', date_time: 'datetime-local', checkbox: 'boolean', email: 'email' };

export function customFieldControl(field, lookupOptions = []) {
  let type = inputTypes[field.fieldType] ?? 'text';
  let multiple = type === 'relation' || (type === 'select' && field.allowsMultiple);
  if (field.allowsMultiple && !['file', 'relation', 'select'].includes(type)) { type = 'array'; multiple = true; }
  return { type, multiple: Boolean(multiple), required: Boolean(field.isRequired), label: field.label,
    options: type !== 'select' ? [] : field.fieldType === 'lookup' ? lookupOptions : (field.options ?? []).map((option) => ({ value: option.key, label: option.label })) };
}

export function customFieldInitialValue(field, stored) {
  const control = customFieldControl(field);
  const rawValue = stored && typeof stored === 'object' ? stored.value : stored;
  const displayed = stored && typeof stored === 'object' ? stored.displayValue : undefined;
  const value = ['date', 'datetime-local'].includes(control.type) && (rawValue === undefined || rawValue === null || rawValue === '')
    && displayed !== undefined && displayed !== null && displayed !== '' ? displayed : rawValue ?? displayed;
  if (control.multiple) return Array.isArray(value) ? value : value === undefined || value === null || value === '' ? [] : [value];
  return value ?? '';
}

function meaningfulValue(value) {
  if (Array.isArray(value)) return value.some(meaningfulValue);
  return value !== undefined && value !== null && String(value).trim() !== '';
}

export function customFieldSubmittedValue(value) {
  return Array.isArray(value) ? value.filter(meaningfulValue) : value === undefined || value === null ? '' : value;
}

export function customFieldFormDisplayValue(value, field, lookupOptions = []) {
  const control = customFieldControl(field, lookupOptions);
  const display = (item) => {
    // The source drops false/zero display items, while retaining them in the submitted value array.
    if (Array.isArray(item)) return item.map(display).filter(Boolean).join(', ');
    if (item === undefined || item === null || item === '') return '';
    if (['date', 'datetime-local'].includes(control.type)) return customFieldDateDisplay(item, field);
    const option = control.options.find((option) => String(option.value) === String(item));
    return option?.label ?? item;
  };
  return display(value);
}

function blankValue(value) {
  if (Array.isArray(value)) return value.every(blankValue);
  return value === undefined || value === null || String(value).trim() === '';
}

export function customFieldNeedsGeneration(field, mode, value) {
  if (!field?.scheme || !blankValue(value)) return false;
  const generatedAt = field.generatedAt || 'on_init';
  return (mode === 'create' && generatedAt === 'on_init') || generatedAt === 'on_submit';
}
