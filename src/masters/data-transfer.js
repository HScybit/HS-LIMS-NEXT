import { HttpError } from '../auth/errors.js';
import { fieldsOnly, requirePermission } from '../templates/input.js';
import { customFieldListDisplay } from '../custom-fields/listing-values.js';
import { masterBulkResources, allowedMasterBulkResources } from './bulk-config.js';
import { masterBulkTemplate } from './bulk-export.js';
import { productCustomFields, parameterCustomFields, methodCustomFields, customerCustomFields, vendorCustomFields } from './custom-fields.js';
import { listProducts } from './products.js';
import { listTestParameters } from './test-parameters.js';
import { listMethods } from './methods.js';
import { listCustomers } from './customer-list.js';
import { listVendors } from './vendor-list.js';
import { listUsers } from '../users/directory.js';

// The Data Transfer page (PERN /data_transfer) sits on the existing staged
// bulk-upload pipeline: imports use the same sample workbooks, header binding,
// validation preview and processing; exports read the same tenant-scoped
// listings the record tables use. No new tables or permissions.
export const dataTransferLimits = Object.freeze({ importRows: 2500, columns: 250, exportRows: { xlsx: 2500, csv: 25_000 } });

const columnLabels = {
  name: 'Name', key: 'Key', description: 'Description', abbr: 'Abbreviation', scheme_abbr: 'Scheme Abbreviation', order: 'Order', lab: 'Lab',
  uuid: 'UUID', parse_num: 'Convert Number', decimal_places: 'Decimal Places', user_access: 'Allow Access To',
  email: 'Email', phone: 'Phone', username: 'Username', designation: 'Designation', unit_name: 'Business Unit', role_name: 'Role', password: 'Password', lab_name: 'Lab',
  gst_number: 'GST Number', legal_name: 'Legal Name', ship_to_address: 'Ship To Address', bill_to_address: 'Bill To Address',
  default_credit_period: 'Default Credit Period', contact_person_name: 'Contact Person', contact_person_email: 'Contact Email',
  contact_person_phone: 'Contact Phone', default_invoice_notes: 'Default Invoice Notes', status: 'Status', igst: 'IGST', cgst: 'CGST', sgst: 'SGST',
  customer_total_balance: 'Total Balance', vendor_total_balance: 'Total Balance', isFeedback: 'Feedback Applicable', discount: 'Discount', is_kaleen_bandhu: 'Kaleen Bandhu',
};
const requiredHeaders = {
  products: ['name', 'key'], 'test-parameters': ['name', 'key', 'scheme_abbr'], methods: ['name', 'uuid', 'parse_num'],
  users: ['name', 'email', 'username', 'role_name', 'password', 'lab_name'], customers: ['name', 'legal_name'],
  vendors: ['name', 'legal_name', 'contact_person_name', 'contact_person_email', 'contact_person_phone'],
};

const cell = value => value == null ? '' : value instanceof Date ? value.toISOString() : typeof value === 'boolean' ? (value ? 'Yes' : 'No') : value;
const fixed = (key, label, read = row => row[key]) => ({ key, label, read: row => cell(read(row)) });
const entities = {
  products: { singular: 'Product', readPermission: 'masters.read', customFields: productCustomFields, list: listProducts,
    fields: [fixed('name', 'Name'), fixed('key', 'Key'), fixed('description', 'Description'), fixed('job_template_id', 'Job Template'), fixed('tags', 'Tags')] },
  'test-parameters': { singular: 'Parameter', readPermission: 'masters.read', customFields: parameterCustomFields, list: listTestParameters,
    fields: [fixed('name', 'Name'), fixed('key', 'Key'), fixed('scheme_abbr', 'Scheme Abbreviation'), fixed('order', 'Order'), fixed('lab_id', 'Lab')] },
  methods: { singular: 'Method of Analysis', readPermission: 'masters.read', customFields: methodCustomFields, list: listMethods,
    fields: [fixed('name', 'Name'), fixed('uuid', 'UUID'), fixed('description', 'Description'), fixed('decimal_places', 'Decimal Places'),
      fixed('parse_num', 'Convert Number'), fixed('has_access', 'Allow Access To')] },
  users: { singular: 'User', readPermission: 'users.read', list: listUsers,
    fields: [fixed('displayName', 'Name'), fixed('email', 'Email'), fixed('username', 'Username'), fixed('defaultRoleName', 'Role'),
      fixed('businessUnitName', 'Business Unit'), fixed('roles', 'Roles', row => row.roles?.map(role => role.name).join(', ')),
      fixed('active', 'Active'), fixed('lastLoginAt', 'Last Login'), fixed('createdAt', 'Created At')] },
  customers: { singular: 'Customer', readPermission: 'masters.read', module: 'customer', customFields: customerCustomFields, list: listCustomers,
    fields: [fixed('name', 'Name'), fixed('ship_to_address', 'Ship To Address'), fixed('bill_to_address', 'Bill To Address'), fixed('contact_person_name', 'Contact Person'),
      fixed('contact_person_email', 'Contact Email'), fixed('contact_person_phone', 'Contact Phone'), fixed('customer_total_balance', 'Total Balance'), fixed('status', 'Status')] },
  vendors: { singular: 'Vendor', readPermission: 'masters.read', module: 'vendor', customFields: vendorCustomFields, list: listVendors,
    fields: [fixed('name', 'Name'), fixed('contact_person_name', 'Contact Person'), fixed('contact_person_email', 'Contact Email'), fixed('contact_person_phone', 'Contact Phone')] },
};

