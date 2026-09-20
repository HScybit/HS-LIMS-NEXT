import { authenticated, endpoint, json } from '@/auth/http.js';
import { loadReport } from '@/reports/service.js';
import { currentRendererId } from '@/reports/renderer.js';

export const GET = endpoint(async (request, context) => {
  const { reportId } = await context.params;
  const report = await authenticated(request, (client, identity) => loadReport(client, identity, reportId), { readOnly: true });
  return json({ ...report, rendererId: await currentRendererId() });
});
