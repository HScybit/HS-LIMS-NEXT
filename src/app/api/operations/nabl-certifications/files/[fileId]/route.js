import { authenticated, endpoint } from '@/auth/http.js';
import { readNablFile } from '@/compliance/nabl-files.js';
import { customFieldAttachmentHeaders } from '@/custom-fields/attachments.js';

export const GET = endpoint(async (request, { params }) => {
  const { fileId } = await params;
  const file = await authenticated(request, (client, identity) => readNablFile(client, identity, fileId), { readOnly: true });
  return new Response(file.content, { headers: customFieldAttachmentHeaders(file, { view: request.nextUrl.searchParams.get('view') === '1' }) });
});
