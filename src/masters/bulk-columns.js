import { HttpError } from '../auth/errors.js';
import { integer, uuid } from '../templates/input.js';
import { masterBulkCsvLimits as limits } from './bulk-csv.js';
import { customFieldCaptureLimit } from './custom-field-config.js';
import { customerFormFields } from './customer-fields.js';
import { vendorBulkFields } from './vendor-bulk-config.js';

const resources = {
  vendors: { association: 'vendor', ignored: new Set(),
    fields: { ...Object.fromEntries(vendorBulkFields.flatMap(field => [[field.source, field.key], [field.key, field.key]])), displayName: 'name' } },
  customers: { association: 'customer', ignored: new Set(),
    fields: { ...Object.fromEntries(customerFormFields.flatMap(field => [[field.source, field.key], [field.key, field.key]])), displayName: 'name' } },
  products: {
    association: 'product',
    fields: { name: 'name', description: 'description', key: 'key', abbr: 'abbreviation', abbreviation: 'abbreviation',
      job_template_id: 'jobTemplateId', jobTemplateId: 'jobTemplateId', tagIds: 'tagIds' },
    ignored: new Set(['line_items']),
  },
  'test-parameters': {
    association: 'parameter',
    fields: { order: 'order', name: 'name', description: 'description', key: 'key',
      lab: 'laboratoryId', lab_id: 'laboratoryId', laboratoryId: 'laboratoryId',
      scheme_abbr: 'schemeAbbreviation', schemeAbbreviation: 'schemeAbbreviation' },
    ignored: new Set(['product_id', 'product_key', 'product_ids', 'parent_id', 'isActive', 'isactive', 'is_nabl_accredited',
      'validate', 'min', 'max', 'uom', 'validation_inclusion', 'frequency_param', 'frequency_in_days', 'last_tested_at',
      'repeatability', 'reproducibility', 'operational_condition', 'critical_param', 'template_id', 'formula', 'formula_text',
      'custom_formula', 'is_derived', 'rate_card', 'has_spec_data', 'specification_data']),
  },
  methods: {
    association: 'method_of_analysis',
    fields: { name: 'name', moa_name: 'name', uuid: 'uuid', description: 'description',
      decimal_places: 'decimalScale', decimalscale: 'decimalScale', parse_num: 'parseNumber', parsenumber: 'parseNumber',
      user_access: 'accessUserIds', accessuserids: 'accessUserIds' },
    ignored: new Set(['est_time', 'charges', 'express_est_time', 'express_charges', 'size', 'min', 'max', 'uom', 'isactive',
      'associated_instruments', 'moa_line_items', 'moa_product_data', 'base_unit']),
  },
};

const invalid = message => new HttpError(400, 'invalid_bulk_columns', message);
const invalidDefinitions = () => new HttpError(409, 'invalid_bulk_definitions', 'Custom Field definitions changed or are incomplete. Reload before continuing.');

// Match the source MoA normalizer without changing the exact project-field key.
function columnKey(resource, header) {
  const key = header.trim();
  if (resource !== 'methods' || key.startsWith('project_field.')) return key;
  return key.replace(/[^a-z0-9_.]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase();
}

function customFieldsByKey(definitions, association) {
  if (!Array.isArray(definitions) || definitions.length > customFieldCaptureLimit) throw invalidDefinitions();
  const keys = new Map(); const ids = new Set();
  for (const definition of definitions) {
    if (!definition || definition.associatedWith !== association || definition.active === false ||
      typeof definition.key !== 'string' || !/^[a-z0-9_]{1,150}$/.test(definition.key)) throw invalidDefinitions();
    let id; let revision;
    try {
      id = uuid(definition.id, 'Custom Field').toLowerCase();
      revision = integer(definition.revision, 'Custom Field revision', 1, 2_147_483_647);
    } catch { throw invalidDefinitions(); }
    if (keys.has(definition.key) || ids.has(id)) throw invalidDefinitions();
    keys.set(definition.key, { fieldId: id, fieldRevision: revision, fieldKey: definition.key }); ids.add(id);
  }
  return keys;
}

// Definitions come from the active, tenant-scoped master reader. This maps columns, not values or permissions.
export function bindMasterBulkColumns(resource, headers, definitions = []) {
  if (typeof resource !== 'string' || !Object.hasOwn(resources, resource)) throw invalid('This master does not support these bulk columns.');
  if (!Array.isArray(headers) || headers.length === 0 || headers.length > limits.columns) throw invalid('Provide between 1 and 250 column headers.');
  const config = resources[resource]; const fields = customFieldsByKey(definitions, config.association);
  const keys = new Set(); const targets = new Set();
  return Array.from(headers, (header, index) => {
    if (typeof header !== 'string' || header.length > limits.cellCharacters || !header.isWellFormed() || header.includes('\0') ||
      !header.trim() || header.trim().length > limits.headerCharacters) throw invalid(`Column ${index + 1} needs a valid text header of at most 250 characters.`);
    const key = columnKey(resource, header);
    if (keys.has(key)) throw invalid(`Column ${index + 1} repeats an existing column header.`);
    keys.add(key);
    const column = { columnNumber: index + 1, header, key };
    if (config.ignored.has(key)) return { ...column, kind: 'ignored' };
    let binding; let target;
    if (Object.hasOwn(config.fields, key)) {
      binding = { kind: 'master', fieldName: config.fields[key] }; target = `master:${binding.fieldName}`;
    } else if (key.startsWith('project_field.')) {
      const field = fields.get(key.slice('project_field.'.length));
      if (!field) throw invalid(`Column ${index + 1} does not match an available Custom Field for this master.`);
      binding = { kind: 'custom_field', ...field }; target = `custom_field:${field.fieldId}`;
    } else throw invalid(`Column ${index + 1} (${header.trim()}) is not supported for this master.`);
    if (targets.has(target)) throw invalid(`Column ${index + 1} maps to a field already supplied by another column.`);
    targets.add(target);
    return { ...column, ...binding };
  });
}
