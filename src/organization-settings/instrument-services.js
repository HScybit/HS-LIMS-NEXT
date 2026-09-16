import { HttpError } from '../auth/errors.js';
import { bool, fieldsOnly, text, uuid } from '../templates/input.js';

export const instrumentServiceLimits = { rows: 100, code: 64, label: 150 };
export const instrumentServiceCodePattern = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function serviceText(value, label, maximum) {
  if (typeof value !== 'string' || !value.isWellFormed() || value.includes('\0')) {
    throw new HttpError(400, 'invalid_instrument_services', `${label} must be valid text without null characters.`);
  }
  return text(value.trim(), label, maximum, { optional: true });
}

export function instrumentServiceSettingsInput(input) {
  if (!Object.hasOwn(input, 'instrumentServiceTypes')) return null;
  const rows = input.instrumentServiceTypes;
  if (!Array.isArray(rows) || rows.length > instrumentServiceLimits.rows) {
    throw new HttpError(400, 'invalid_instrument_services', 'Provide at most 100 instrument services.');
  }
  const ids = new Set(); const codes = new Set(); const result = [];
  for (const row of rows) {
    fieldsOnly(row, ['id', 'serviceCode', 'displayLabel', 'isActive']);
    const id = uuid(row.id, 'Instrument service').toLowerCase();
    const serviceCode = serviceText(row.serviceCode, 'Instrument service key', instrumentServiceLimits.code);
    const displayLabel = serviceText(row.displayLabel, 'Instrument service value', instrumentServiceLimits.label);
    const isActive = bool(row.isActive, 'Instrument service Active');
    if (ids.has(id)) throw new HttpError(400, 'invalid_instrument_services', 'Instrument service identities must be unique.');
    ids.add(id);
    if (!serviceCode && !displayLabel) continue;
    if (!serviceCode || !displayLabel) throw new HttpError(400, 'invalid_instrument_services', 'Every instrument service must have both a key and a value.');
    if (!instrumentServiceCodePattern.test(serviceCode) || displayLabel.includes('\0')) {
      throw new HttpError(400, 'invalid_instrument_services', 'Service keys must start with a letter or number and contain only letters, numbers, dots, slashes, underscores or hyphens. Values cannot contain null characters.');
    }
    if (codes.has(serviceCode.toLowerCase())) throw new HttpError(400, 'invalid_instrument_services', 'Instrument service keys must be unique.');
    codes.add(serviceCode.toLowerCase()); result.push({ id, serviceCode, displayLabel, isActive });
  }
  return result;
}
