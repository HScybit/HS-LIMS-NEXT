import moment from 'moment';
import { customFieldDateDisplayFormat } from '../custom-fields/dates.js';

// Widget dates use a different source parser from Custom Fields: zero and
// false are absent, invalid text is blank, and a Moment fallback is allowed.
const dateFormats = [moment.ISO_8601, 'YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'DD-MM-YYYY', 'MM-DD-YYYY', 'YYYY/MM/DD',
  'DD.MM.YYYY', 'MM.DD.YYYY', 'DD MMM YYYY', 'MMM DD, YYYY', 'DD MMMM YYYY', 'MMMM DD, YYYY', 'MMMM Do YYYY', 'D MMM YYYY', 'Do MMMM YYYY'];
const dateTimeFormats = [moment.ISO_8601, 'YYYY-MM-DDTHH:mm', 'YYYY-MM-DDTHH:mm:ss', 'YYYY-MM-DD HH:mm', 'YYYY-MM-DD HH:mm:ss',
  'YYYY-MM-DD hh:mm A', 'DD/MM/YYYY HH:mm', 'DD/MM/YYYY, HH:mm', 'DD/MM/YYYY HH:mm:ss', 'DD/MM/YYYY hh:mm A', 'DD/MM/YYYY, hh:mm A',
  'MM/DD/YYYY HH:mm', 'MM/DD/YYYY hh:mm A', 'DD-MM-YYYY HH:mm', 'DD-MM-YYYY hh:mm A', 'DD MMM YYYY HH:mm', 'DD MMM YYYY hh:mm A',
  'MMM DD, YYYY HH:mm', 'MMM DD, YYYY hh:mm A', 'DD MMMM YYYY HH:mm', 'DD MMMM YYYY hh:mm A', 'MMMM DD, YYYY HH:mm',
  'MMMM DD, YYYY hh:mm A', 'MMMM Do YYYY | HH:mm', 'MMMM Do YYYY | hh:mm A'];
const isDateTime = (mode) => ['datetime', 'date_time', 'datetime-local'].includes(mode);

export function widgetDateFormat(mode = 'date', { field, dateFormat, datetimeFormat } = {}) {
  const dateTime = isDateTime(mode);
  const fallback = dateTime ? datetimeFormat || 'DD/MM/YYYY HH:mm:ss' : dateFormat || 'DD/MM/YYYY';
  return customFieldDateDisplayFormat(field || (dateTime ? 'date_time' : 'date'), fallback);
}

export function parseWidgetDate(value, mode = 'date', parse = moment) {
  if (!value) return null;
  if (value instanceof Date) {
    const parsed = parse(value);
    return parsed.isValid() ? parsed : null;
  }
  const parsed = parse(value, isDateTime(mode) ? dateTimeFormats : dateFormats, true);
  if (parsed.isValid()) return parsed;
  const fallback = parse(value);
  return fallback.isValid() ? fallback : null;
}

export function widgetDateDisplay(value, mode = 'date', options = {}, parse = moment) {
  const parsed = parseWidgetDate(value, mode, parse);
  return parsed ? parsed.format(widgetDateFormat(mode, options)) : '';
}
