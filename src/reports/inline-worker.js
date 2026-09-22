import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createReportWorkerPool, verifyReportWorkerRole, processNextReportJob } from './worker.js';
import { loadReportRenderer } from './renderer.js';

// The web server can host the report worker loop itself, so a single
// `npm run dev` / `npm start` prints COA PDFs without a second process. The
// loop still connects as the dedicated worker role (from .env.worker.local or
// WORKER_DATABASE_URL) and claims jobs through the same leases as
// scripts/report-worker.js, so an external worker may run alongside it.
function workerDatabaseUrl() {
  if (process.env.WORKER_DATABASE_URL) return process.env.WORKER_DATABASE_URL;
  if (!existsSync('.env.worker.local')) return null;
  return readFileSync('.env.worker.local', 'utf8').split('\n').find((line) => line.startsWith('WORKER_DATABASE_URL='))?.slice('WORKER_DATABASE_URL='.length).trim() || null;
}

let started = false;
export async function startInlineReportWorker({ log = console } = {}) {
  if (started || process.env.REPORT_WORKER_INLINE === '0') return null;
  const connectionString = workerDatabaseUrl();
  if (!connectionString) { log.warn('Report printing needs a report worker. Run `npm run worker:setup` once, then restart.'); return null; }
  started = true;
  const workerId = randomUUID(); const stopping = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => stopping.abort());
  const pool = createReportWorkerPool(connectionString);
  (async () => {
    let renderer = null;
    try {
      await verifyReportWorkerRole(pool);
      while (!stopping.signal.aborted) {
        let idle = true;
        try {
          renderer ??= await loadReportRenderer();
          if (await processNextReportJob({ pool, renderer, workerId })) idle = false;
        } catch (error) {
          renderer = null;
          log.error(`Inline report worker paused: ${error.message}`);
          await delay(10_000, undefined, { signal: stopping.signal }).catch(() => {});
          continue;
        }
        if (idle) await delay(1000, undefined, { signal: stopping.signal }).catch(() => {});
      }
    } catch (error) {
      log.error(`Inline report worker could not start: ${error.message}`);
    } finally { await pool.end().catch(() => {}); }
  })();
  log.log(`Inline report worker ${workerId} started.`);
  return { workerId, stop: () => stopping.abort() };
}
