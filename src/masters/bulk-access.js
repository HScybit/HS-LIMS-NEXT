import { HttpError } from '../auth/errors.js';
import { requirePermission } from '../templates/input.js';
import { masterBulkResource } from './bulk-row.js';
import { requireCustomerRead } from './customers.js';
import { requireVendorRead } from './vendors.js';

export async function requireMasterBulkAccess(client, identity, resource, { write = false } = {}) {
  requirePermission(identity, masterBulkResource(resource).permission);
  if (!['customers', 'vendors'].includes(resource)) return;
  const vendor = resource === 'vendors'; const kind = vendor ? 'vendor' : 'customer'; const label = vendor ? 'Vendor' : 'Customer';
  await (vendor ? requireVendorRead : requireCustomerRead)(client, identity);
  if (write) {
    try { await client.query(`SELECT masters_require_${kind}_write()`); }
    catch (error) {
      if (error.code === '42501') throw new HttpError(403, `${kind}_module_access_required`, `Current ${label} module access and management permission are required.`);
      if (error.constraint === 'module_access_write_isolation') throw new HttpError(409, `${kind}_write_isolation`, `Retry this ${label} upload in a new transaction.`);
      throw error;
    }
  }
}
