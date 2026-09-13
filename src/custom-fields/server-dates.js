import moment from 'moment-timezone';
import { HttpError } from '../auth/errors.js';
import { parseCustomFieldDate, customFieldDateDisplay } from './dates.js';

export const customFieldTimeZoneDataVersion = moment.tz.dataVersion;
const timeZones = new Map(moment.tz.names().map((name) => [name.toLowerCase(), name]));

export function customFieldTimeZone(value) {
  const name = typeof value === 'string' && value.length <= 100 ? timeZones.get(value.trim().toLowerCase()) : undefined;
  if (!name) {
    throw new HttpError(400, 'invalid_custom_field_timezone', 'The Custom Field time zone is invalid.');
  }
  return name;
}

function parserForZone(timeZone) {
  const zone = customFieldTimeZone(timeZone);
  // Explicit per-call parsing leaves the process timezone and Moment defaults untouched.
  return (value, formats, strict) => formats ? moment.tz(value, formats, strict, zone) : moment(value).tz(zone);
}

export function parseCustomFieldDateInZone(value, field, timeZone, fallback = '') {
  return parseCustomFieldDate(value, field, fallback, parserForZone(timeZone));
}

export function customFieldDateDisplayInZone(value, field, timeZone, fallback = '') {
  return customFieldDateDisplay(value, field, fallback, parserForZone(timeZone));
}
