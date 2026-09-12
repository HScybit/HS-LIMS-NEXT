import { authenticated, endpoint, json } from '@/auth/http.js';
import { enqueueReportPdf, reportPdfStatus } from '@/reports/jobs.js';

export const GET = endpoint(async (request, context) => {
  const { reportId } = await context.params;
  return json(await authenticated(request, (client, identity) => reportPdfStatus(client, identity, reportId), { readOnly: true }));
});

export const POST = endpoint(async (request, context) => {
  const { reportId } = await context.params;
  const result = await authenticated(request, (client, identity) => enqueueReportPdf(client, identity, reportId));
  return json(result, result.job.status === 'succeeded' ? 200 : 202);
});
