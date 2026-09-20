import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { loadUserSignature, uploadUserSignature, removeUserSignature } from '@/users/signatures.js';
import { readUserSignatureUpload } from '@/users/signature-upload.js';

export const GET = endpoint(async (request, context) => {
  const { userId } = await context.params;
  return json(await authenticated(request, (client, identity) => loadUserSignature(client, identity, userId), { readOnly: true }));
});
export const POST = endpoint(async (request, context) => {
  const { userId } = await context.params;
  return json(await authenticated(request, async (client, identity) => uploadUserSignature(client, identity, userId, await readUserSignatureUpload(request)), { permission: 'users.manage' }), 201);
});
export const DELETE = endpoint(async (request, context) => {
  const { userId } = await context.params; const input = await readInput(request);
  return json(await authenticated(request, (client, identity) => removeUserSignature(client, identity, userId, input), { permission: 'users.manage' }));
});
