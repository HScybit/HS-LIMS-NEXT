import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { generateUserCustomFields } from '@/users/custom-field-generation.js';

export const POST = endpoint(async request => {
  const input = await readInput(request, { maxBytes: 8 * 1_048_576 });
  return json(await authenticated(request, (client, identity) => generateUserCustomFields(client, identity, input), { permission: 'users.manage', readOnly: true }));
});
