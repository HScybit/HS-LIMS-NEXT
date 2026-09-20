import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { loadDecisionRule, retireDecisionRule } from '@/masters/decision-rules.js';
import { fieldsOnly } from '@/templates/input.js';

export const GET = endpoint(async (request, context) => {
  const { ruleId } = await context.params; const revision = request.nextUrl.searchParams.get('revision');
  return json(await authenticated(request, (client, identity) => loadDecisionRule(client, identity, ruleId,
    revision === null ? {} : { atRevision: Number(revision) }), { readOnly: true }));
});

export const DELETE = endpoint(async (request, context) => {
  const { ruleId } = await context.params; const input = await readInput(request);
  fieldsOnly(input, ['revision', 'requestId']);
  return json(await authenticated(request, (client, identity) => retireDecisionRule(client, identity, { ...input, id: ruleId }), { permission: 'masters.manage' }));
});
