import { createHash } from 'node:crypto';
import { HttpError } from '../auth/errors.js';
import { uuid } from '../templates/input.js';
import { customFieldTimeZone } from '../custom-fields/server-dates.js';
import { masterBulkResource } from './bulk-row.js';
import { parseMasterBulkCsv } from './bulk-csv.js';
import { readMasterXlsx } from './bulk-xlsx-runner.js';
import { userBulkSourceFingerprint } from '../users/bulk-credentials.js';

export async function readMasterBulkUpload(request) {
  const resource = request.nextUrl.searchParams.get('resource'); masterBulkResource(resource);
  const id = uuid(request.headers.get('x-upload-request-id'), 'Upload request').toLowerCase();
  const timeZone = customFieldTimeZone(request.headers.get('x-upload-time-zone'));
  let fileName;
  try { fileName = decodeURIComponent(request.headers.get('x-file-name') ?? '').trim(); }
  catch { throw new HttpError(400, 'invalid_bulk_file', 'File name is invalid.'); }
  if (!fileName || fileName.length > 250 || !fileName.isWellFormed() || /[\0\r\n]/.test(fileName)) throw new HttpError(400, 'invalid_bulk_file', 'Use a valid file name of at most 250 characters.');
  const format = /\.csv$/i.test(fileName) ? 'csv' : /\.xlsx$/i.test(fileName) ? 'xlsx' : null;
  if (!format) throw new HttpError(415, 'invalid_bulk_file', 'Choose a CSV or XLSX file.');
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/octet-stream') throw new HttpError(415, 'invalid_content_type', 'Upload the spreadsheet file directly.');
  const length = request.headers.get('content-length');
  if (length !== null && !/^\d+$/.test(length)) throw new HttpError(400, 'invalid_bulk_length', 'File length is invalid.');
  if (length !== null && Number(length) > 16 * 1_048_576) throw new HttpError(413, 'bulk_file_limit', 'Files must be at most 16 MiB.');
  const reader = request.body?.getReader(); const chunks = []; let size = 0;
  try {
    if (reader) while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 16 * 1_048_576) { await reader.cancel().catch(() => {}); throw new HttpError(413, 'bulk_file_limit', 'Files must be at most 16 MiB.'); }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'incomplete_bulk_file', 'The file upload did not finish. Try again.');
  } finally { reader?.releaseLock(); }
  if (!size || length !== null && size !== Number(length)) throw new HttpError(400, 'incomplete_bulk_file', 'The file upload did not finish. Try again.');
  const bytes = Buffer.concat(chunks, size);
  let decoded;
  if (format === 'xlsx') decoded = await readMasterXlsx(bytes);
  else {
    let source;
    try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new HttpError(400, 'invalid_bulk_encoding', 'Save the CSV file with UTF-8 encoding.'); }
    decoded = parseMasterBulkCsv(source);
  }
  return { input: { id, resource, fileName, format, timeZone, ...(resource === 'users'
    ? { sourceHmacSha256: userBulkSourceFingerprint(bytes) } : { sourceSha256: createHash('sha256').update(bytes).digest('hex') }) }, decoded };
}
