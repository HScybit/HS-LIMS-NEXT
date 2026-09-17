import { authenticated, endpoint, json } from '@/auth/http.js';
import { requirePermission } from '@/templates/input.js';
import { readServiceAgreementUpload, uploadServiceAgreementFile } from '@/masters/service-agreement-files.js';

export const POST = endpoint(async request => {
  const result = await authenticated(request, async (client, identity) => {
    requirePermission(identity, 'masters.manage');
    return uploadServiceAgreementFile(client, identity, await readServiceAgreementUpload(request));
  });
  return json(result, result.replayed ? 200 : 201);
});
