import { createHash } from 'node:crypto';
import { HttpError } from '../auth/errors.js';
import { fieldsOnly, requirePermission, uuid } from '../templates/input.js';
import { customFieldAttachmentMetadata } from '../custom-fields/attachments.js';
import { requireNablRead } from './nabl.js';

export const nablFileByteLimit = 25 * 1024 * 1024;
const checksum = content => createHash('sha256').update(content).digest('hex');
const columns = `id,original_name AS "originalName",media_type AS "mediaType",byte_length AS "byteLength",sha256,
  uploaded_by AS "uploadedBy",uploaded_by_username AS "uploadedByUsername",uploaded_by_name AS "uploadedByName",uploaded_at AS "uploadedAt"`;
const metadata = row => ({ ...row, url: `/api/operations/nabl-certifications/files/${row.id}` });
export async function uploadNablFile(client, identity, input) {
  requirePermission(identity, 'compliance.manage'); fieldsOnly(input, ['requestId', 'originalName', 'mediaType', 'content']);
  const id = uuid(input.requestId, 'Upload request').toLowerCase(); const details = customFieldAttachmentMetadata(input.originalName, input.mediaType);
  if (!Buffer.isBuffer(input.content)) throw new HttpError(400, 'invalid_attachment', 'Attachment content is required.');
  if (input.content.length > nablFileByteLimit) throw new HttpError(413, 'attachment_size_limit', 'Attachments can be at most 25 MiB.');
  let replayed;
  try { replayed = (await client.query('SELECT nabl_upload_file($1,$2,$3,$4) AS replayed', [id, details.originalName, details.mediaType, input.content])).rows[0].replayed; }
  catch (error) {
    if (error.constraint === 'nabl_file_request_reused') throw new HttpError(409, 'attachment_request_reused', 'This upload request was already used with different details.');
    if (error.constraint === 'nabl_session_required') throw new HttpError(403, 'forbidden', 'An active compliance management session is required.');
    throw error;
  }
  const row = (await client.query(`SELECT ${columns} FROM nabl_file_directory WHERE organization_id=$1 AND id=$2`, [identity.organization_id, id])).rows[0];
  return { ...metadata(row), replayed };
}
export async function readNablFile(client, identity, fileId) {
  requireNablRead(identity); const id = uuid(fileId, 'Attachment').toLowerCase();
  const record = (await client.query(`SELECT ${columns},encoded_content AS "encodedContent" FROM nabl_file_content WHERE organization_id=$1 AND id=$2`, [identity.organization_id, id])).rows[0];
  if (!record) throw new HttpError(404, 'attachment_not_found', 'The attachment was not found.');
  const { encodedContent, ...row } = record; const content = typeof encodedContent === 'string' ? Buffer.from(encodedContent, 'base64') : null;
  if (!content || content.length !== row.byteLength || checksum(content) !== row.sha256) throw new HttpError(409, 'attachment_unavailable', 'The stored attachment is unavailable.');
  return { ...metadata(row), content };
}
export async function readNablUpload(request) {
  let originalName;
  try { originalName = decodeURIComponent(request.headers.get('x-file-name') ?? ''); }
  catch { throw new HttpError(400, 'invalid_attachment_name', 'The attachment filename is invalid.'); }
  const details = customFieldAttachmentMetadata(originalName, request.headers.get('content-type')?.split(';')[0]);
  const length = request.headers.get('content-length');
  if (length !== null && !/^\d+$/.test(length)) throw new HttpError(400, 'invalid_attachment_length', 'The attachment length is invalid.');
  if (length !== null && Number(length) > nablFileByteLimit) throw new HttpError(413, 'attachment_size_limit', 'Attachments can be at most 25 MiB.');
  const reader = request.body?.getReader(); const chunks = []; let size = 0;
  try {
    if (reader) while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > nablFileByteLimit) { await reader.cancel().catch(() => {}); throw new HttpError(413, 'attachment_size_limit', 'Attachments can be at most 25 MiB.'); }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'incomplete_attachment', 'The attachment upload did not finish. Please try again.');
  } finally { reader?.releaseLock(); }
  if (length !== null && size !== Number(length)) throw new HttpError(400, 'incomplete_attachment', 'The attachment upload did not finish. Please try again.');
  return { requestId: request.headers.get('x-upload-request-id'), ...details, content: Buffer.concat(chunks, size) };
}
