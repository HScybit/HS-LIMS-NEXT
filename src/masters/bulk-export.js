import { HttpError } from '../auth/errors.js';
import { requirePermission } from '../templates/input.js';
import { productCustomFields, parameterCustomFields, methodCustomFields } from './custom-fields.js';
import { masterBulkResource } from './bulk-row.js';
import { loadMasterBulkBatch, loadMasterBulkCells, masterBulkRowStatus } from './bulk-store.js';

export async function masterBulkTemplate(client, identity, resource) {
  requirePermission(identity, 'masters.manage'); const config = masterBulkResource(resource);
  const readers = { products: productCustomFields, 'test-parameters': parameterCustomFields, methods: methodCustomFields };
  const fields = await readers[resource](client, identity);
  const headers = [...config.headers, ...fields.map(field => `project_field.${field.key}`)];
  if (headers.length > 250) throw new HttpError(422, 'bulk_template_limit', 'There are more fields than fit in one upload. Use a sheet with the required columns and up to 250 columns in total. Omitted fields retain their saved values.');
  return { headers, rows: [], fileName: `${resource}-sample.xlsx` };
}

export async function masterBulkRejected(client, identity, batchId) {
  const batch = await loadMasterBulkBatch(client, identity, batchId);
  const status = await masterBulkRowStatus(client, identity, batch.id);
  const rejected = status.filter(row => !row.committed && (row.valid === false || row.processingCode));
  if (!rejected.length) throw new HttpError(409, 'no_rejected_rows', 'There are no rejected rows to download.');
  const rows = await loadMasterBulkCells(client, identity, batch.id, rejected);
  return { headers: batch.columns.map(column => column.header), rows: rows.map(row => row.values), fileName: `${batch.resource}-rejected.xlsx` };
}

export async function masterBulkOriginal(client, identity, batchId) {
  const batch = await loadMasterBulkBatch(client, identity, batchId);
  const status = await masterBulkRowStatus(client, identity, batch.id);
  const rows = await loadMasterBulkCells(client, identity, batch.id, status, { original: true });
  return { headers: batch.columns.map(column => column.header), rows: rows.map(row => row.values), fileName: `${batch.resource}-original-rows.xlsx` };
}
