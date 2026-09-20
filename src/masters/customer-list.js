import { HttpError } from '../auth/errors.js';
import { fieldsOnly, integer, text } from '../templates/input.js';
import { requireCustomerRead } from './customers.js';
import { customerCustomFields } from './custom-fields.js';
import { customFieldColumnKey } from '../custom-fields/listing-values.js';
import { masterCustomFieldMatch, loadMasterListingValues } from './master-custom-field-listing.js';

const statusLabel = "CASE WHEN customer.active THEN 'Active' ELSE 'Inactive' END";
const columns = { name: 'customer.name', ship_to_address: 'shipping.address', bill_to_address: 'billing.address',
  contact_person_name: 'contact.name', contact_person_email: 'contact.email', contact_person_phone: 'contact.phone',
  customer_total_balance: 'customer.total_balance', status: statusLabel };
const literalSearch = value => `%${value.replace(/[\\%_]/g, '\\$&')}%`;
function searchText(value, label) {
  const result = text(value, label, 500, { optional: true }).trim();
  if (!result.isWellFormed() || result.includes('\0')) throw new HttpError(400, 'invalid_input', `${label} must be valid text without null characters.`);
  return result;
}

// These fixed joins use the same default/primary and saved-position order as
// loadCustomer. Parent indexes cover legacy records that have no version yet.
function addressJoin(type, alias) {
  return `LEFT JOIN LATERAL (
    SELECT coalesce(address.freeform_address,concat_ws(', ',nullif(address.attention_to,''),nullif(address.line_1,''),nullif(address.line_2,''),
      nullif(address.city,''),nullif(address.state,''),nullif(address.postal_code,''),nullif(address.country_code,''))) AS address
    FROM customer_addresses address LEFT JOIN customer_version_addresses saved
      ON saved.organization_id=address.organization_id AND saved.customer_id=address.customer_id AND saved.id=address.id AND saved.revision=customer.revision
    WHERE address.organization_id=customer.organization_id AND address.customer_id=customer.id AND address.address_type='${type}'
    ORDER BY address.is_default DESC,saved.position NULLS LAST,address.id LIMIT 1
  ) ${alias} ON true`;
}
const relations = `${addressJoin('shipping', 'shipping')} ${addressJoin('billing', 'billing')}
  LEFT JOIN LATERAL (
    SELECT person.name,person.email,person.phone FROM customer_contacts person LEFT JOIN customer_version_contacts saved
      ON saved.organization_id=person.organization_id AND saved.customer_id=person.customer_id AND saved.id=person.id AND saved.revision=customer.revision
    WHERE person.organization_id=customer.organization_id AND person.customer_id=customer.id
    ORDER BY person.is_primary DESC,saved.position NULLS LAST,person.id LIMIT 1
  ) contact ON true`;

export async function listCustomers(client, identity, input = {}) {
  await requireCustomerRead(client, identity); fieldsOnly(input, ['page', 'pageSize', 'search', 'filters', 'sort']);
  const page = integer(input.page ?? 1, 'Page', 1, 1_000_000); const pageSize = integer(input.pageSize ?? 10, 'Page size', 1, 100);
  const search = searchText(input.search, 'Search'); const args = [identity.organization_id];
  const conditions = ['customer.organization_id=$1', 'NOT customer.retired'];
  const fields = await customerCustomFields(client, identity, { forListing: true });
  const customColumns = new Map(fields.map(field => [customFieldColumnKey(field), field]));
  const bind = value => { args.push(value); return `$${args.length}`; };
  if (search) {
    const match = bind(literalSearch(search)); const searchable = fields.filter(field => field.showInFilter);
    conditions.push(`(${Object.entries(columns).filter(([key]) => key !== 'customer_total_balance').map(([, expression]) => `${expression} ILIKE ${match}`).join(' OR ')}
      ${searchable.length ? `OR ${masterCustomFieldMatch('customer', bind, searchable.map(field => field.id), search)}` : ''})`);
  }
  const filters = input.filters ?? {}; fieldsOnly(filters, [...Object.keys(columns), ...fields.filter(field => field.showInFilter).map(customFieldColumnKey)]);
  for (const [key, filter] of Object.entries(filters)) {
    fieldsOnly(filter, ['type', 'value']); const field = customColumns.get(key);
    const expectedType = key === 'status' || field?.fieldType === 'select' && field.options.length ? 'select' : 'text';
    if (filter.type !== expectedType) throw new HttpError(400, 'invalid_filter', 'Use the configured Customer filter control.');
    const value = searchText(filter.value, 'Filter'); if (!value) continue;
    if (field) conditions.push(masterCustomFieldMatch('customer', bind, [field.id], value));
    else if (key === 'status') {
      if (!['Active', 'Inactive'].includes(value)) throw new HttpError(400, 'invalid_filter', 'Select Active or Inactive.');
      conditions.push(`customer.active=${bind(value === 'Active')}`);
    } else conditions.push(`${columns[key]}::text ILIKE ${bind(literalSearch(value).replace(/\s+/g, '%'))}`);
  }
  const sort = input.sort;
  if (sort) {
    fieldsOnly(sort, ['key', 'dir']);
    if ((!Object.hasOwn(columns, sort.key) && !customColumns.get(sort.key)?.showInList) || !['asc', 'desc'].includes(sort.dir)) {
      throw new HttpError(400, 'invalid_sort', 'Sort column or direction is invalid.');
    }
  }
  const customSort = customColumns.get(sort?.key);
  const order = customSort ? `CASE ordering_field.display_kind WHEN 'number' THEN 1 WHEN 'text' THEN 2 WHEN 'boolean' THEN 3 ELSE 0 END ${sort.dir},
    ordering_field.display_number ${sort.dir},ordering_field.display_text COLLATE "C" ${sort.dir},ordering_field.display_boolean ${sort.dir}`
    : sort ? `${columns[sort.key]} ${sort.dir} NULLS LAST` : 'customer.created_at DESC';
  const from = `FROM customers customer ${relations} ${customSort ? `LEFT JOIN customer_version_custom_fields ordering_field
    ON ordering_field.organization_id=customer.organization_id AND ordering_field.customer_id=customer.id AND ordering_field.revision=customer.revision
    AND ordering_field.field_id=${bind(customSort.id)}` : ''} WHERE ${conditions.join(' AND ')}`;
  const totalCount = (await client.query(`SELECT count(*)::integer AS total ${from}`, args)).rows[0].total;
  const rows = (await client.query(`SELECT customer.id AS _id,customer.revision,${Object.entries(columns).map(([key, expression]) => `${expression} AS ${key}`).join(',')}
    ${from} ORDER BY ${order},customer.id DESC LIMIT $${args.length + 1} OFFSET $${args.length + 2}`, [...args, pageSize, (page - 1) * pageSize])).rows;
  return { rows: await loadMasterListingValues('customer', client, identity, rows, fields), totalCount };
}
