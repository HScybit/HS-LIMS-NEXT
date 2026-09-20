import { Worker } from 'node:worker_threads';

const WORKER_URL = new URL('./sandbox-worker.js', import.meta.url);
const MAX_CONCURRENT_WORKERS = 4;
let active = 0; const queue = [];
function releaseSlot() { const next = queue.shift(); if (next) next(); else active--; }
async function acquireSlot() { if (active < MAX_CONCURRENT_WORKERS) { active++; return; } await new Promise((resolve) => queue.push(resolve)); }

// Runs untrusted, tenant-authored code in a dedicated worker_threads Worker
// with a capped heap/stack (matching this feature's Meteor reference: 64MB
// heap, 4MB stack) and a global cap on how many run concurrently across the
// whole process. onQuery(resource, args) is supplied by the caller, which
// holds the real database client — this module has no database access of
// its own and never will, by construction: the only channel the sandboxed
// code has to the outside world is the postMessage RPC the worker script
// exposes as api.query(), which the caller validates against a whitelist
// before ever running a real query.
export async function runDynamicApiCode({ code, input, timeoutMs = 10_000 }, onQuery) {
  await acquireSlot();
  let worker; let timer; let settled = false;
  try {
    return await new Promise((resolve, reject) => {
      worker = new Worker(WORKER_URL, { workerData: { code, input, timeoutMs },
        resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } });
      const settle = (fn) => { if (settled) return; settled = true; clearTimeout(timer); fn(); };
      timer = setTimeout(() => settle(() => {
        worker.terminate().catch(() => {});
        reject(Object.assign(new Error('The dynamic API timed out.'), { statusCode: 'timed_out' }));
      }), timeoutMs + 500);
      worker.on('message', (message) => {
        if (message.type === 'rpc') {
          onQuery(message.resource, message.args)
            .then((result) => worker.postMessage({ type: 'rpc-result', requestId: message.requestId, result }))
            .catch((error) => worker.postMessage({ type: 'rpc-error', requestId: message.requestId, error: error?.message ?? String(error) }));
          return;
        }
        settle(() => {
          if (message.type === 'done') resolve({ result: message.result, logs: message.logs ?? '' });
          else reject(Object.assign(new Error(message.message ?? 'The dynamic API failed.'), { statusCode: 'failed', logs: message.logs ?? '' }));
        });
      });
      worker.on('error', (error) => settle(() => reject(Object.assign(new Error(error.message ?? 'The dynamic API crashed.'), { statusCode: 'failed' }))));
      worker.on('exit', (exitCode) => settle(() => reject(Object.assign(new Error(`The dynamic API exited unexpectedly (code ${exitCode}).`), { statusCode: 'failed' }))));
    });
  } finally {
    await worker?.terminate().catch(() => {});
    releaseSlot();
  }
}
