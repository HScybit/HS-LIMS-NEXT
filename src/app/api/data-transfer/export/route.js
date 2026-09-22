import { authenticated, endpoint, readInput } from '@/auth/http.js';
import { csvDocument, exportDataTransfer } from '@/masters/data-transfer.js';
import { writeMasterXlsx } from '@/masters/bulk-xlsx-export.js';

export const POST = endpoint(async request => {
  const input = await readInput(request);
  const data = await authenticated(request, (client, identity) => exportDataTransfer(client, identity, input), { readOnly: true });
  const csv = data.format === 'csv';
  const bytes = csv ? Buffer.from(csvDocument(data.headers, data.rows), 'utf8') : await writeMasterXlsx(data.headers, data.rows);
  return new Response(bytes, { headers: { 'Content-Type': csv ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${data.fileName}"`, 'Cache-Control': 'no-store', 'X-Export-Rows': String(data.totalCount) } });
});
