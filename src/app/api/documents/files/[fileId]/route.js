import { authenticated, endpoint } from '@/auth/http.js';
import { readDocumentFile } from '@/documents/service.js';
import { customFieldAttachmentHeaders } from '@/custom-fields/attachments.js';

export const GET = endpoint(async (request, context) => {
  const { fileId } = await context.params;
  const file = await authenticated(request, (client, identity) => readDocumentFile(client, identity, fileId), { readOnly: true });
  return new Response(file.content, { headers: customFieldAttachmentHeaders(file, { view: new URL(request.url).searchParams.get('view') === '1' }) });
});
