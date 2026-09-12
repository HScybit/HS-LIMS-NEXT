import { authenticated, endpoint, json } from '@/auth/http.js';

export const GET = endpoint(async (request) => json(await authenticated(request, async (client) => ({
  items: (await client.query('SELECT * FROM report_document_options()')).rows,
}), { readOnly: true })));
