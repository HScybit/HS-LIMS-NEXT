import { authenticated, endpoint, json } from '@/auth/http.js';
import { sampleRegistrationOptions } from '@/samples/options.js';

export const GET = endpoint(async (request) => json(await authenticated(request,
  (client, identity) => sampleRegistrationOptions(client, identity), { readOnly: true })));
