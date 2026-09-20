import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';
import { HttpError } from '../auth/errors.js';

// This is a command deadline, not a fallback counter. A timeout never produces an unverified number.
export async function runMasterGeneration(data, readPage, { timeoutMs = 10_000, readLookup } = {}) {
  const worker = new Worker(resolve(process.cwd(), 'src/custom-fields/product-generation-worker.js'), {
    workerData: data, execArgv: [], env: {}, resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 16 },
  });
  let finished = false; let timer; let activeRead = Promise.resolve();
  try {
    return await new Promise((resolve, reject) => {
      const fail = (error) => { if (!finished) { finished = true; reject(error); } };
      timer = setTimeout(() => fail(new HttpError(422, 'scheme_timeout', 'The scheme took too long to generate. Check its pattern and try again.')), timeoutMs);
      worker.on('error', () => fail(new HttpError(422, 'scheme_failed', 'The scheme could not be generated. Check its pattern and try again.')));
      worker.on('exit', () => { if (!finished) fail(new HttpError(422, 'scheme_failed', 'The scheme could not be generated.')); });
      worker.on('message', (message) => {
        if (finished) return;
        if (message.type === 'result') { finished = true; resolve(message.values); }
        else if (message.type === 'error') fail(new HttpError(422, 'invalid_scheme', message.message));
        else if (message.type === 'page' || message.type === 'lookup') {
          activeRead = activeRead.then(async () => {
            if (finished) return;
            try {
              const rows = message.type === 'lookup' ? await readLookup(message.fieldId, message.value) : await readPage(message.fieldId, message.cursor);
              if (!finished) worker.postMessage({ id: message.id, rows });
            } catch (error) { fail(error); }
          });
        }
      });
    });
  } finally {
    clearTimeout(timer); finished = true;
    await worker.terminate();
    // Never release the authenticated transaction while its last database read is still running.
    await activeRead;
  }
}

export const runProductGeneration = (...args) => runMasterGeneration(...args);
