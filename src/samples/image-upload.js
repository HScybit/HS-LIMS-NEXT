import { HttpError } from '../auth/errors.js';
import { sampleImageByteLimit } from './images.js';

export async function readSampleImageUpload(request) {
  let originalName;
  try { originalName = decodeURIComponent(request.headers.get('x-file-name') ?? ''); }
  catch { throw new HttpError(400, 'invalid_image_name', 'The image filename is invalid.'); }
  const length = request.headers.get('content-length');
  if (length !== null && !/^\d+$/.test(length)) throw new HttpError(400, 'invalid_image_length', 'The image length is invalid.');
  if (length !== null && Number(length) > sampleImageByteLimit) throw new HttpError(413, 'sample_image_size_limit', 'Sample images can be at most 10 MiB.');
  const reader = request.body?.getReader(); const chunks = []; let size = 0;
  try {
    if (reader) while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > sampleImageByteLimit) {
        await reader.cancel().catch(() => {});
        throw new HttpError(413, 'sample_image_size_limit', 'Sample images can be at most 10 MiB.');
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'incomplete_image', 'The image upload did not finish. Please try again.');
  } finally { reader?.releaseLock(); }
  if (length !== null && Number(length) !== size) throw new HttpError(400, 'incomplete_image', 'The image upload did not finish. Please try again.');
  return { requestId: request.headers.get('x-upload-request-id'), originalName,
    mediaType: request.headers.get('content-type')?.split(';')[0].trim().toLowerCase(), content: Buffer.concat(chunks, size) };
}
