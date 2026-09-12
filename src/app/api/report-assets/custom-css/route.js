import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { loadCustomCss, saveCustomCss } from '@/report-assets/custom-css.js';

export const GET = endpoint(async (request) => json(await authenticated(request,
  (client, identity) => loadCustomCss(client, identity), { readOnly: true })));

export const PUT = endpoint(async (request) => {
  const input = await readInput(request, { maxBytes: 4_100_000 });
  return json(await authenticated(request, (client, identity) => saveCustomCss(client, identity, input)));
});
