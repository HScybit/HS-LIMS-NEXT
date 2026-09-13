import { HttpError } from '../auth/errors.js';
import { customFieldAttachmentByteLimit, customFieldAttachmentMetadata } from './attachments.js';

export async function readCustomFieldAttachmentUpload(request) {
  let originalName;
  try { originalName = decodeURIComponent(request.headers.get('x-file-name') ?? ''); }
  catch { throw new HttpError(400, 'invalid_attachment_name', 'The attachment filename is invalid.'); }
  const details = customFieldAttachmentMetadata(originalName, request.headers.get('content-type')?.split(';')[0]);
  const length = request.headers.get('content-length');
  if (length !== null && !/^\d+$/.test(length)) throw new HttpError(400, 'invalid_attachment_length', 'The attachment length is invalid.');
  if (length !== null && Number(length) > customFieldAttachmentByteLimit) throw new HttpError(413, 'attachment_size_limit', 'Attachments can be at most 20 MiB.');
  const reader = request.body?.getReader();
  const chunks = []; let size = 0;
  try {
    if (reader) while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > customFieldAttachmentByteLimit) {
        await reader.cancel().catch(() => {});
        throw new HttpError(413, 'attachment_size_limit', 'Attachments can be at most 20 MiB.');
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'incomplete_attachment', 'The attachment upload did not finish. Please try again.');
  } finally { reader?.releaseLock(); }
  if (length !== null && size !== Number(length)) throw new HttpError(400, 'incomplete_attachment', 'The attachment upload did not finish. Please try again.');
  return { requestId: request.headers.get('x-upload-request-id'), fieldId: request.headers.get('x-custom-field-id'),
    fieldRevision: Number(request.headers.get('x-custom-field-revision')), ...details, content: Buffer.concat(chunks, size) };
}
