import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { loadNablCertification, retireNablCertification } from '@/compliance/nabl.js';
import { fieldsOnly } from '@/templates/input.js';

export const GET = endpoint(async (request, { params }) => {
  const { certificationId } = await params; const revision = request.nextUrl.searchParams.get('revision');
  const options = { ...(revision === null ? {} : { atRevision: Number(revision) }), forEdit: request.nextUrl.searchParams.get('editing') === '1' };
  return json(await authenticated(request, (client, identity) => loadNablCertification(client, identity, certificationId, options), { readOnly: true }));
});
export const DELETE = endpoint(async (request, { params }) => {
  const { certificationId } = await params; const input = await readInput(request); fieldsOnly(input, ['revision', 'requestId']);
  return json(await authenticated(request, (client, identity) => retireNablCertification(client, identity, { ...input, id: certificationId }), { permission: 'compliance.manage' }));
});
