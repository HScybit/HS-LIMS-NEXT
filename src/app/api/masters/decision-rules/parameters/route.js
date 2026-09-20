import { authenticated, endpoint, json } from '@/auth/http.js';
import { decisionRuleParameterOptions } from '@/masters/decision-rules.js';

export const GET = endpoint(async request => {
  const search = request.nextUrl.searchParams.get('search') || '';
  return json(await authenticated(request, (client, identity) => decisionRuleParameterOptions(client, identity, { search }), { readOnly: true }));
});
