import { authenticated, endpoint, json } from '@/auth/http.js';
import { reportOptions } from '@/reports/service.js';

export const GET = endpoint(async (request, context) => {
  const { sampleId } = await context.params;
  return json(await authenticated(request, (client, identity) => reportOptions(client, identity, sampleId), { readOnly: true }));
});
