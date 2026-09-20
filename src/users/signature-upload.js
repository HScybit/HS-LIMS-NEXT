import { HttpError } from '../auth/errors.js';
import { userSignatureByteLimit, userSignatureRemovalInput } from './signature-input.js';
import { customFieldAttachmentMetadata } from '../custom-fields/attachments.js';

export async function readUserSignatureUpload(request) {
  const revision = request.headers.get('x-signature-revision');
  if (revision === null || !/^(0|[1-9]\d*)$/.test(revision)) throw new HttpError(400, 'invalid_signature_revision', 'Provide the current signature revision.');
  const identity = userSignatureRemovalInput({ requestId: request.headers.get('x-upload-request-id'), revision: Number(revision) });
  let originalName;
  try { originalName = decodeURIComponent(request.headers.get('x-file-name') ?? ''); }
  catch { throw new HttpError(400, 'invalid_signature_name', 'The signature filename is invalid.'); }
  const metadata = customFieldAttachmentMetadata(originalName, request.headers.get('content-type')?.split(';')[0]);
  const length = request.headers.get('content-length');
  if (length !== null && !/^\d+$/.test(length)) throw new HttpError(400, 'invalid_signature_length', 'The signature file length is invalid.');
  if (length !== null && Number(length) > userSignatureByteLimit) throw new HttpError(413, 'signature_size_limit', 'Signature files can be at most 20 MiB.');
  const reader = request.body?.getReader(); const chunks = []; let size = 0;
  try {
    if (reader) while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > userSignatureByteLimit) {
        await reader.cancel().catch(() => {});
        throw new HttpError(413, 'signature_size_limit', 'Signature files can be at most 20 MiB.');
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'incomplete_signature_file', 'The signature upload did not finish. Please try again.');
  } finally { reader?.releaseLock(); }
  if (length !== null && size !== Number(length)) throw new HttpError(400, 'incomplete_signature_file', 'The signature upload did not finish. Please try again.');
  return { ...identity, ...metadata, content: Buffer.concat(chunks, size) };
}
