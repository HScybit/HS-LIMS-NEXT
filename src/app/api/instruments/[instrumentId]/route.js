import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { loadInstrumentCore, retireInstrumentCore } from '@/instruments/core.js';
import { fieldsOnly } from '@/templates/input.js';

export const GET = endpoint(async (request, context) => {
  const { instrumentId } = await context.params;
  const revision = request.nextUrl.searchParams.get('revision');
  return json(await authenticated(request, (client, identity) => loadInstrumentCore(client, identity, instrumentId,
    revision === null ? {} : { atRevision: Number(revision) }), { readOnly: true }));
});

export const DELETE = endpoint(async (request, context) => {
  const { instrumentId } = await context.params; const input = await readInput(request);
  fieldsOnly(input, ['revision', 'requestId']);
  return json(await authenticated(request, (client, identity) => retireInstrumentCore(client, identity, { ...input, id: instrumentId }), { permission: 'instruments.manage' }));
});
