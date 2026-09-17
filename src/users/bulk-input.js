import { HttpError } from '../auth/errors.js';

export const userBulkHeaders = Object.freeze(['name', 'email', 'phone', 'username', 'designation', 'unit_name', 'role_name', 'password', 'lab_name']);
const required = ['name', 'email', 'username', 'role_name', 'password', 'lab_name'];
const fields = { name: 'displayName', email: 'email', phone: 'phone', username: 'username', designation: 'designation',
  unit_name: 'businessUnitId', role_name: 'defaultRoleId', password: 'password', lab_name: 'laboratoryId' };

export function bindUserBulkHeaders(sourceHeaders) {
  const invalid = () => new HttpError(400, 'invalid_user_bulk_columns', 'Use the columns from the User sample workbook. Unknown and duplicate columns are not accepted.');
  if (!Array.isArray(sourceHeaders) || !sourceHeaders.length || sourceHeaders.length > 250) throw invalid();
  const headers = [];
  for (const header of sourceHeaders) {
    if (typeof header !== 'string' || header.length > 250 || !header.isWellFormed() || header.includes('\0')) throw invalid();
    headers.push(header.trim());
  }
  while (headers.at(-1) === '') headers.pop();
  if (headers.some(header => !Object.hasOwn(fields, header)) || new Set(headers).size !== headers.length) throw invalid();
  const missing = required.filter(header => !headers.includes(header));
  if (missing.length) throw new HttpError(422, 'missing_user_bulk_columns', `Include the required User columns: ${missing.join(', ')}.`);
  return headers.map((header, index) => ({ header, columnNumber: index + 1, fieldName: fields[header], kind: header === 'password' ? 'password' : 'master' }));
}
