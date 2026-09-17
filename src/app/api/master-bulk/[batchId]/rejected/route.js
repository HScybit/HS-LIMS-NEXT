import { authenticated, endpoint } from '@/auth/http.js';
import { masterBulkRejected } from '@/masters/bulk-export.js';
import { writeMasterXlsx } from '@/masters/bulk-xlsx-export.js';

export const GET = endpoint(async (request, context) => {
  const { batchId } = await context.params;
  const data = await authenticated(request, (client, identity) => masterBulkRejected(client, identity, batchId), { readOnly: true });
  const bytes = await writeMasterXlsx(data.headers, data.rows);
  return new Response(bytes, { headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${data.fileName}"`, 'Cache-Control': 'no-store' } });
});
