import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { verifyMfaSetup } from '@/auth/mfa.js';

export const POST = endpoint(async (request) => {
  const input = await readInput(request);
  const result = await authenticated(request, (client, identity) => verifyMfaSetup(client, identity, input), { accountAction: true });
  // Throw only after COMMIT: failed codes must consume their verification attempts.
  if (result.error) throw result.error;
  return json(result);
});
