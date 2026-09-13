import moment from 'moment';
import { customFieldDateFormats, customFieldDateTimeFormats } from '../masters/custom-field-config.js';

const dateInputFormat = 'YYYY-MM-DD';
const dateTimeInputFormat = 'YYYY-MM-DDTHH:mm';
const nativeDateTimeFormats = ['YYYY-MM-DDTHH:mm:ss.SSSZ', 'YYYY-MM-DDTHH:mm:ssZ', 'YYYY-MM-DDTHH:mm:ss',
  dateTimeInputFormat, 'YYYY-MM-DD HH:mm:ss', 'YYYY-MM-DD HH:mm'];

function fieldType(field) {
  const type = String((typeof field === 'object' ? field?.fieldType : field) || '').trim().toLowerCase();
  return ['datetime', 'datetime_local', 'datetime-local'].includes(type) ? 'date_time' : type;
}

function sourceValue(value) {
  if (value && typeof value === 'object' && !(value instanceof Date) && !moment.isMoment(value)) {
    return value.value ?? value.display_value ?? value.label ?? value.name ?? value.key ?? value._id;
  }
  return value;
}

export function customFieldDateDisplayFormat(field, fallback = '') {
  const type = fieldType(field);
  if (!['date', 'date_time'].includes(type)) return fallback;
  const formats = type === 'date_time' ? customFieldDateTimeFormats : customFieldDateFormats;
  const format = String((typeof field === 'object' ? field?.[type === 'date_time' ? 'datetimeFormat' : 'dateFormat'] : '') || '').trim();
  return formats.some((option) => option.value === format) ? format : fallback || (type === 'date_time' ? 'DD/MM/YYYY HH:mm:ss' : 'DD/MM/YYYY');
}

export function parseCustomFieldDate(value, field, fallback = '', parse = moment) {
  const raw = sourceValue(value);
  if (raw === undefined || raw === null || raw === '') return null;
  if (raw instanceof Date || moment.isMoment(raw) || typeof raw === 'number') {
    const parsed = parse(raw);
    return parsed.isValid() ? parsed : null;
  }
  const text = String(raw).trim();
  if (!text) return null;
  const dateFormats = customFieldDateFormats.map((option) => option.value);
  const dateTimeFormats = customFieldDateTimeFormats.map((option) => option.value);
  const displayFormat = customFieldDateDisplayFormat(field, fallback);
  const formats = fieldType(field) === 'date_time'
    ? [moment.ISO_8601, displayFormat, ...nativeDateTimeFormats, ...dateTimeFormats, ...dateFormats]
    : [moment.ISO_8601, displayFormat, dateInputFormat, 'YYYY/MM/DD', ...dateFormats, ...dateTimeFormats, ...nativeDateTimeFormats];
  const parsed = parse(text, [...new Set(formats.filter(Boolean))], true);
  return parsed.isValid() ? parsed : null;
}

// These format existing values for the source controls. They are not validators or storage conversions.
export function customFieldDateInput(value, field, fallback = '') {
  const raw = sourceValue(value);
  if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}/.test(raw.trim())) return raw.trim().slice(0, 10);
  const parsed = parseCustomFieldDate(raw, field || 'date', fallback);
  return parsed ? parsed.format(dateInputFormat) : '';
}

export function customFieldDateTimeInput(value, field, fallback = '') {
  const raw = sourceValue(value);
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text) && !/(Z|[+-]\d{2}:?\d{2})$/i.test(text)) return text.slice(0, 16);
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text)) return `${text.slice(0, 10)}T${text.slice(11, 16)}`;
  }
  const parsed = parseCustomFieldDate(raw, field || 'date_time', fallback);
  return parsed ? parsed.format(dateTimeInputFormat) : '';
}

export function customFieldDateDisplay(value, field, fallback = '', parse = moment) {
  if (value === undefined || value === null || value === '') return '';
  if (!['date', 'date_time'].includes(fieldType(field))) return value;
  const parsed = parseCustomFieldDate(value, field, fallback, parse);
  return parsed ? parsed.format(customFieldDateDisplayFormat(field, fallback)) : String(value);
}
