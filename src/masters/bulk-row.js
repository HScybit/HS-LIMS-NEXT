import { HttpError } from '../auth/errors.js';
import { masterBulkResources } from './bulk-config.js';
import { customerFormFields } from './customer-fields.js';
import { vendorBulkFields } from './vendor-bulk-config.js';

const invalid = message => new HttpError(400, 'invalid_bulk_row', message);

export function masterBulkResource(resource) {
  if (typeof resource !== 'string' || !Object.hasOwn(masterBulkResources, resource)) throw invalid('Select an available master.');
  return masterBulkResources[resource];
}

export function bulkCellValue(value) {
  if (value == null) return '';
  if (value instanceof Date && Number.isFinite(value.valueOf())) return value.toISOString();
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
  throw invalid('A cell must contain text, a finite number, a date or true/false.');
}

export function bulkBoolean(value, label) {
  const normalized = String(bulkCellValue(value)).toLowerCase();
  if (['true', 'yes', '1', 'on', 'y'].includes(normalized)) return true;
  if (['false', 'no', '0', 'off', 'n'].includes(normalized)) return false;
  throw invalid(`${label} must be true or false.`);
}

export function bulkDelimited(value) {
  const text = String(bulkCellValue(value));
  return text === '' ? [] : [...new Set(text.split(/[;,|]/).map(item => item.trim()).filter(Boolean))];
}

export function requiredBulkColumns(resource, columns) {
  const config = masterBulkResource(resource);
  const fields = new Set(columns.filter(column => column.kind === 'master').map(column => column.fieldName));
  const missing = config.required.filter(field => !fields.has(field));
  if (missing.length) throw new HttpError(400, 'missing_bulk_columns', `Required columns are missing: ${missing.join(', ')}. Download the sample file.`);
}

export function bulkRowKey(resource, columns, values) {
  const key = masterBulkResource(resource).key;
  const column = columns.find(column => column.kind === 'master' && column.fieldName === key);
  return String(bulkCellValue(column ? values[column.columnNumber - 1] : ''));
}

// Input cells retain their original types in staging. Only this authoring adapter
// trims/coerces them, and it never copies unbound properties into a command.
export async function masterBulkRowCommand({ resource, columns, row, definitions, previous, id, requestId, timeZone, resolve }) {
  const config = masterBulkResource(resource);
  requiredBulkColumns(resource, columns);
  const command = { id, requestId, revision: previous?.revision ?? 0 };
  for (const key of config.fields) if (previous && Object.hasOwn(previous, key)) command[key] = previous[key];
  const metadata = new Map((row.cellMetadata ?? []).map(cell => [cell.columnNumber, cell]));
  const supplied = new Map();
  for (const column of columns) {
    if (column.kind === 'ignored') continue;
    const source = metadata.get(column.columnNumber);
    if (source?.errorCode || source?.type === 'formula' && !source.hasResult) {
      throw invalid(`${column.header.trim()}: Correct the spreadsheet error or formula without a cached result.`);
    }
    let value = bulkCellValue(row.values[column.columnNumber - 1]);
    if (column.kind === 'custom_field') { supplied.set(column.fieldId, value); continue; }
    const key = column.fieldName;
    if (['customers', 'vendors'].includes(resource)) {
      const field = (resource === 'vendors' ? vendorBulkFields : customerFormFields).find(field => field.key === key);
      // PERN's file parser leaves optional blank scalars to API defaults.
      if (value === '' && ['number', 'boolean', 'select'].includes(field.type)) continue;
      if (field.type === 'boolean') value = bulkBoolean(value, column.header.trim());
      else if (field.type === 'number') {
        if (typeof value === 'boolean') throw invalid(`${field.label} must be a number.`);
        value = key === 'creditDays' ? Number(value) : String(value);
      } else value = String(value);
    } else if (key === 'parseNumber') value = bulkBoolean(value, column.header.trim());
    else if (['order', 'decimalScale'].includes(key)) {
      // A supplied blank uses the existing new-record default, not the old value.
      value = value === '' ? (key === 'order' ? 0 : 4) : Number(value);
      if (!Number.isFinite(value) || typeof row.values[column.columnNumber - 1] === 'boolean') throw invalid(`${column.header.trim()} must be a number.`);
    } else if (['tagIds', 'accessUserIds'].includes(key)) value = await resolve(key, bulkDelimited(value));
    else if (['jobTemplateId', 'laboratoryId'].includes(key)) value = value === '' ? null : (await resolve(key, [String(value)]))[0];
    else value = String(value);
    command[key] = value;
  }
  const previousByKey = new Map((previous?.customFields ?? []).map(field => [field.key, field.value]));
  if (definitions.length) command.customFields = definitions.map(field => {
    let value;
    if (supplied.has(field.id)) {
      value = supplied.get(field.id);
      if (field.allowsMultiple || field.fieldType === 'multi_user_select') value = bulkDelimited(value);
      else if (field.fieldType === 'checkbox' && value !== '') value = bulkBoolean(value, field.label);
    } else value = previousByKey.has(field.key) ? previousByKey.get(field.key) : '';
    return { fieldId: field.id, fieldRevision: field.revision, value };
  });
  // An omitted saved date keeps its interpretation zone even when another date
  // column is supplied. New records and wholly supplied date sets use the upload zone.
  const dates = definitions.filter(field => ['date', 'date_time'].includes(field.fieldType));
  const omittedDate = dates.find(field => !supplied.has(field.id) && previousByKey.has(field.key));
  if (dates.length) command.customFieldTimeZone = omittedDate
    ? previous?.customFields?.find(field => field.key === omittedDate.key)?.timeZone ?? previous?.customFieldTimeZone ?? timeZone : timeZone;
  return command;
}
