import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { loadLaboratorySettings, saveLaboratorySettings } from '@/organization-settings/service.js';

export const GET = endpoint(async (request) => json(await authenticated(request, loadLaboratorySettings, { readOnly: true })));
export const PUT = endpoint(async (request) => {
  const input = await readInput(request);
  return json(await authenticated(request, (client, identity) => saveLaboratorySettings(client, identity, input), { permission: 'settings.manage' }));
});
