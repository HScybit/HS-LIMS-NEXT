import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { loadServiceAgreement, retireServiceAgreement } from '@/masters/service-agreements.js';
import { fieldsOnly } from '@/templates/input.js';

export const GET = endpoint(async (request, context) => {
  const { agreementId } = await context.params; const revision = request.nextUrl.searchParams.get('revision');
  return json(await authenticated(request, (client, identity) => loadServiceAgreement(client, identity, agreementId,
    revision === null ? {} : { atRevision: Number(revision) }), { readOnly: true }));
});

export const DELETE = endpoint(async (request, context) => {
  const { agreementId } = await context.params; const input = await readInput(request); fieldsOnly(input, ['revision', 'requestId']);
  return json(await authenticated(request, (client, identity) => retireServiceAgreement(client, identity, { ...input, id: agreementId }), { permission: 'masters.manage' }));
});
