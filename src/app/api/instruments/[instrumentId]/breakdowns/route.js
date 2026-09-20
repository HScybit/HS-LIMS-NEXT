import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { listInstrumentBreakdownLogs, createInstrumentBreakdownLog } from '@/equipment-logs/service.js';

export const GET = endpoint(async (request, context) => {
  const { instrumentId } = await context.params;
  return json(await authenticated(request, (client, identity) => listInstrumentBreakdownLogs(client, identity, instrumentId), { readOnly: true }));
});

export const POST = endpoint(async (request, context) => {
  const { instrumentId } = await context.params; const input = await readInput(request);
  return json(await authenticated(request, (client, identity) => createInstrumentBreakdownLog(client, identity, instrumentId, input)), 201);
});
