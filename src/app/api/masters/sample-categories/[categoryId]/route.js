import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { loadSampleCategory, retireSampleCategory } from '@/masters/sample-categories.js';
import { fieldsOnly } from '@/templates/input.js';

export const GET = endpoint(async (request, context) => {
  const { categoryId } = await context.params; const revision = request.nextUrl.searchParams.get('revision');
  return json(await authenticated(request, (client, identity) => loadSampleCategory(client, identity, categoryId,
    revision === null ? {} : { atRevision: Number(revision) }), { readOnly: true }));
});

export const DELETE = endpoint(async (request, context) => {
  const { categoryId } = await context.params; const input = await readInput(request);
  fieldsOnly(input, ['revision', 'requestId']);
  return json(await authenticated(request, (client, identity) => retireSampleCategory(client, identity, { ...input, id: categoryId }), { permission: 'masters.manage' }));
});
