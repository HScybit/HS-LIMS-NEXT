import { HttpError } from '../auth/errors.js';
import { templateImageByteLimit } from './images.js';

export async function readTemplateImageUpload(request) {
  let originalName;
  try { originalName = decodeURIComponent(request.headers.get('x-file-name') ?? ''); }
  catch { throw new HttpError(400, 'invalid_image_name', 'The image filename is invalid.'); }
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > templateImageByteLimit)) throw new HttpError(413, 'template_image_size_limit', 'Template images can be at most 10 MiB.');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(422, 'empty_template_image', 'Select a non-empty image.');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > templateImageByteLimit) { await reader.cancel(); throw new HttpError(413, 'template_image_size_limit', 'Template images can be at most 10 MiB.'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return { requestId: request.headers.get('x-upload-request-id'), originalName,
    mediaType: request.headers.get('content-type')?.split(';')[0].trim().toLowerCase(), content: Buffer.concat(chunks, size) };
}
