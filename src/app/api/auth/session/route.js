import { authenticated, endpoint, json } from '@/auth/http.js';
import { publicIdentity } from '@/auth/service.js';

export const GET = endpoint((request) => authenticated(request,
  async (client, identity) => json({ identity: await publicIdentity(client, identity) }),
  { readOnly: true, accountAction: true },
));
