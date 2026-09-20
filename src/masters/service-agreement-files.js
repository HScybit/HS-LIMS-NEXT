import { createHash } from 'node:crypto';
import { HttpError } from '../auth/errors.js';
import { fieldsOnly, requirePermission, uuid } from '../templates/input.js';
import { customFieldAttachmentMetadata } from '../custom-fields/attachments.js';
import { requireServiceAgreementRead, serviceAgreementError } from './service-agreements.js';
import { serviceAgreementFileByteLimit, serviceAgreementFileMediaTypes } from './service-agreement-file-config.js';

const columns = `id,original_name AS "originalName",media_type AS "mediaType",byte_length AS "byteLength",sha256,uploaded_by AS "uploadedBy",uploaded_at AS "uploadedAt"`;
const metadata = row => ({ ...row, url: `/api/masters/service-agreements/files/${row.id}` });
const sizeError = () => new HttpError(413, 'attachment_size_limit', 'Attachments can be at most 25 MiB.');
function fileMetadata(name, type) {
  const details = customFieldAttachmentMetadata(name, type);
  if (!serviceAgreementFileMediaTypes.includes(details.mediaType)) throw new HttpError(415, 'attachment_type_not_allowed', 'Choose a supported PDF, image, text, Word or Excel document.');
  return details;
}

export async function uploadServiceAgreementFile(client, identity, input) {
  requirePermission(identity, 'masters.manage'); fieldsOnly(input, ['requestId', 'originalName', 'mediaType', 'content']);
  const id = uuid(input.requestId, 'Upload request').toLowerCase(); const details = fileMetadata(input.originalName, input.mediaType);
  if (!Buffer.isBuffer(input.content) || !input.content.length) throw new HttpError(400, 'empty_attachment', 'Choose a nonempty attachment.');
  if (input.content.length > serviceAgreementFileByteLimit) throw sizeError();
  let replayed;
  try {
    replayed = (await client.query('SELECT service_agreements_upload_file($1,$2,$3,$4) AS replayed', [id, details.originalName, details.mediaType, input.content])).rows[0].replayed;
  } catch (error) {
    if (error.constraint === 'service_agreement_file_request_reused') throw new HttpError(409, 'attachment_request_reused', 'This upload request was already used with different details.');
    if (error.constraint === 'service_agreement_file_values') throw new HttpError(400, 'invalid_attachment', 'Check the attachment name, type and size.');
    throw serviceAgreementError(error);
  }
  const row = (await client.query(`SELECT ${columns} FROM service_agreement_files WHERE organization_id=$1 AND id=$2`, [identity.organization_id, id])).rows[0];
  if (!row) throw new HttpError(409, 'attachment_unavailable', 'The stored attachment is unavailable.');
  return { ...metadata(row), replayed };
}

export async function readServiceAgreementFile(client, identity, fileId) {
  await requireServiceAgreementRead(client, identity); const id = uuid(fileId, 'Attachment').toLowerCase();
  const record = (await client.query(`SELECT ${columns},encode(content,'base64') AS "encodedContent" FROM service_agreement_files WHERE organization_id=$1 AND id=$2`, [identity.organization_id, id])).rows[0];
  if (!record) throw new HttpError(404, 'attachment_not_found', 'The attachment was not found.');
  const { encodedContent, ...row } = record; const content = typeof encodedContent === 'string' ? Buffer.from(encodedContent, 'base64') : null;
  if (!content || content.length !== row.byteLength || createHash('sha256').update(content).digest('hex') !== row.sha256) throw new HttpError(409, 'attachment_unavailable', 'The stored attachment is unavailable.');
  return { ...metadata(row), content };
}

export async function readServiceAgreementUpload(request) {
  let originalName;
  try { originalName = decodeURIComponent(request.headers.get('x-file-name') ?? ''); }
  catch { throw new HttpError(400, 'invalid_attachment_name', 'The attachment filename is invalid.'); }
  const details = fileMetadata(originalName, request.headers.get('content-type')?.split(';')[0]);
  const length = request.headers.get('content-length');
  if (length !== null && !/^\d+$/.test(length)) throw new HttpError(400, 'invalid_attachment_length', 'The attachment length is invalid.');
  if (length !== null && Number(length) > serviceAgreementFileByteLimit) throw sizeError();
  const reader = request.body?.getReader(); const chunks = []; let size = 0;
  try {
    if (reader) while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > serviceAgreementFileByteLimit) { await reader.cancel().catch(() => {}); throw sizeError(); }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'incomplete_attachment', 'The attachment upload did not finish. Please try again.');
  } finally { reader?.releaseLock(); }
  if (length !== null && size !== Number(length)) throw new HttpError(400, 'incomplete_attachment', 'The attachment upload did not finish. Please try again.');
  if (!size) throw new HttpError(400, 'empty_attachment', 'Choose a nonempty attachment.');
  return { requestId: request.headers.get('x-upload-request-id'), ...details, content: Buffer.concat(chunks, size) };
}
