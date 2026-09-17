import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';
import { HttpError } from '../auth/errors.js';

let activeWriters = 0;
export async function writeMasterXlsx(headers, rows) {
  if (!Array.isArray(headers) || headers.length < 1 || headers.length > 250 || !Array.isArray(rows) || rows.length > 2500) throw new HttpError(400, 'invalid_bulk_export', 'Workbook dimensions exceed the supported limit.');
  let bytes = 0;
  for (const row of [headers, ...rows]) {
    if (!Array.isArray(row) || row.length > headers.length) throw new HttpError(400, 'invalid_bulk_export', 'Workbook row dimensions are invalid.');
    for (const value of row) {
      if (value == null) continue;
      if (typeof value === 'string' && (value.length > 16000 || !value.isWellFormed() || value.includes('\0'))
        || typeof value === 'number' && !Number.isFinite(value)
        || value instanceof Date && !Number.isFinite(value.valueOf())
        || !['string', 'number', 'boolean'].includes(typeof value) && !(value instanceof Date)) throw new HttpError(400, 'invalid_bulk_export', 'Workbook contains an unsupported value.');
      bytes += Buffer.byteLength(value instanceof Date ? value.toISOString() : String(value));
    }
  }
  if (bytes > 16 * 1_048_576) throw new HttpError(413, 'bulk_export_limit', 'Workbook values must not exceed 16 MiB.');
  if (activeWriters >= 2) throw new HttpError(429, 'bulk_export_busy', 'Workbook export is busy. Try again shortly.');
  activeWriters++;
  let worker; let timer; let finished = false;
  try {
    worker = new Worker(resolve(process.cwd(), 'src/masters/bulk-xlsx-export-worker.js'), { workerData: { headers, rows }, execArgv: [], env: {},
      resourceLimits: { maxOldGenerationSizeMb: 768, maxYoungGenerationSizeMb: 32 } });
    return await new Promise((resolve, reject) => {
      const fail = () => { if (!finished) { finished = true; reject(new HttpError(422, 'bulk_export_failed', 'The workbook could not be exported. Try again.')); } };
      timer = setTimeout(fail, 20_000); worker.on('error', fail); worker.on('exit', fail);
      worker.on('message', message => {
        if (finished) return;
        if (message.type === 'result') { finished = true; resolve(Buffer.from(message.bytes)); } else fail();
      });
    });
  } finally {
    clearTimeout(timer); finished = true;
    try { if (worker) await worker.terminate(); } finally { activeWriters--; }
  }
}
