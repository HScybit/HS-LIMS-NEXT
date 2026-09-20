import { authenticated, endpoint } from '@/auth/http.js';
import { customFieldAttachmentHeaders } from '@/custom-fields/attachments.js';
import { readUserFieldAttachment } from '@/users/custom-field-attachments.js';

export const GET = endpoint(async (request, context) => {
  const { attachmentId } = await context.params;
  const file = await authenticated(request, (client, identity) => readUserFieldAttachment(client, identity, attachmentId), { readOnly: true });
  return new Response(file.content, { headers: customFieldAttachmentHeaders(file, { view: request.nextUrl.searchParams.get('view') === '1' }) });
});
