import { authenticated, endpoint } from '@/auth/http.js';
import { masterBulkTemplate } from '@/masters/bulk-export.js';
import { writeMasterXlsx } from '@/masters/bulk-xlsx-export.js';

export const GET = endpoint(async request => {
  const data = await authenticated(request, (client, identity) => masterBulkTemplate(client, identity, request.nextUrl.searchParams.get('resource')), { readOnly: true });
  const bytes = await writeMasterXlsx(data.headers, data.rows);
  return new Response(bytes, { headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${data.fileName}"`, 'Cache-Control': 'no-store' } });
});
