import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { loadUserProfile, updateUserProfile } from '@/users/profiles.js';

export const GET = endpoint(async (request, context) => {
  const { userId } = await context.params; const revision = request.nextUrl.searchParams.get('revision');
  return json(await authenticated(request, (client, identity) => loadUserProfile(client, identity, userId,
    revision === null ? {} : { atRevision: Number(revision) }), { readOnly: true }));
});

export const PATCH = endpoint(async (request, context) => {
  const { userId } = await context.params; const input = await readInput(request);
  return json(await authenticated(request, (client, identity) => updateUserProfile(client, identity, userId, input), { permission: 'users.manage' }));
});
