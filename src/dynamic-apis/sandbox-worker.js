// Runs entirely inside a worker_threads Worker with resourceLimits applied
// by the caller (src/dynamic-apis/sandbox.js) — this file has no database
// access, no filesystem/network access, and no reference to the app's own
// modules. The only way it can affect anything outside itself is the
// api.query() RPC bridge below, which the parent thread validates against a
// fixed whitelist before ever running a real query.
import { parentPort, workerData } from 'node:worker_threads';
import vm from 'node:vm';

let requestCounter = 0;
const pending = new Map();

function query(resource, args) {
  return new Promise((resolve, reject) => {
    const requestId = ++requestCounter;
    pending.set(requestId, { resolve, reject });
    parentPort.postMessage({ type: 'rpc', requestId, resource, args });
  });
}

parentPort.on('message', (message) => {
  const waiting = pending.get(message.requestId);
  if (!waiting) return;
  pending.delete(message.requestId);
  if (message.type === 'rpc-result') waiting.resolve(message.result);
  else if (message.type === 'rpc-error') waiting.reject(new Error(message.error));
});

const logs = [];
const logLimit = 20_000;
function record(level, args) {
  if (logs.reduce((total, line) => total + line.length, 0) > logLimit) return;
  logs.push(`[${level}] ${args.map((value) => { try { return typeof value === 'string' ? value : JSON.stringify(value); } catch { return String(value); } }).join(' ')}`);
}
const sandboxConsole = { log: (...args) => record('log', args), warn: (...args) => record('warn', args), error: (...args) => record('error', args) };

async function run() {
  try {
    const context = vm.createContext({ input: workerData.input, api: { query }, console: sandboxConsole,
      JSON, Math, Date, Array, Object, String, Number, Boolean, RegExp, Map, Set, Promise, Error, TypeError, RangeError, undefined });
    // The vm-level timeout only bounds synchronous execution (e.g. a while(true)
    // loop) — it cannot bound an async function awaiting a never-resolving
    // promise. The authoritative timeout is the caller terminating this whole
    // worker if it hasn't responded in time; this is defense in depth only.
    const script = new vm.Script(`(async () => {\n${workerData.code}\n})()`, { filename: 'dynamic-api.js' });
    const result = await script.runInContext(context, { timeout: workerData.timeoutMs });
    parentPort.postMessage({ type: 'done', result: result === undefined ? null : result, logs: logs.join('\n') });
  } catch (error) {
    parentPort.postMessage({ type: 'error', message: error?.message ?? String(error), logs: logs.join('\n') });
  }
}
run();
