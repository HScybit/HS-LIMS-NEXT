import moment from 'moment-timezone';
import { HttpError } from '../auth/errors.js';
import { widgetDateFormat } from './widget-dates.js';

const timeZones = new Map(moment.tz.names().map((name) => [name.toLowerCase(), name]));

export function widgetTimeZone(value) {
  const zone = typeof value === 'string' && value.length <= 100 ? timeZones.get(value.trim().toLowerCase()) : undefined;
  if (!zone) throw new HttpError(400, 'invalid_widget_timezone', 'The widget display time zone is invalid.');
  return zone;
}

// Database timestamps are instants. Legacy wall-time text needs conversion
// with its recorded source zone before it can become reproducible history.
export function widgetDateDisplayInZone(value, mode, options, timeZone) {
  const zone = widgetTimeZone(timeZone);
  if (!value) return '';
  const isTimestamp = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  if (!(value instanceof Date) && !isTimestamp) {
    throw new HttpError(409, 'ambiguous_widget_timestamp', 'Widget date history requires a recorded timestamp with a time zone.');
  }
  const instant = value instanceof Date ? moment(value) : moment(value, moment.ISO_8601, true);
  return instant.isValid() ? instant.tz(zone).format(widgetDateFormat(mode, options)) : '';
}
