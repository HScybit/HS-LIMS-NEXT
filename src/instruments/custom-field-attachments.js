import { createHash } from 'node:crypto';
import { HttpError } from '../auth/errors.js';
import { fieldsOnly, integer, requirePermission, uuid } from '../templates/input.js';
import { customFieldAttachmentByteLimit, customFieldAttachmentMetadata } from '../custom-fields/attachments.js';
import { instrumentError, requireInstrumentRead } from './core.js';

const columns = `id,field_id AS "fieldId",field_revision AS "fieldRevision",original_name AS "originalName",
  media_type AS "mediaType",byte_length AS "byteLength",sha256,uploaded_by AS "uploadedBy",uploaded_at AS "uploadedAt"`;
const metadata = row => ({ ...row, url: `/api/instruments/custom-fields/attachments/${row.id}` });
const errors = {
  instrument_attachment_input: [400, 'invalid_attachment', 'The attachment is invalid.'],
  instrument_attachment_request_reused: [409, 'attachment_request_reused', 'This upload request was already used with different details.'],
  instrument_attachment_field_not_found: [404, 'attachment_field_not_found', 'The attachment field was not found.'],
  instrument_attachment_field_changed: [409, 'stale_custom_field', 'The Custom Field changed. Reload before uploading.'],
};

export async function uploadInstrumentFieldAttachment(client, identity, input) {
  requirePermission(identity, 'instruments.manage');
  fieldsOnly(input, ['requestId', 'fieldId', 'fieldRevision', 'originalName', 'mediaType', 'content']);
  const id = uuid(input.requestId, 'Attachment upload request').toLowerCase();
  const fieldId = uuid(input.fieldId, 'Custom Field').toLowerCase();
  const fieldRevision = integer(input.fieldRevision, 'Custom Field revision', 1, 2_147_483_647);
  const details = customFieldAttachmentMetadata(input.originalName, input.mediaType);
  if (!Buffer.isBuffer(input.content)) throw new HttpError(400, 'invalid_attachment', 'Attachment content is required.');
  if (input.content.length > customFieldAttachmentByteLimit) throw new HttpError(413, 'attachment_size_limit', 'Attachments can be at most 20 MiB.');
  let replayed;
  try {
    replayed = (await client.query('SELECT instruments_upload_field_attachment($1,$2,$3,$4,$5,$6) AS replayed',
      [id, fieldId, fieldRevision, details.originalName, details.mediaType, input.content])).rows[0].replayed;
  } catch (error) {
    if (errors[error.constraint]) throw new HttpError(...errors[error.constraint]);
    throw instrumentError(error);
  }
  const row = (await client.query(`SELECT ${columns} FROM instrument_custom_field_attachments WHERE organization_id=$1 AND id=$2`, [identity.organization_id, id])).rows[0];
  if (!row) throw new HttpError(409, 'attachment_unavailable', 'The stored attachment is unavailable.');
  return { ...metadata(row), replayed };
}

export async function readInstrumentFieldAttachment(client, identity, attachmentId) {
  await requireInstrumentRead(client, identity);
  const id = uuid(attachmentId, 'Attachment').toLowerCase();
  const record = (await client.query(`SELECT ${columns},encode(content,'base64') AS "encodedContent"
    FROM instrument_custom_field_attachments WHERE organization_id=$1 AND id=$2`, [identity.organization_id, id])).rows[0];
  if (!record) throw new HttpError(404, 'attachment_not_found', 'The attachment was not found.');
  const { encodedContent, ...row } = record;
  const content = typeof encodedContent === 'string' ? Buffer.from(encodedContent, 'base64') : null;
  if (!content || content.length !== row.byteLength || createHash('sha256').update(content).digest('hex') !== row.sha256) {
    throw new HttpError(409, 'attachment_unavailable', 'The stored attachment is unavailable.');
  }
  return { ...metadata(row), content };
}
