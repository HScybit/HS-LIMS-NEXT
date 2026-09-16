import { authenticated, endpoint, json } from '@/auth/http.js';
import { moduleAccessOptions } from '@/organization-settings/module-access.js';

export const GET = endpoint(async request => {
  const input = Object.fromEntries(new URL(request.url).searchParams);
  if (input.page !== undefined) input.page = Number(input.page);
  return json(await authenticated(request, (client, identity) => moduleAccessOptions(client, identity, input), { readOnly: true }));
});
