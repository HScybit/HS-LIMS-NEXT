import { createHash } from 'node:crypto';
import { HttpError } from '../auth/errors.js';
import { fieldsOnly, integer, uuid } from '../templates/input.js';
import { customFieldAttachmentMetadata } from '../custom-fields/attachments.js';

export const userSignatureByteLimit = 20 * 1024 * 1024;

function changeIdentity(value) {
  return { requestId: uuid(value.requestId, 'Save request').toLowerCase(), revision: integer(value.revision, 'Signature revision', 0, 2_147_483_646) };
}

export function userSignatureRemovalInput(value) {
  fieldsOnly(value, ['requestId', 'revision']);
  return changeIdentity(value);
}

export function userSignatureUploadInput(value) {
  fieldsOnly(value, ['requestId', 'revision', 'originalName', 'mediaType', 'content']);
  const identity = changeIdentity(value);
  // Both source fields use the same project-file basename and MIME contract.
  const metadata = customFieldAttachmentMetadata(value.originalName, value.mediaType);
  if (!Buffer.isBuffer(value.content)) throw new HttpError(400, 'invalid_signature_file', 'Signature file content is required.');
  if (value.content.length > userSignatureByteLimit) throw new HttpError(413, 'signature_size_limit', 'Signature files can be at most 20 MiB.');
  return { ...identity, ...metadata, content: value.content, byteLength: value.content.length,
    sha256: createHash('sha256').update(value.content).digest('hex') };
}
