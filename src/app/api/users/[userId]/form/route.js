import { authenticated, endpoint, json } from '@/auth/http.js';
import { loadUserForm } from '@/users/forms.js';

export const GET = endpoint(async (request, context) => {
  const { userId } = await context.params;
  return json(await authenticated(request, (client, identity) => loadUserForm(client, identity, userId), { readOnly: true }));
});
