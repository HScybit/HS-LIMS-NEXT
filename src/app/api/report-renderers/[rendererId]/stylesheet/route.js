import { authenticated, endpoint } from '@/auth/http.js';
import { loadReportStylesheet } from '@/reports/renderer.js';

export const GET = endpoint(async (request, context) => {
  await authenticated(request, () => null, { readOnly: true });
  const { rendererId } = await context.params;
  return new Response(await loadReportStylesheet(rendererId), { headers: {
    'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'private, max-age=3600, immutable',
  } });
});
