import { createHash } from 'node:crypto';
import { HttpError } from '../auth/errors.js';
import { fieldsOnly, integer, requirePermission, uuid } from '../templates/input.js';
import { customFieldAttachmentHeaders } from '../custom-fields/attachments.js';
import { userSignatureRemovalInput, userSignatureUploadInput } from './signature-input.js';
import { userProfileCommandError } from './profiles.js';

function requireRead(identity) {
  if (!identity.permission_codes?.some((permission) => ['users.read', 'users.manage'].includes(permission))) throw new HttpError(403, 'forbidden', 'You cannot view user signatures.');
}
const errors = {
  user_signature_invalid_input: [400, 'invalid_signature_file', 'The signature change is invalid.'],
  user_signature_payload: [400, 'invalid_signature_file', 'The signature file is invalid.'],
  user_signature_request_reused: [409, 'save_request_reused', 'This request was already used for a different signature change.'],
  user_signature_stale: [409, 'stale_user_signature', 'This signature changed in another session. Reload before saving.'],
  user_signature_empty: [409, 'user_signature_empty', 'This membership has no signature file to remove.'],
};
const fileUrl = (id) => `/api/users/signature-files/${id}`;
const fileMetadata = (row) => row.operation === 'upload' ? { id: row.fileId, originalName: row.originalName,
  mediaType: row.mediaType, byteLength: row.byteLength, sha256: row.sha256, url: fileUrl(row.fileId) } : null;
const fileColumns = `version.operation,version.request_id AS "fileId",version.original_name AS "originalName",version.media_type AS "mediaType",version.byte_length AS "byteLength",version.sha256`;

async function writeSignature(client, identity, userId, input, operation) {
  requirePermission(identity, 'users.manage'); const id = uuid(userId, 'User').toLowerCase();
  try {
    const result = await client.query('SELECT users_write_signature($1,$2,$3,$4,$5,$6,$7,$8,$9) AS revision',
      [id, input.revision, input.requestId, operation, input.originalName ?? null, input.mediaType ?? null, input.content ?? null, input.byteLength ?? null, input.sha256 ?? null]);
    return { id, revision: result.rows[0].revision, fileId: operation === 'upload' ? input.requestId : null };
  } catch (error) {
    if (errors[error.constraint]) throw new HttpError(...errors[error.constraint]);
    throw userProfileCommandError(error);
  }
}

export function uploadUserSignature(client, identity, userId, value) {
  requirePermission(identity, 'users.manage');
  return writeSignature(client, identity, userId, userSignatureUploadInput(value), 'upload');
}
export function removeUserSignature(client, identity, userId, value) {
  requirePermission(identity, 'users.manage');
  return writeSignature(client, identity, userId, userSignatureRemovalInput(value), 'remove');
}

export async function loadUserSignature(client, identity, userId) {
  requireRead(identity); const id = uuid(userId, 'User').toLowerCase();
  const result = await client.query(`SELECT head.user_id AS id,head.revision,${fileColumns}
    FROM user_signature_heads head LEFT JOIN user_signature_history version ON version.organization_id=head.organization_id AND version.user_id=head.user_id AND version.revision=head.revision
    WHERE head.organization_id=$1 AND head.user_id=$2`, [identity.organization_id, id]);
  if (!result.rowCount) throw new HttpError(404, 'user_not_found', 'User was not found.');
  const row = result.rows[0]; return { id: row.id, revision: row.revision, file: fileMetadata(row) };
}

export async function loadUserSignatureHistory(client, identity, userId, value = {}) {
  requireRead(identity); const id = uuid(userId, 'User').toLowerCase(); fieldsOnly(value, ['limit', 'beforeRevision']);
  const limit = value.limit === undefined ? 25 : integer(value.limit, 'History page size', 1, 100);
  const before = value.beforeRevision === undefined ? null : integer(value.beforeRevision, 'History cursor', 1, 2_147_483_647);
  const member = await client.query('SELECT 1 FROM user_signature_heads WHERE organization_id=$1 AND user_id=$2', [identity.organization_id, id]);
  if (!member.rowCount) throw new HttpError(404, 'user_not_found', 'User was not found.');
  const result = await client.query(`SELECT version.revision,version.previous_revision AS "previousRevision",${fileColumns},version.username,version.display_name AS "displayName",
    version.saved_by AS "savedBy",version.saved_by_username AS "savedByUsername",version.saved_by_name AS "savedByName",version.saved_at AS "savedAt"
    FROM user_signature_history version WHERE version.organization_id=$1 AND version.user_id=$2 AND ($3::integer IS NULL OR version.revision<$3) ORDER BY version.revision DESC LIMIT $4`,
  [identity.organization_id, id, before, limit + 1]);
  const rows = result.rows.slice(0, limit).map((row) => {
    const { fileId, originalName, mediaType, byteLength, sha256, ...version } = row;
    return { ...version, file: fileMetadata({ operation: version.operation, fileId, originalName, mediaType, byteLength, sha256 }) };
  });
  return { rows, nextBeforeRevision: result.rows.length > limit ? rows.at(-1).revision : null };
}

export async function readUserSignatureFile(client, identity, fileId) {
  requireRead(identity); const id = uuid(fileId, 'Signature file').toLowerCase();
  const result = await client.query(`SELECT id,user_id AS "userId",revision,original_name AS "originalName",media_type AS "mediaType",byte_length AS "byteLength",sha256,encode(content,'base64') AS "encodedContent"
    FROM user_signature_files WHERE organization_id=$1 AND id=$2`, [identity.organization_id, id]);
  if (!result.rowCount) throw new HttpError(404, 'signature_file_not_found', 'Signature file was not found.');
  const { encodedContent, ...row } = result.rows[0]; const content = typeof encodedContent === 'string' ? Buffer.from(encodedContent, 'base64') : null;
  if (!content || content.length !== row.byteLength || createHash('sha256').update(content).digest('hex') !== row.sha256) {
    throw new HttpError(409, 'signature_file_unavailable', 'The stored signature file is unavailable.');
  }
  return { ...row, url: fileUrl(row.id), content };
}

// Preserve all original file types as downloads. Image previews/report rendering have a separate validation boundary.
export const userSignatureFileHeaders = (file) => customFieldAttachmentHeaders(file);
