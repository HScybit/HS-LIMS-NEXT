import { authenticated, endpoint } from '@/auth/http.js';
import { readOrganizationLogo } from '@/organization-settings/logo.js';
import { customFieldAttachmentHeaders } from '@/custom-fields/attachments.js';

export const GET = endpoint(async (request, { params }) => {
  const { fileId } = await params;
  const file = await authenticated(request, (client, identity) => readOrganizationLogo(client, identity, fileId), { readOnly: true });
  return new Response(file.content, { headers: customFieldAttachmentHeaders(file, { view: true }) });
});
