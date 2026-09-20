import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { loadLaboratory, retireLaboratory } from '@/masters/laboratories.js';
import { fieldsOnly } from '@/templates/input.js';

export const GET = endpoint(async (request, { params }) => {
  const { laboratoryId } = await params;
  const rawRevision = request.nextUrl.searchParams.get('revision');
  const options = rawRevision === null ? {} : { atRevision: Number(rawRevision) };
  return json(await authenticated(request, (client, identity) => loadLaboratory(client, identity, laboratoryId, options), { readOnly: true }));
});

export const DELETE = endpoint(async (request, { params }) => {
  const { laboratoryId } = await params; const input = await readInput(request);
  fieldsOnly(input, ['revision', 'requestId']);
  return json(await authenticated(request, (client, identity) => retireLaboratory(client, identity, { ...input, id: laboratoryId }), { permission: 'users.manage' }));
});
