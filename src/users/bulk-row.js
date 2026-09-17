import { HttpError } from '../auth/errors.js';
import { bulkCellValue } from '../masters/bulk-row.js';
import { userCreationDetails } from './creation-input.js';

const invalid = message => new HttpError(422, 'invalid_user_bulk_row', message);

export function userBulkAliases(rows, columns) {
  const aliases = new Map();
  for (const row of rows) for (const column of columns.filter(column => ['username', 'email'].includes(column.fieldName))) {
    const value = String(bulkCellValue(row.values[column.columnNumber - 1])).toLowerCase();
    if (!value || value.length > 320) continue;
    if (!aliases.has(value)) aliases.set(value, new Set());
    aliases.get(value).add(row.id);
  }
  return aliases;
}

export async function userBulkRowCommand({ columns, row, credential, id, requestId, resolve }) {
  if (credential?.state !== 'valid' || !/^[a-f0-9]{64}$/.test(credential.fingerprint ?? '')) {
    throw new HttpError(422, 'invalid_user_bulk_password', credential?.state === 'missing'
      ? 'Password is required. Enter a password containing 8 to 200 valid characters.'
      : 'Correct the password cell. Use 8 to 200 valid characters and a calculated value for spreadsheet formulas.');
  }
  const command = { id, requestId, revision: 0, canManagePeople: false };
  const metadata = new Map((row.cellMetadata ?? []).map(cell => [cell.columnNumber, cell]));
  for (const column of columns) {
    if (column.kind === 'password') continue;
    const source = metadata.get(column.columnNumber);
    if (source?.type === 'error' || source?.errorCode || source?.type === 'formula' && source.hasResult !== true) {
      throw invalid(`${column.header}: Correct the spreadsheet error or formula without a cached result.`);
    }
    const value = String(bulkCellValue(row.values[column.columnNumber - 1]));
    const field = column.fieldName;
    if (['businessUnitId', 'defaultRoleId', 'laboratoryId'].includes(field)) {
      if (!value && field !== 'businessUnitId') throw invalid(`${column.header} is required. Choose an active record explicitly.`);
      command[field] = value ? (await resolve(field, [value]))[0] : null;
    } else command[field] = value;
  }
  return { command: userCreationDetails(command), credentialFingerprint: credential.fingerprint };
}
