import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { getUserCertification, updateUserCertification } from '@/training/service.js';

export const GET = endpoint(async (request, context) => {
  const { certificationId } = await context.params;
  return json(await authenticated(request, (client, identity) => getUserCertification(client, identity, certificationId), { readOnly: true }));
});

export const PATCH = endpoint(async (request, context) => {
  const { certificationId } = await context.params; const input = await readInput(request);
  return json(await authenticated(request, (client, identity) => updateUserCertification(client, identity, certificationId, input)));
});
