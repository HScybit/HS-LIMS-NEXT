// Example values for the sample workbooks. Every sample workbook carries one
// illustrative row under its header row, matching the PERN Data Transfer
// templates (buildTemplateRows): a value for each column so the expected
// shape, formats and lookups are visible before anything is filled in.
const exampleValuesByHeader = Object.freeze({
  name: 'Example', key: 'example_key', description: 'Example description', abbr: 'EXM',
  scheme_abbr: 'EX-SCH', order: '1', lab: 'Existing Lab name', lab_name: 'Existing Lab name',
  uuid: 'EXAMPLE_UUID_001', parse_num: 'true', decimal_places: '2', user_access: 'Existing user names separated by ;',
  email: 'example@example.com', phone: '9876543210', username: 'example_user', designation: 'Analyst',
  unit_name: 'Existing Business Unit name', role_name: 'Existing Role name', password: 'Example@Passw0rd',
  gst_number: '27ABCDE1234F1Z5', legal_name: 'Example Pvt Ltd', ship_to_address: 'Example shipping address',
  bill_to_address: 'Example billing address', default_credit_period: '30', contact_person_name: 'Example Contact',
  contact_person_email: 'contact@example.com', contact_person_phone: '9876543210', default_invoice_notes: 'Example invoice note',
  status: 'active', igst: '18', cgst: '0', sgst: '0', customer_total_balance: '0', vendor_total_balance: '0',
  isFeedback: 'false', discount: '0', is_kaleen_bandhu: 'false',
});

const singularByResource = Object.freeze({ products: 'Product', 'test-parameters': 'Parameter', methods: 'Method of Analysis',
  users: 'User', customers: 'Customer', vendors: 'Vendor' });

function customFieldExample(field) {
  const label = field?.label || field?.key || 'value';
  switch (field?.fieldType) {
    case 'select': return field.options?.[0]?.value ?? field.options?.[0] ?? `Example ${label}`;
    case 'number': return '1';
    case 'date': return '2026-01-01';
    case 'date_time': return '2026-01-01 09:00';
    case 'checkbox': return 'Yes';
    case 'email': return 'example@example.com';
    case 'lookup': return `Existing ${label} name`;
    case 'multi_user_select': return 'Existing user names separated by ;';
    case 'attachment': return '';
    default: return `Example ${label}`;
  }
}

export function masterBulkExampleValue(resource, header, customFields = []) {
  const singular = singularByResource[resource] ?? 'Record';
  if (header.startsWith('project_field.')) {
    const key = header.slice('project_field.'.length);
    return customFieldExample(customFields.find(field => field.key === key));
  }
  if (header === 'name') return `Example ${singular}`;
  if (header === 'legal_name') return `Example ${singular} Pvt Ltd`;
  if (header === 'key') return `example_${singular.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
  if (header === 'abbr') return singular.split(/\s+/).map(part => part[0]).join('').toUpperCase().padEnd(3, 'X').slice(0, 3);
  if (Object.hasOwn(exampleValuesByHeader, header)) return exampleValuesByHeader[header];
  return `Example ${header.replace(/_/g, ' ')}`;
}

export function masterBulkExampleRow(resource, headers, customFields = []) {
  return headers.map(header => masterBulkExampleValue(resource, header, customFields));
}
