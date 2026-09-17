import { HttpError } from '../auth/errors.js';
import { fieldsOnly, integer, text } from '../templates/input.js';
import { requireVendorRead } from './vendors.js';
import { vendorCustomFields } from './custom-fields.js';
import { customFieldColumnKey } from '../custom-fields/listing-values.js';
import { masterCustomFieldMatch, loadMasterListingValues } from './master-custom-field-listing.js';

const columns = { name: 'vendor.name', contact_person_name: 'contact.name', contact_person_email: 'contact.email', contact_person_phone: 'contact.phone' };
const literalSearch = value => `%${value.replace(/[\\%_]/g, '\\$&')}%`;
function searchText(value, label) {
  const result = text(value, label, 500, { optional: true }).trim();
  if (!result.isWellFormed() || result.includes('\0')) throw new HttpError(400, 'invalid_input', `${label} must be valid text without null characters.`);
  return result;
}

// Match the primary contact and saved order used by loadVendor.
const relations = `  LEFT JOIN LATERAL (
    SELECT person.name,person.email,person.phone FROM vendor_contacts person LEFT JOIN vendor_version_contacts saved
      ON saved.organization_id=person.organization_id AND saved.vendor_id=person.vendor_id AND saved.id=person.id AND saved.revision=vendor.revision
    WHERE person.organization_id=vendor.organization_id AND person.vendor_id=vendor.id
    ORDER BY person.is_primary DESC,saved.position NULLS LAST,person.id LIMIT 1
  ) contact ON true`;

export async function listVendors(client, identity, input = {}) {
  await requireVendorRead(client, identity); fieldsOnly(input, ['page', 'pageSize', 'search', 'filters', 'sort']);
  const page = integer(input.page ?? 1, 'Page', 1, 1_000_000); const pageSize = integer(input.pageSize ?? 10, 'Page size', 1, 100);
  const search = searchText(input.search, 'Search'); const args = [identity.organization_id];
  const conditions = ['vendor.organization_id=$1', 'NOT vendor.retired'];
  const fields = await vendorCustomFields(client, identity, { forListing: true });
  const customColumns = new Map(fields.map(field => [customFieldColumnKey(field), field]));
  const bind = value => { args.push(value); return `$${args.length}`; };
  if (search) {
    const match = bind(literalSearch(search)); const searchable = fields.filter(field => field.showInFilter);
    conditions.push(`(${Object.entries(columns).map(([, expression]) => `${expression} ILIKE ${match}`).join(' OR ')}
      ${searchable.length ? `OR ${masterCustomFieldMatch('vendor', bind, searchable.map(field => field.id), search)}` : ''})`);
  }
  const filters = input.filters ?? {}; fieldsOnly(filters, [...Object.keys(columns), ...fields.filter(field => field.showInFilter).map(customFieldColumnKey)]);
  for (const [key, filter] of Object.entries(filters)) {
    fieldsOnly(filter, ['type', 'value']); const field = customColumns.get(key);
    const expectedType = field?.fieldType === 'select' && field.options.length ? 'select' : 'text';
    if (filter.type !== expectedType) throw new HttpError(400, 'invalid_filter', 'Use the configured Vendor filter control.');
    const value = searchText(filter.value, 'Filter'); if (!value) continue;
    if (field) conditions.push(masterCustomFieldMatch('vendor', bind, [field.id], value));
    else conditions.push(`${columns[key]}::text ILIKE ${bind(literalSearch(value).replace(/\s+/g, '%'))}`);
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
    : sort ? `${columns[sort.key]} ${sort.dir} NULLS LAST` : 'vendor.created_at DESC';
  const from = `FROM vendors vendor ${relations} ${customSort ? `LEFT JOIN vendor_version_custom_fields ordering_field
    ON ordering_field.organization_id=vendor.organization_id AND ordering_field.vendor_id=vendor.id AND ordering_field.revision=vendor.revision
    AND ordering_field.field_id=${bind(customSort.id)}` : ''} WHERE ${conditions.join(' AND ')}`;
  const totalCount = (await client.query(`SELECT count(*)::integer AS total ${from}`, args)).rows[0].total;
  const rows = (await client.query(`SELECT vendor.id AS _id,vendor.revision,${Object.entries(columns).map(([key, expression]) => `${expression} AS ${key}`).join(',')}
    ${from} ORDER BY ${order},vendor.id DESC LIMIT $${args.length + 1} OFFSET $${args.length + 2}`, [...args, pageSize, (page - 1) * pageSize])).rows;
  return { rows: await loadMasterListingValues('vendor', client, identity, rows, fields), totalCount };
}
