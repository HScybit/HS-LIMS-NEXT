import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { serviceAgreementOptions } from '@/masters/service-agreement-options.js';

export const POST = endpoint(async request => {
  const input = await readInput(request, { maxBytes: 64 * 1024 });
  return json(await authenticated(request, (client, identity) => serviceAgreementOptions(client, identity, input), { readOnly: true }));
});
