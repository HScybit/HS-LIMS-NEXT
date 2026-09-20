import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { resolveInstrumentBreakdownLog } from '@/equipment-logs/service.js';

export const POST = endpoint(async (request, context) => {
  const { instrumentId, breakdownId } = await context.params; const input = await readInput(request);
  return json(await authenticated(request, (client, identity) => resolveInstrumentBreakdownLog(client, identity, instrumentId, breakdownId, input)));
});
