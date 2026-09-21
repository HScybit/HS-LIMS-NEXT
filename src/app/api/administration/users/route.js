import { authenticated, endpoint, json } from '@/auth/http.js';
import { listPlatformUsers } from '@/administration/platform-users.js';

export const GET = endpoint(async (request) => {
  const parameters = request.nextUrl.searchParams;
  const input = { search: parameters.get('search') ?? '',
    page: Number(parameters.get('page') ?? 1), pageSize: Number(parameters.get('pageSize') ?? 25) };
  return json(await authenticated(request, (client, identity) => listPlatformUsers(client, identity, input), { readOnly: true }));
});
