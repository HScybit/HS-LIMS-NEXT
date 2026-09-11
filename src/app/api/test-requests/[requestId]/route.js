import { authenticated, endpoint, json } from '@/auth/http.js';
import { loadTestRequest } from '@/test-requests/load.js';

export const GET = endpoint(async (request, context) => {
  const { requestId } = await context.params;
  return json(await authenticated(request, (client, identity) => loadTestRequest(client, identity, requestId, request.nextUrl.searchParams.get('sampleId')), { readOnly: true }));
});
