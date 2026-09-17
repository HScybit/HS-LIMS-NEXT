import { authenticated, endpoint } from '@/auth/http.js';
import { customFieldAttachmentHeaders } from '@/custom-fields/attachments.js';
import { readServiceAgreementFile } from '@/masters/service-agreement-files.js';

export const GET = endpoint(async (request, context) => {
  const { fileId } = await context.params;
  const file = await authenticated(request, (client, identity) => readServiceAgreementFile(client, identity, fileId), { readOnly: true });
  return new Response(file.content, { headers: customFieldAttachmentHeaders(file, { view: request.nextUrl.searchParams.get('view') === '1' }) });
});
