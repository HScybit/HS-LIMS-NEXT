import { authenticated, endpoint } from '@/auth/http.js';
import { customFieldAttachmentHeaders } from '@/custom-fields/attachments.js';
import { readInstrumentFieldAttachment } from '@/instruments/custom-field-attachments.js';

export const GET = endpoint(async (request, context) => {
  const { attachmentId } = await context.params;
  const file = await authenticated(request, (client, identity) => readInstrumentFieldAttachment(client, identity, attachmentId), { readOnly: true });
  return new Response(file.content, { headers: customFieldAttachmentHeaders(file, { view: request.nextUrl.searchParams.get('view') === '1' }) });
});
