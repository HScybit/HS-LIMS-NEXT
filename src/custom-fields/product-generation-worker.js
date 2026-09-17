import { parentPort, workerData } from 'node:worker_threads';
import { generateProductScheme, generateParameterScheme, generateMethodScheme, generateUserScheme, generateCustomerScheme, generateVendorScheme, generateInstrumentScheme } from './product-generation.js';
import { customFieldNeedsGeneration, customFieldFormDisplayValue } from './form-values.js';
import { customFieldDateDisplayInZone } from './server-dates.js';

let requestNumber = 0;
const pending = new Map();
parentPort.on('message', (message) => {
  const request = pending.get(message.id); if (!request) return;
  pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error)); else request.resolve(message.rows);
});
function read(type, input) {
  return new Promise((resolve, reject) => {
    const id = ++requestNumber; pending.set(id, { resolve, reject }); parentPort.postMessage({ type, id, ...input });
  });
}
async function latestValue({ fieldId, pattern }) {
  // The source builds this JavaScript RegExp before passing it to MongoDB. No user JavaScript is executed.
  const expression = new RegExp(`.*${pattern}$.*`);
  let cursor = null;
  while (true) {
    const rows = await read('page', { fieldId, cursor });
    if (!rows.length) return '';
    for (const row of rows) if (expression.test(row.value)) return row.value;
    const last = rows[rows.length - 1]; cursor = { createdAt: last.createdAt, updatedAt: last.updatedAt, productId: last.productId };
  }
}
async function generate() {
  const { fields, values, doc, settings, counts, clock, timeZone, fieldId, mode } = workerData;
  if (workerData.kind !== undefined && !['product', 'parameter', 'method', 'user', 'customer', 'vendor', 'instrument'].includes(workerData.kind)) throw new Error('Unsupported Custom Field master.');
  const scheme = workerData.kind === 'instrument' ? generateInstrumentScheme : workerData.kind === 'vendor' ? generateVendorScheme : workerData.kind === 'customer' ? generateCustomerScheme : workerData.kind === 'user' ? generateUserScheme : workerData.kind === 'method' ? generateMethodScheme : workerData.kind === 'parameter' ? generateParameterScheme : generateProductScheme;
  const generated = [];
  for (const field of fields) {
    if (fieldId ? field.id !== fieldId : !customFieldNeedsGeneration(field, mode, values[field.id])) continue;
    const value = await scheme({ field, doc, settings, counts, clock, latestValue });
    if (typeof value !== 'string' || value.length > 16000 || value.includes('\0') || !value.isWellFormed()) {
      throw new Error(`${field.label}: The generated value must be valid text of at most 16000 characters.`);
    }
    generated.push({ fieldId: field.id, value }); values[field.id] = value;
    const lookupOptions = workerData.resolveLookups && field.fieldType === 'lookup' && field.lookupSourceId
      ? await read('lookup', { fieldId: field.id, value }) : [];
    doc.project_field_data[field.key] = { ...doc.project_field_data[field.key], value,
      display_value: customFieldFormDisplayValue(value, field, lookupOptions, (raw, definition) => customFieldDateDisplayInZone(raw, definition, timeZone)) };
  }
  return generated;
}
try { parentPort.postMessage({ type: 'result', values: await generate() }); }
catch (error) { parentPort.postMessage({ type: 'error', message: error instanceof SyntaxError ? 'The scheme pattern is invalid.' : String(error.message).slice(0, 1000) }); }
finally { parentPort.close(); }
