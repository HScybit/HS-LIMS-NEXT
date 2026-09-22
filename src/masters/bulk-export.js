import { HttpError } from '../auth/errors.js';
import { productCustomFields, parameterCustomFields, methodCustomFields, customerCustomFields, vendorCustomFields } from './custom-fields.js';
import { requireMasterBulkAccess } from './bulk-access.js';
import { vendorBulkExample } from './vendor-bulk-config.js';
import { customerBulkExample } from './customer-bulk-config.js';
import { masterBulkExampleRow } from './bulk-examples.js';
import { masterBulkResource } from './bulk-row.js';
import { loadMasterBulkBatch, loadMasterBulkCells, masterBulkRowStatus } from './bulk-store.js';

export async function masterBulkTemplate(client, identity, resource) {
  const config = masterBulkResource(resource); await requireMasterBulkAccess(client, identity, resource);
  // Every sample carries one example row beneath the headers, like the PERN Data Transfer templates.
  if (resource === 'users') return { headers: [...config.headers], rows: [masterBulkExampleRow(resource, config.headers)], fileName: 'users-sample.xlsx' };
  const readers = { products: productCustomFields, 'test-parameters': parameterCustomFields, methods: methodCustomFields, customers: customerCustomFields, vendors: vendorCustomFields };
  const fields = await readers[resource](client, identity);
  const headers = [...config.headers, ...fields.map(field => `project_field.${field.key}`)];
  if (headers.length > 250) throw new HttpError(422, 'bulk_template_limit', `There are more fields than fit in one upload. Use a sheet with the required columns and up to 250 columns in total.${['customers', 'vendors'].includes(resource) ? ' Include every required Custom Field.' : ' Omitted fields retain their saved values.'}`);
  const partyExample = resource === 'vendors' ? vendorBulkExample : resource === 'customers' ? customerBulkExample : null;
  const example = masterBulkExampleRow(resource, headers, fields).map((value, index) => partyExample?.[headers[index]] ?? value);
  return { headers, rows: [example], fileName: `${resource}-sample.xlsx` };
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
