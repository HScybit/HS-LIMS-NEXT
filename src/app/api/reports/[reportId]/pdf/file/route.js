import { authenticated, endpoint } from '@/auth/http.js';
import { reportPdfFile } from '@/reports/jobs.js';

export const GET = endpoint(async (request, context) => {
  const { reportId } = await context.params;
  const file = await authenticated(request, (client, identity) => reportPdfFile(client, identity, reportId), { readOnly: true });
  return new Response(file.content, { headers: {
    'Content-Type': file.contentType, 'Content-Length': String(file.byteLength), 'Content-Disposition': `inline; filename="${file.filename}"`,
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'X-Report-SHA256': file.checksum,
  } });
});
