import { HttpError } from '../auth/errors.js';
import { requirePermission } from '../templates/input.js';
import { masterBulkResource } from './bulk-row.js';
import { requireCustomerRead } from './customers.js';

export async function requireMasterBulkAccess(client, identity, resource, { write = false } = {}) {
  requirePermission(identity, masterBulkResource(resource).permission);
  if (resource !== 'customers') return;
  await requireCustomerRead(client, identity);
  if (write) {
    try { await client.query('SELECT masters_require_customer_write()'); }
    catch (error) {
      if (error.code === '42501') throw new HttpError(403, 'customer_module_access_required', 'Current Customer module access and management permission are required.');
      if (error.constraint === 'module_access_write_isolation') throw new HttpError(409, 'customer_write_isolation', 'Retry this Customer upload in a new transaction.');
      throw error;
    }
  }
}
