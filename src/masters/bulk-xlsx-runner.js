import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';
import { HttpError } from '../auth/errors.js';
import { masterBulkXlsxLimits as limits } from './bulk-xlsx-limits.js';

let activeReaders = 0;

export async function readMasterXlsx(input, { timeoutMs = limits.timeoutMs } = {}) {
  const source = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  if (!(source instanceof Uint8Array) || !(source.buffer instanceof ArrayBuffer) || source.byteLength === 0 || source.byteLength > limits.bytes) {
    throw new HttpError(400, 'invalid_bulk_workbook', 'Provide an XLSX workbook of at most 16 MiB.');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > limits.timeoutMs) throw new HttpError(400, 'invalid_workbook_timeout', 'The workbook reading deadline is invalid.');
  if (activeReaders >= limits.concurrentReaders) throw new HttpError(429, 'workbook_reader_busy', 'Workbook reading is busy. Try again shortly.');
  activeReaders++;
  let worker; let timer; let finished = false;
  try {
    // Own the transferred bytes: another request cannot change them during validation or detach the caller's buffer.
    const bytes = new Uint8Array(source).buffer;
    worker = new Worker(resolve(process.cwd(), 'src/masters/bulk-xlsx-worker.js'), {
      workerData: { bytes }, transferList: [bytes], execArgv: [], env: {},
      resourceLimits: { maxOldGenerationSizeMb: 768, maxYoungGenerationSizeMb: 32 },
    });
    return await new Promise((resolve, reject) => {
      const fail = error => { if (!finished) { finished = true; reject(error); } };
      timer = setTimeout(() => fail(new HttpError(422, 'workbook_read_timeout', 'The workbook took too long to read. Use a smaller workbook.')), timeoutMs);
      worker.on('error', () => fail(new HttpError(422, 'workbook_read_failed', 'The workbook could not be read. Check the file or use a smaller workbook.')));
      worker.on('exit', () => fail(new HttpError(422, 'workbook_read_failed', 'The workbook could not be read.')));
      worker.on('message', message => {
        if (finished) return;
        if (message.type === 'result') { finished = true; resolve(message.result); }
        else if (message.type === 'error') fail(new HttpError(message.status, message.code, message.message));
      });
    });
  } finally {
    clearTimeout(timer); finished = true;
    try { if (worker) await worker.terminate(); }
    finally { activeReaders--; }
  }
}
