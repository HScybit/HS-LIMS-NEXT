import { authenticated, endpoint, json } from '@/auth/http.js';
import { getMaterialStockReport } from '@/materials/service.js';

export const GET = endpoint(async (request) => {
  const asOnDate = request.nextUrl.searchParams.get('asOnDate') ?? undefined;
  return json(await authenticated(request, (client, identity) => getMaterialStockReport(client, identity, { asOnDate }), { readOnly: true }));
});
