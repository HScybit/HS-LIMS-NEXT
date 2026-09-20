import { createHash } from 'node:crypto';
import { HttpError } from '../auth/errors.js';
import { fieldsOnly, integer, requirePermission, uuid } from '../templates/input.js';
import { customFieldAttachmentByteLimit, customFieldAttachmentMetadata } from '../custom-fields/attachments.js';
import { userProfileCommandError } from './profiles.js';

const columns = `id,field_id AS "fieldId",field_revision AS "fieldRevision",original_name AS "originalName",
  media_type AS "mediaType",byte_length AS "byteLength",sha256,uploaded_by AS "uploadedBy",uploaded_at AS "uploadedAt"`;
const metadata = row => ({ ...row, url: `/api/users/custom-fields/attachments/${row.id}` });
const errors = {
  user_field_attachment_invalid_input: [400, 'invalid_attachment', 'The attachment is invalid.'],
  user_field_attachment_request_reused: [409, 'attachment_request_reused', 'This upload request was already used with different details.'],
  user_field_attachment_field_missing: [404, 'attachment_field_not_found', 'The attachment field was not found.'],
  user_field_attachment_stale: [409, 'stale_custom_field', 'The Custom Field changed. Reload before uploading.'],
};

export async function uploadUserFieldAttachment(client, identity, input) {
  requirePermission(identity, 'users.manage');
  fieldsOnly(input, ['requestId', 'fieldId', 'fieldRevision', 'originalName', 'mediaType', 'content']);
  const id = uuid(input.requestId, 'Attachment upload request').toLowerCase();
  const fieldId = uuid(input.fieldId, 'Custom Field').toLowerCase();
  const fieldRevision = integer(input.fieldRevision, 'Custom Field revision', 1, 2_147_483_647);
  const details = customFieldAttachmentMetadata(input.originalName, input.mediaType);
  if (!Buffer.isBuffer(input.content)) throw new HttpError(400, 'invalid_attachment', 'Attachment content is required.');
  if (input.content.length > customFieldAttachmentByteLimit) throw new HttpError(413, 'attachment_size_limit', 'Attachments can be at most 20 MiB.');
  let replayed;
  try {
    replayed = (await client.query('SELECT users_upload_field_attachment($1,$2,$3,$4,$5,$6) AS replayed',
      [id, fieldId, fieldRevision, details.originalName, details.mediaType, input.content])).rows[0].replayed;
  } catch (error) {
    if (errors[error.constraint]) throw new HttpError(...errors[error.constraint]);
    throw userProfileCommandError(error);
  }
  const row = (await client.query(`SELECT ${columns} FROM user_custom_field_attachments WHERE organization_id=$1 AND id=$2`, [identity.organization_id, id])).rows[0];
  if (!row) throw new HttpError(409, 'attachment_unavailable', 'The stored attachment is unavailable.');
  return { ...metadata(row), replayed };
}

export async function readUserFieldAttachment(client, identity, attachmentId) {
  if (!identity.permission_codes?.some(code => ['users.read', 'users.manage'].includes(code))) {
    throw new HttpError(403, 'forbidden', 'You cannot view this attachment.');
  }
  const id = uuid(attachmentId, 'Attachment').toLowerCase();
  const record = (await client.query(`SELECT ${columns},encode(content,'base64') AS "encodedContent"
    FROM user_custom_field_attachments WHERE organization_id=$1 AND id=$2`, [identity.organization_id, id])).rows[0];
  if (!record) throw new HttpError(404, 'attachment_not_found', 'The attachment was not found.');
  const { encodedContent, ...row } = record;
  const content = typeof encodedContent === 'string' ? Buffer.from(encodedContent, 'base64') : null;
  if (!content || content.length !== row.byteLength || createHash('sha256').update(content).digest('hex') !== row.sha256) {
    throw new HttpError(409, 'attachment_unavailable', 'The stored attachment is unavailable.');
  }
  return { ...metadata(row), content };
}
