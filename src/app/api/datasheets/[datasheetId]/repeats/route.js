import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { datasheetRecord } from '@/datasheets/service.js';
import { fieldsOnly } from '@/templates/input.js';
import { changeRepeat } from '@/templates/capture.js';
import { datasheetCaptureView } from '@/datasheets/transport.js';

export const POST = endpoint(async (request, context) => {
  const { datasheetId } = await context.params;
  const input = await readInput(request); fieldsOnly(input, ['revision', 'command']);
  const result = await authenticated(request, async (client, identity) => {
    const sheet = await datasheetRecord(client, identity, datasheetId);
    return changeRepeat(client, identity, sheet.templateInstanceId, input.revision, input.command);
  }, { permission: 'datasheets.execute' });
  return json(datasheetCaptureView(result));
});
