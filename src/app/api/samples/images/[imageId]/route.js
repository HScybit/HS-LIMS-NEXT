import { authenticated, endpoint } from '@/auth/http.js';
import { customFieldAttachmentHeaders } from '@/custom-fields/attachments.js';
import { readSampleImage } from '@/samples/images.js';

export const GET = endpoint(async (request, context) => {
  const { imageId } = await context.params;
  const file = await authenticated(request, (client, identity) => readSampleImage(client, identity, imageId), { readOnly: true });
  return new Response(file.content, { headers: customFieldAttachmentHeaders(file, { view: true }) });
});
