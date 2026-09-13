import { customFieldDateDisplay } from './dates.js';

export const productCustomFieldColumnKey = (field) => `pf:${field.id}`;

export function productCustomFieldListDisplay(entry, field) {
  if (!entry) return '';
  const date = ['date','date_time'].includes(field.fieldType);
  const value = date ? entry.value ?? entry.displayValue : entry.displayValue ?? entry.value;
  function display(item) {
    if (item === undefined || item === null || item === '') return '';
    if (Array.isArray(item)) return item.map(display).filter(Boolean).join(', ');
    return String(date ? customFieldDateDisplay(item, field) : item);
  }
  return display(value);
}

export function productCustomFieldSearchValue(value) {
  const input = String(value ?? '').trim(); const number = Number(input); const lower = input.toLowerCase();
  return { pattern: `%${input.replace(/[\\%_]/g, '\\$&')}%`, number: input && Number.isFinite(number) ? number : null,
    boolean: ['true','yes','1'].includes(lower) ? true : ['false','no','0'].includes(lower) ? false : null };
}
