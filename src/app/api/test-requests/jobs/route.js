import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { createTestRequestJobs } from '@/test-requests/jobs.js';

export const POST = endpoint(async (request) => {
  const input = await readInput(request, { maxBytes: 32_768 });
  return json(await authenticated(request, (client, identity) => createTestRequestJobs(client, identity, input), { permission: 'test_requests.allocate' }), 201);
});
