import { HttpError } from '../auth/errors.js';
import { requirePermission } from '../templates/input.js';
import { quickCustomerInput } from './input.js';

export async function quickCreateCustomer(client, identity, rawInput) {
  requirePermission(identity, 'samples.create');
  const input = quickCustomerInput(rawInput);
  let id;
  try {
    const created = await client.query('SELECT laboratory_quick_customer($1,$2,$3,$4,$5,$6,$7) AS id',
      [input.name, input.legalName, input.contactPersonName, input.contactPersonEmail, input.contactPersonPhone, input.billToAddress, input.shipToAddress]);
    id = created.rows[0].id;
  } catch (error) {
    if (error.code === '42501' && error.constraint === 'organization_module_access_required') throw new HttpError(403, 'customer_module_access_required', 'Customer module access is required.');
    if (error.code === '42501') throw new HttpError(403, 'forbidden', 'Your sample creation permission changed. Reload before continuing.');
    if (error.code === '23505') throw new HttpError(409, 'customer_exists', 'A customer with this code already exists. Select the existing customer or use a distinct name.');
    throw error;
  }
  const record = await client.query('SELECT id, code, name, legal_name AS "legalName" FROM laboratory_customer_references WHERE organization_id=$1 AND id=$2', [identity.organization_id, id]);
  return { ...record.rows[0], addresses: [{ addressType: 'billing', isDefault: true, text: input.billToAddress },
    { addressType: 'shipping', isDefault: true, text: input.shipToAddress }], quotations: [] };
}
