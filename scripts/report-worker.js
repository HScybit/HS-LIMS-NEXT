import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createReportWorkerPool, verifyReportWorkerRole, processNextReportJob } from '../src/reports/worker.js';
import { loadReportRenderer } from '../src/reports/renderer.js';

const workerId = randomUUID();
const stopping = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => stopping.abort());
const pool = createReportWorkerPool();
try {
  await verifyReportWorkerRole(pool);
  const renderer = await loadReportRenderer();
  console.log(`Report worker ${workerId} is ready for renderer ${renderer.rendererId}.`);
  while (!stopping.signal.aborted) {
    let idle = true;
    try {
      const result = await processNextReportJob({ pool, renderer, workerId });
      if (result) { console.log('Report job finished.', result); idle = false; }
    } catch { console.error('Report worker operation failed; unfinished work will be retried.'); }
    if (process.argv.includes('--once')) break;
    if (idle) await delay(2000, undefined, { signal: stopping.signal }).catch((error) => { if (error.name !== 'AbortError') throw error; });
  }
} finally { await pool.end(); }
