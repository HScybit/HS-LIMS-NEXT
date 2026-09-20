import { HttpError } from '../auth/errors.js';

export const organizationDateFormatDefaults = { dateFormat: 'DD/MM/YYYY', datetimeFormat: 'DD/MM/YYYY HH:mm:ss' };

// Source settings can contain custom Moment formats. The dropdown choices are
// not a whitelist: preserve their text, and distinguish omission from clearing.
export function organizationDateFormatsInput(input) {
  const settings = {};
  for (const [key, maximum] of [['dateFormat', 40], ['datetimeFormat', 60]]) {
    if (!Object.hasOwn(input, key)) continue;
    const value = input[key];
    if (value !== null && (typeof value !== 'string' || value.length > maximum || !value.isWellFormed() || value.includes('\0'))) {
      throw new HttpError(400, 'invalid_date_format', `Date formats must be text of at most ${maximum} characters.`);
    }
    settings[key] = value;
  }
  return settings;
}
