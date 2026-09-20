import { HttpError } from '../auth/errors.js';

// Declarative registry of the step-7 scalar settings fields added straight onto
// organization_laboratory_settings (Basic/Sample Page/TR/Test Parameters/Lab/NABL/Accounting/Tenant
// tabs). Keeping them data-driven, rather than one hand-written positional SQL statement per field,
// is what makes a ~50-field partial-patch UPDATE maintainable; see buildScalarPatch() below.
const nullableText = (max) => ({ kind: 'text', max, nullable: true });
const requiredText = (max) => ({ kind: 'text', max, nullable: false });
const boundedInt = (minimum, maximum, { nullable = false } = {}) => ({ kind: 'int', minimum, maximum, nullable });
const flag = () => ({ kind: 'bool', nullable: false });
const enumOf = (values, { nullable = true } = {}) => ({ kind: 'enum', values, nullable });

export const projectTabKeys = ['overview', 'stages', 'files', 'update_history', 'workflow', 'team', 'requests', 'planner',
  'critical_params', 'project_metadata', 'project_rationale', 'activity_log'];

export const scalarSettingsFields = {
  // Basic / Company Identity
  displayName: { column: 'display_name', ...nullableText(200) }, description: { column: 'description', ...nullableText(4000) },
  tagline: { column: 'tagline', ...nullableText(300) }, brandColor: { column: 'brand_color', ...nullableText(20) },
  nablNumber: { column: 'nabl_number', ...nullableText(100) }, locationCode: { column: 'location_code', ...nullableText(64) },
  entityName: { column: 'entity_name', ...requiredText(100) }, productEntityName: { column: 'product_entity_name', ...requiredText(100) },
  headerStyle: { column: 'header_style', ...enumOf(['fixed', 'floating']) },
  templateAclEnabled: { column: 'template_acl_enabled', ...flag() }, workflowBasedAcl: { column: 'workflow_based_acl', ...flag() },
  workflowBasedTemplates: { column: 'workflow_based_templates', ...flag() }, zebraPrintingEnabled: { column: 'zebra_printing_enabled', ...flag() },

  // Sample Page
  scrollableSampleListing: { column: 'scrollable_sample_listing', ...flag() }, autoInitializeSamples: { column: 'auto_initialize_samples', ...flag() },
  showBarcodeSection: { column: 'show_barcode_section', ...flag() }, showJobcardActions: { column: 'show_jobcard_actions', ...flag() },
  showDatasheetActions: { column: 'show_datasheet_actions', ...flag() }, showWorkflowNodes: { column: 'show_workflow_nodes', ...flag() },
  useTemplatizedAcknowledgement: { column: 'use_templatized_acknowledgement', ...flag() }, directlyPrintCoa: { column: 'directly_print_coa', ...flag() },
  allowManualResults: { column: 'allow_manual_results', ...flag() }, nonLimsMode: { column: 'non_lims_mode', ...flag() },
  limsLabel: { column: 'lims_label', ...nullableText(100) }, sampleAssociationMode: { column: 'sample_association_mode', ...enumOf(['single', 'multiple'], { nullable: false }) },

  // TR Settings
  sampleNumberScheme: { column: 'sample_number_scheme', ...requiredText(200) }, testRequestNumberScheme: { column: 'test_request_number_scheme', ...requiredText(200) },
  jobNumberScheme: { column: 'job_number_scheme', ...requiredText(200) },
  sampleNumberStart: { column: 'sample_number_start', ...boundedInt(1, 2_147_483_647) }, testRequestNumberStart: { column: 'test_request_number_start', ...boundedInt(1, 2_147_483_647) },
  instrumentBreakdownValidationEnabled: { column: 'instrument_breakdown_validation_enabled', ...flag() },
  minimumMaterialValidationEnabled: { column: 'minimum_material_validation_enabled', ...flag() },

  // Test Parameters Settings
  measurementUncertaintyEnabled: { column: 'measurement_uncertainty_enabled', ...flag() },

  // Lab Settings (reminder times/emails are their own list-valued module)
  reminderBeforeMinutes: { column: 'reminder_before_minutes', ...boundedInt(0, 100_000) },

  // NABL Settings extensions
  printNablOnNonNabl: { column: 'print_nabl_on_non_nabl', ...flag() }, onDemandUlr: { column: 'on_demand_ulr', ...flag() },
  generateUlrForAmendment: { column: 'generate_ulr_for_amendment', ...flag() }, includeFInUlr: { column: 'include_f_in_ulr', ...flag() },
  ulrStartNumber: { column: 'ulr_start_number', ...boundedInt(1, 2_147_483_647) }, ulrNumberPadding: { column: 'ulr_number_padding', ...boundedInt(1, 20) },
  retentionDays: { column: 'retention_days', ...boundedInt(0, 36_500) },

  // Accounting
  companyLegalName: { column: 'company_legal_name', ...nullableText(250) }, companyIdentificationNumber: { column: 'company_identification_number', ...nullableText(100) },
  companyTaxIdentifier: { column: 'company_tax_identifier', ...nullableText(100) }, companyAddress: { column: 'company_address', ...nullableText(4000) },

  // Tenant Settings extensions
  defaultRetentionPeriod: { column: 'default_retention_period', ...boundedInt(0, 36_500) }, defaultClassification: { column: 'default_classification', ...nullableText(150) },
  productLabel: { column: 'product_label', ...requiredText(100) }, sampleLabel: { column: 'sample_label', ...requiredText(100) },
  customerLabel: { column: 'customer_label', ...requiredText(100) }, vendorLabel: { column: 'vendor_label', ...requiredText(100) },
  sampleScheme: { column: 'sample_scheme', ...nullableText(200) },
  minimumPasswordLength: { column: 'minimum_password_length', ...boundedInt(8, 200) }, maximumLoginAttempts: { column: 'maximum_login_attempts', ...boundedInt(1, 20) },
  supportSlug: { column: 'support_slug', ...nullableText(100) },
  environmentDataIntervalMinutes: { column: 'environment_data_interval_minutes', ...boundedInt(1, 100_000, { nullable: true }) },
  projectDefaultPage: { column: 'project_default_page', ...enumOf(projectTabKeys) },
};

