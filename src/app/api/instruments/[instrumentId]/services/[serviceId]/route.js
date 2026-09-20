import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { updateInstrumentServiceLog } from '@/equipment-logs/service.js';

export const PATCH = endpoint(async (request, context) => {
  const { instrumentId, serviceId } = await context.params; const input = await readInput(request);
  return json(await authenticated(request, (client, identity) => updateInstrumentServiceLog(client, identity, instrumentId, serviceId, input)));
});
