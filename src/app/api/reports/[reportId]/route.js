import { authenticated, endpoint, json } from '@/auth/http.js';
import { loadReport } from '@/reports/service.js';

export const GET = endpoint(async (request, context) => {
  const { reportId } = await context.params;
  return json(await authenticated(request, (client, identity) => loadReport(client, identity, reportId), { readOnly: true }));
});