export function dataTransferAccess(permissions = [], modules = {}) {
  const importable = allowedMasterBulkResources(permissions, modules);
  const exportable = Object.entries(entities).filter(([resource, entity]) => permissions.includes(entity.readPermission) && (!entity.module || modules[entity.module]))
    .map(([resource]) => resource);
  return { importable, exportable };
}

function requireEntity(resource) {
  if (typeof resource !== 'string' || !Object.hasOwn(entities, resource)) throw new HttpError(400, 'invalid_data_transfer_entity', 'Select an available data type.');
  return entities[resource];
}

async function exportFields(client, identity, resource) {
  const entity = entities[resource];
  const custom = entity.customFields ? (await entity.customFields(client, identity, { forListing: true })).filter(field => field.showInList) : [];
  return [...entity.fields, ...custom.map(field => ({ key: `pf:${field.id}`, label: field.label, read: row => customFieldListDisplay(row.customFields?.[field.id], field) }))];
}

// Session identities carry permission codes; party module access is read the way the listings read it.
async function sessionAccess(client, identity) {
  const modules = (await client.query("SELECT masters_can_read_party('customer') AS customer,masters_can_read_party('vendor') AS vendor")).rows[0];
  return dataTransferAccess(identity.permission_codes ?? [], modules);
}

export async function listDataTransferEntities(client, identity) {
  const access = await sessionAccess(client, identity);
  const items = [];
  for (const [resource, config] of Object.entries(masterBulkResources)) {
    const importable = access.importable.includes(resource); const exportable = access.exportable.includes(resource);
    if (!importable && !exportable) continue;
    const entity = entities[resource]; const item = { key: resource, label: config.label, singular: entity.singular, route: config.path, importable, exportable,
      writeMode: config.key ? 'upsert' : 'create_only', limits: dataTransferLimits, columns: [], fields: [] };
    if (importable) {
      const template = await masterBulkTemplate(client, identity, resource); const required = new Set(requiredHeaders[resource] ?? config.required ?? []);
      item.columns = template.headers.map((header, index) => ({ header, required: required.has(header), example: template.rows[0]?.[index] ?? '',
        label: header.startsWith('project_field.') ? `Custom Field · ${header.slice('project_field.'.length)}` : columnLabels[header] ?? header }));
    }
    if (exportable) item.fields = (await exportFields(client, identity, resource)).map(({ key, label }) => ({ key, label }));
    items.push(item);
  }
  return { items };
}

export function csvDocument(headers, rows) {
  const guard = value => { const textValue = value == null ? '' : String(value); return /^[=+\-@\t\r]/.test(textValue) ? `'${textValue}` : textValue; };
  const quote = value => `"${guard(value).replaceAll('"', '""')}"`;
  return `\uFEFF${[headers, ...rows].map(row => row.map(quote).join(',')).join('\r\n')}\r\n`;
}

export async function exportDataTransfer(client, identity, input) {
  fieldsOnly(input, ['resource', 'fields', 'format']);
  const entity = requireEntity(input.resource); const resource = input.resource;
  const format = input.format ?? 'xlsx';
  if (!['xlsx', 'csv'].includes(format)) throw new HttpError(400, 'invalid_export_format', 'Choose an XLSX or CSV export.');
  requirePermission(identity, entity.readPermission);
  if (!(await sessionAccess(client, identity)).exportable.includes(resource)) throw new HttpError(403, `${entity.module}_module_access_required`, `${entity.singular} module access is required.`);
  const available = await exportFields(client, identity, resource); const byKey = new Map(available.map(field => [field.key, field]));
  if (!Array.isArray(input.fields) || !input.fields.length || input.fields.length > dataTransferLimits.columns) throw new HttpError(400, 'invalid_export_fields', 'Select between 1 and 250 fields to export.');
  const selected = input.fields.map(key => byKey.get(key));
  if (selected.some(field => !field) || new Set(input.fields).size !== input.fields.length) throw new HttpError(422, 'invalid_export_field', 'One or more selected fields are not exportable.');
  const limit = dataTransferLimits.exportRows[format]; const records = [];
  for (let page = 1; ; page++) {
    const result = await entity.list(client, identity, { page, pageSize: 100 });
    records.push(...result.rows);
    if (result.totalCount > limit) throw new HttpError(422, 'export_limit', `${entity.singular} exports support up to ${limit.toLocaleString('en')} records as ${format.toUpperCase()}; this organization has ${result.totalCount.toLocaleString('en')}.`);
    if (records.length >= result.totalCount || result.rows.length < 100) break;
  }
  return { format, fileName: `${resource}_export.${format}`, headers: selected.map(field => field.label), rows: records.map(row => selected.map(field => field.read(row))),
    totalCount: records.length };
}
