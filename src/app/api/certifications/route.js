import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { listUserCertifications, createUserCertification } from '@/training/service.js';

export const GET = endpoint(async (request) => {
  const userId = request.nextUrl.searchParams.get('userId') ?? undefined;
  return json(await authenticated(request, (client, identity) => listUserCertifications(client, identity, { userId }), { readOnly: true }));
});

export const POST = endpoint(async (request) => {
  const input = await readInput(request);
  return json(await authenticated(request, (client, identity) => createUserCertification(client, identity, input)), 201);
});
