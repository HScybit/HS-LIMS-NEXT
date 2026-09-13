import { authenticated, endpoint } from '@/auth/http.js';
import { readCustomFieldAttachment, customFieldAttachmentHeaders } from '@/custom-fields/attachments.js';

export const GET = endpoint(async (request, context) => {
  const { attachmentId } = await context.params;
  const file = await authenticated(request, (client, identity) => readCustomFieldAttachment(client, identity, attachmentId), { readOnly: true });
  return new Response(file.content, { headers: customFieldAttachmentHeaders(file, { view: new URL(request.url).searchParams.get('view') === '1' }) });
});
