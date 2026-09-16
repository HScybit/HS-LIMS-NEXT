import { authenticated, endpoint, json } from '@/auth/http.js';
import { loadBusinessUnit } from '@/masters/business-units.js';

export const GET = endpoint(async (request, { params }) => {
  const { unitId } = await params;
  const rawRevision = request.nextUrl.searchParams.get('revision');
  const options = rawRevision === null ? {} : { atRevision: Number(rawRevision) };
  return json(await authenticated(request, (client, identity) => loadBusinessUnit(client, identity, unitId, options), { readOnly: true }));
});
