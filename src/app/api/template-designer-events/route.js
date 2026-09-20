import { SESSION_COOKIE } from '@/auth/http.js';
import { withSession } from '@/auth/service.js';
import { subscribeToTemplateEvents } from '@/templates/live-events.server.js';

// Server-sent events, not the shared authenticated()/json() helpers: this connection stays
// open for the life of the designer tab, so authentication happens once up front (a normal
// short-lived transaction) rather than wrapping the whole stream in one.
export async function GET(request) {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  let organizationId;
  try {
    organizationId = await withSession(token, (client, identity) => identity.organization_id, { readOnly: true, permission: 'templates.read' });
  } catch (error) {
    return new Response(null, { status: error.status ?? 401 });
  }
  const encoder = new TextEncoder();
  let unsubscribe = null;
  let heartbeat = null;
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(': connected\n\n'));
      unsubscribe = await subscribeToTemplateEvents((payload) => {
        if (payload.organizationId !== organizationId) return;
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)); } catch { /* stream already closed */ }
      });
      heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(': heartbeat\n\n')); } catch { clearInterval(heartbeat); }
      }, 25_000);
    },
    cancel() { unsubscribe?.(); if (heartbeat) clearInterval(heartbeat); },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' } });
}