const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
function validateTime(value, label) {
  if (value === null) return null;
  if (typeof value !== 'string' || !timePattern.test(value)) throw new HttpError(400, 'invalid_input', `${label} must use the HH:MM format.`);
  return `${value}:00`;
}

function validateScalar(key, spec, value) {
  const label = key;
  if (value === null) {
    if (!spec.nullable) throw new HttpError(400, 'invalid_input', `${label} is required.`);
    return null;
  }
  if (spec.kind === 'bool') {
    if (typeof value !== 'boolean') throw new HttpError(400, 'invalid_input', `${label} must be true or false.`);
    return value;
  }
  if (spec.kind === 'int') {
    if (!Number.isSafeInteger(value) || value < spec.minimum || value > spec.maximum) {
      throw new HttpError(400, 'invalid_input', `${label} must be an integer between ${spec.minimum} and ${spec.maximum}.`);
    }
    return value;
  }
  if (spec.kind === 'enum') {
    if (typeof value !== 'string' || !spec.values.includes(value)) throw new HttpError(400, 'invalid_input', `${label} must be one of: ${spec.values.join(', ')}.`);
    return value;
  }
  // text
  if (typeof value !== 'string' || !value.isWellFormed() || value.includes('\0')) throw new HttpError(400, 'invalid_input', `${label} must be text.`);
  const trimmed = value.trim();
  if (trimmed.length > spec.max) throw new HttpError(400, 'invalid_input', `${label} must be at most ${spec.max} characters.`);
  if (!spec.nullable && !trimmed.length) throw new HttpError(400, 'invalid_input', `${label} is required.`);
  return trimmed;
}

// Returns { columns: [...], values: [...] } for only the keys present in input, so the caller can
// build a partial UPDATE ... SET clause without hand-listing dozens of positional parameters.
export function scalarSettingsPatch(input) {
  const columns = []; const values = [];
  for (const [key, spec] of Object.entries(scalarSettingsFields)) {
    if (!Object.hasOwn(input, key)) continue;
    columns.push(spec.column);
    values.push(validateScalar(key, spec, input[key]));
  }
  for (const [key, column] of [['operatingStartTime', 'operating_start_time'], ['operatingEndTime', 'operating_end_time']]) {
    if (!Object.hasOwn(input, key)) continue;
    columns.push(column); values.push(validateTime(input[key], key));
  }
  return { columns, values };
}

// Mirrors the DEFAULT clauses in drizzle/0202_organization_settings_expansion.sql, for the one
// case (no settings row saved yet) where the database default cannot simply apply itself.
export const scalarSettingsDefaults = {
  displayName: null, description: null, tagline: null, brandColor: null, nablNumber: null, locationCode: null,
  entityName: 'Sample', productEntityName: 'Product', headerStyle: null,
  templateAclEnabled: false, workflowBasedAcl: false, workflowBasedTemplates: false, zebraPrintingEnabled: false,
  scrollableSampleListing: true, autoInitializeSamples: false, showBarcodeSection: true, showJobcardActions: true,
  showDatasheetActions: true, showWorkflowNodes: true, useTemplatizedAcknowledgement: false, directlyPrintCoa: false,
  allowManualResults: false, nonLimsMode: false, limsLabel: null, sampleAssociationMode: 'single',
  sampleNumberScheme: 'SMP-{current_year:yyyy}-{sample_counter}', testRequestNumberScheme: 'TR-{current_year:yyyy}-{tr_counter}',
  jobNumberScheme: 'JOB-{current_year:yyyy}-{job_countall}', sampleNumberStart: 1, testRequestNumberStart: 1,
  instrumentBreakdownValidationEnabled: true, minimumMaterialValidationEnabled: true, measurementUncertaintyEnabled: false,
  reminderBeforeMinutes: 60, printNablOnNonNabl: false, onDemandUlr: false, generateUlrForAmendment: false,
  ulrStartNumber: 1, includeFInUlr: false, ulrNumberPadding: 6, retentionDays: 0,
  companyLegalName: null, companyIdentificationNumber: null, companyTaxIdentifier: null, companyAddress: null,
  defaultRetentionPeriod: 0, defaultClassification: null, productLabel: 'Product', sampleLabel: 'Sample',
  customerLabel: 'Customer', vendorLabel: 'Vendor', sampleScheme: null, minimumPasswordLength: 12, maximumLoginAttempts: 5,
  supportSlug: null, environmentDataIntervalMinutes: null, projectDefaultPage: null,
  operatingStartTime: null, operatingEndTime: null,
};
