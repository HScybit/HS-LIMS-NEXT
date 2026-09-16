import { authenticated, endpoint, json } from '@/auth/http.js';
import { readNablUpload, uploadNablFile } from '@/compliance/nabl-files.js';

export const POST = endpoint(async request => {
  const result = await authenticated(request, async (client, identity) => uploadNablFile(client, identity, await readNablUpload(request)), { permission: 'compliance.manage' });
  return json(result, result.replayed ? 200 : 201);
});
