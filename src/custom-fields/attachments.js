import { createHash } from 'node:crypto';
import { HttpError } from '../auth/errors.js';
import { fieldsOnly, integer, requirePermission, uuid } from '../templates/input.js';

export const customFieldAttachmentByteLimit = 20 * 1024 * 1024;
const checksum = (content) => createHash('sha256').update(content).digest('hex');
const columns = `id,field_id AS "fieldId",field_revision AS "fieldRevision",original_name AS "originalName",
  media_type AS "mediaType",byte_length AS "byteLength",sha256,uploaded_by AS "uploadedBy",uploaded_at AS "uploadedAt"`;
const metadata = (row) => ({ ...row, url: `/api/custom-fields/attachments/${row.id}` });

export function customFieldAttachmentMetadata(originalName, mediaType) {
  if (typeof originalName !== 'string' || !originalName.isWellFormed() || /[\u0000-\u001f\u007f-\u009f]/.test(originalName)) {
    throw new HttpError(400, 'invalid_attachment_name', 'The attachment filename is invalid.');
  }
  // Match the source basename rule, without silently truncating an identifier.
  const name = originalName.trim().split(/[\\/]/).pop() || 'upload';
  if (name.length > 500) throw new HttpError(400, 'invalid_attachment_name', 'Attachment filenames can be at most 500 characters.');
  const type = typeof mediaType === 'string' ? mediaType.trim().toLowerCase() : mediaType == null ? '' : null;
  if (type === null || (type && (type.length > 255 || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(type)))) {
    throw new HttpError(400, 'invalid_attachment_type', 'The attachment media type is invalid.');
  }
  return { originalName: name, mediaType: type || 'application/octet-stream' };
}

export async function uploadCustomFieldAttachment(client, identity, input) {
  requirePermission(identity, 'masters.manage');
  fieldsOnly(input, ['requestId', 'fieldId', 'fieldRevision', 'originalName', 'mediaType', 'content']);
  const id = uuid(input.requestId, 'Attachment upload request').toLowerCase();
  const fieldId = uuid(input.fieldId, 'Custom Field').toLowerCase();
  const fieldRevision = integer(input.fieldRevision, 'Custom Field revision', 1, 2_147_483_647);
  const details = customFieldAttachmentMetadata(input.originalName, input.mediaType);
  if (!Buffer.isBuffer(input.content)) throw new HttpError(400, 'invalid_attachment', 'Attachment content is required.');
  if (input.content.length > customFieldAttachmentByteLimit) throw new HttpError(413, 'attachment_size_limit', 'Attachments can be at most 20 MiB.');
  const sha256 = checksum(input.content);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('custom-field-upload:'||$1::text||':'||$2::text,0))", [identity.organization_id, id]);
  const stored = (await client.query(`SELECT ${columns} FROM custom_field_attachments WHERE organization_id=$1 AND id=$2`, [identity.organization_id, id])).rows[0];
  if (stored) {
    if (stored.fieldId !== fieldId || stored.fieldRevision !== fieldRevision || stored.uploadedBy !== identity.user_id
      || stored.originalName !== details.originalName || stored.mediaType !== details.mediaType || stored.sha256 !== sha256 || stored.byteLength !== input.content.length) {
      throw new HttpError(409, 'attachment_request_reused', 'This upload request was already used with different details.');
    }
    return { ...metadata(stored), replayed: true };
  }
  const field = (await client.query(`SELECT revision,field_type,associated_with,active FROM custom_field_definitions
    WHERE organization_id=$1 AND id=$2 FOR SHARE`, [identity.organization_id, fieldId])).rows[0];
  if (!field?.active || field.field_type !== 'attachment' || !['product', 'parameter'].includes(field.associated_with)) {
    throw new HttpError(404, 'attachment_field_not_found', 'The attachment field was not found.');
  }
  if (field.revision !== fieldRevision) throw new HttpError(409, 'stale_custom_field', 'The Custom Field changed. Reload before uploading.');
  try {
    const row = (await client.query(`INSERT INTO custom_field_attachments(organization_id,id,field_id,field_revision,original_name,media_type,content,byte_length,sha256,uploaded_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${columns}`, [identity.organization_id, id, fieldId, fieldRevision,
      details.originalName, details.mediaType, input.content, input.content.length, sha256, identity.user_id])).rows[0];
    return { ...metadata(row), replayed: false };
  } catch (error) {
    // A users-only file may occupy this request UUID without being readable through the master boundary.
    if (error.constraint === 'custom_field_attachment_pk') throw new HttpError(409, 'attachment_request_reused', 'This upload request was already used with different details.');
    throw error;
  }
}

export async function readCustomFieldAttachment(client, identity, attachmentId) {
  if (!identity.permission_codes?.some((code) => ['masters.read', 'masters.manage'].includes(code))) {
    throw new HttpError(403, 'forbidden', 'You cannot view this attachment.');
  }
  const id = uuid(attachmentId, 'Attachment').toLowerCase();
  // Base64 reduces text-protocol transfer size; BYTEA remains the sole stored content.
  const record = (await client.query(`SELECT ${columns},encode(content,'base64') AS "encodedContent"
    FROM custom_field_attachments WHERE organization_id=$1 AND id=$2`, [identity.organization_id, id])).rows[0];
  if (!record) throw new HttpError(404, 'attachment_not_found', 'The attachment was not found.');
  const { encodedContent, ...row } = record;
  const content = typeof encodedContent === 'string' ? Buffer.from(encodedContent, 'base64') : null;
  if (!content || content.length !== row.byteLength || checksum(content) !== row.sha256) {
    throw new HttpError(409, 'attachment_unavailable', 'The stored attachment is unavailable.');
  }
  return { ...metadata(row), content };
}

export function customFieldAttachmentHeaders(file, { view = false } = {}) {
  const inline = view && ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf'].includes(file.mediaType);
  const fallback = file.originalName.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  const encodedName = encodeURIComponent(file.originalName).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return { 'Content-Type': file.mediaType, 'Content-Length': String(file.byteLength),
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${fallback}"; filename*=UTF-8''${encodedName}`,
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'X-Attachment-SHA256': file.sha256,
    'Content-Security-Policy': "default-src 'none'; sandbox", 'Cross-Origin-Resource-Policy': 'same-origin' };
}
