import { authenticated, endpoint, json } from '@/auth/http.js';
import { instrumentOverview } from '@/instruments/list.js';

export const GET = endpoint(async request => json(await authenticated(request, (client, identity) =>
  instrumentOverview(client, identity, Object.fromEntries(request.nextUrl.searchParams)), { readOnly: true })));
