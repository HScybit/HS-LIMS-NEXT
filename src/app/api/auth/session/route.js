import { authenticated, endpoint, json } from '@/auth/http.js';
import { publicIdentity } from '@/auth/service.js';

export const GET = endpoint((request) => authenticated(request,
  (_client, identity) => json({ identity: publicIdentity(identity) }),
  { readOnly: true, accountAction: true },
));
