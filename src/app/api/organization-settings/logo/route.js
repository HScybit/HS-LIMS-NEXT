import { authenticated, endpoint, json } from '@/auth/http.js';
import { readLogoUpload, uploadOrganizationLogo } from '@/organization-settings/logo.js';

export const PUT = endpoint(async (request) => {
  const upload = await readLogoUpload(request);
  const result = await authenticated(request, (client, identity) => uploadOrganizationLogo(client, identity, upload), { permission: 'settings.manage' });
  return json(result, 200);
});
