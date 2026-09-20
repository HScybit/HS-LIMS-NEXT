import { parentPort, workerData } from 'node:worker_threads';
import { decodeMasterXlsx } from './bulk-xlsx.js';
import { HttpError } from '../auth/errors.js';

try {
  const result = await decodeMasterXlsx(Buffer.from(workerData.bytes));
  parentPort.postMessage({ type: 'result', result });
} catch (error) {
  parentPort.postMessage({ type: 'error', status: error instanceof HttpError ? error.status : 400,
    code: 'invalid_bulk_workbook', message: error instanceof HttpError ? error.message : 'The XLSX workbook could not be read.' });
} finally { parentPort.close(); }
