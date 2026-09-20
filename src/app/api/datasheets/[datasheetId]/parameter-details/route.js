import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { datasheetRecord } from '@/datasheets/service.js';
import { refreshParameterDetails } from '@/templates/capture.js';
import { datasheetCaptureView } from '@/datasheets/transport.js';

export const POST = endpoint(async (request, context) => {
  const { datasheetId } = await context.params;
  const input = await readInput(request);
  const result = await authenticated(request, async (client, identity) => {
    const sheet = await datasheetRecord(client, identity, datasheetId);
    return refreshParameterDetails(client, identity, sheet.templateInstanceId, input);
  }, { permission: 'datasheets.execute' });
  return json(datasheetCaptureView(result));
});
