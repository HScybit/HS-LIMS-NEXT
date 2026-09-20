import 'server-only';
import { getPool } from '../db/pool.js';

// One shared LISTEN connection for the whole process, ref-counted via the listener set —
// SSE requests come and go, but a dedicated LISTEN client per request would leak connections
// (each holds one open indefinitely) and Postgres NOTIFY/LISTEN doesn't need more than one
// per channel per process.
const CHANNEL = 'template_designer_events';
let client = null;
let connecting = null;
const listeners = new Set();

function handleNotification(message) {
  if (message.channel !== CHANNEL) return;
  let payload;
  try { payload = JSON.parse(message.payload); } catch { return; }
  for (const listener of listeners) listener(payload);
}

async function ensureListening() {
  if (client) return client;
  if (!connecting) {
    connecting = getPool().connect().then(async (connection) => {
      connection.on('notification', handleNotification);
      connection.on('error', () => { client = null; connecting = null; connection.release(true); });
      await connection.query(`LISTEN ${CHANNEL}`);
      client = connection;
      return connection;
    }).catch((error) => { connecting = null; throw error; });
  }
  return connecting;
}

// Returns an unsubscribe function. Never rejects the caller for a transient connection
// issue — a missed live-refresh is far cheaper than crashing the SSE route that requested it.
export async function subscribeToTemplateEvents(listener) {
  try { await ensureListening(); } catch { /* the next event, if any, retries the connection */ }
  listeners.add(listener);
  return () => listeners.delete(listener);
}
