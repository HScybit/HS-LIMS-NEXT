import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { datasheetRecord } from '@/datasheets/service.js';
import { fieldsOnly } from '@/templates/input.js';
import { recalculateCapture } from '@/templates/capture.js';
import { datasheetCaptureView } from '@/datasheets/transport.js';

export const POST = endpoint(async (request, context) => {
  const { datasheetId } = await context.params;
  const input = await readInput(request); fieldsOnly(input, ['revision']);
  const result = await authenticated(request, async (client, identity) => {
    const sheet = await datasheetRecord(client, identity, datasheetId);
    return recalculateCapture(client, identity, sheet.templateInstanceId, input.revision);
  }, { permission: 'datasheets.execute' });
  return json(datasheetCaptureView(result));
});
