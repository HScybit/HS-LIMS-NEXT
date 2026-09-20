import { sql } from 'drizzle-orm';
import { pgTable, pgView, uuid, text, boolean, timestamp, integer, numeric, doublePrecision, date, primaryKey, unique, uniqueIndex, index, check, foreignKey } from 'drizzle-orm/pg-core';
import { organizations, memberships } from './schema.js';
import { templates } from './template-schema.js';
import { customFieldDefinitions } from './custom-field-schema.js';

const tenant = () => uuid('organization_id').notNull().references(() => organizations.id);
const time = (name) => timestamp(name, { withTimezone: true, mode: 'date' });
const identity = () => ({ organizationId: tenant(), id: uuid('id').notNull().defaultRandom() });
const metadata = () => ({ code: text('code').notNull(), name: text('name').notNull(), active: boolean('active').notNull().default(true),
  revision: integer('revision').notNull().default(1), createdAt: time('created_at').notNull().defaultNow(), updatedAt: time('updated_at').notNull().defaultNow() });
const key = (t) => primaryKey({ columns: [t.organizationId, t.id] });
const link = (t, column, target, name) => foreignKey({ name, columns: [t.organizationId, column], foreignColumns: [target.organizationId, target.id] });
const named = (t, prefix) => [key(t), uniqueIndex(`${prefix}_code_key`).on(t.organizationId, sql`lower(${t.code})`),
  check(`${prefix}_metadata`, sql`length(trim(${t.code})) between 1 and 64 and length(trim(${t.name})) between 1 and 250 and ${t.revision} > 0`)];
const finite = (column) => sql`${column} not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)`;

// Supporting scientific masters are scoped by their sample/test/report consumers.
// Their management interfaces are implemented separately from sample registration.
export const measurementUnits = pgTable('measurement_units', {
  ...identity(), ...metadata(), symbol: text('symbol').notNull(), dimension: text('dimension'),
}, (t) => [...named(t, 'measurement_units'), check('measurement_units_symbol', sql`length(${t.symbol}) between 1 and 32`)]);

// Shared Unit identity supports User Management and laboratory authoring.
export const businessUnits = pgTable('business_units', {
  organizationId: uuid('organization_id').notNull().references(() => organizations.id), id: uuid('id').notNull().defaultRandom(),
  code: text('code').notNull(), name: text('name').notNull(), description: text('description'), active: boolean('active').notNull().default(true),
  revision: integer('revision').notNull().default(1), createdAt: time('created_at').notNull().defaultNow(), updatedAt: time('updated_at').notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.organizationId, t.id] }), uniqueIndex('business_units_code_key').on(t.organizationId, sql`lower(${t.code})`),
  check('business_unit_fields', sql`length(trim(${t.code})) between 1 and 64 and length(trim(${t.name})) between 1 and 200
    and (${t.description} is null or length(${t.description})<=2000) and ${t.revision}>0`)]);

export const laboratories = pgTable('laboratories', {
  ...identity(), ...metadata(), description: text('description'), abbreviation: text('abbreviation'), businessUnitId: uuid('business_unit_id'),
  headUserId: uuid('head_user_id'), delegateUserId: uuid('delegate_user_id'),
  minimumTemperature: text('minimum_temperature_text'), maximumTemperature: text('maximum_temperature_text'),
  minimumHumidity: text('minimum_humidity_text'), maximumHumidity: text('maximum_humidity_text'),
}, (t) => [...named(t, 'laboratories'), link(t, t.businessUnitId, businessUnits, 'laboratory_unit_fk'),
  foreignKey({ name: 'laboratory_head_user_fk', columns: [t.organizationId, t.headUserId], foreignColumns: [memberships.organizationId, memberships.userId] }),
  foreignKey({ name: 'laboratory_delegate_user_fk', columns: [t.organizationId, t.delegateUserId], foreignColumns: [memberships.organizationId, memberships.userId] })]);

export const sampleCategories = pgTable('sample_categories', {
  ...identity(), ...metadata(), description: text('description').notNull().default(''), abbreviation: text('abbreviation').notNull(),
  retentionDays: integer('retention_days'), estimatedTimeInDays: doublePrecision('estimated_time_in_days').notNull().default(0),
  enableEvents: boolean('enable_events').notNull().default(false), enableReissue: boolean('enable_reissue').notNull().default(false),
  saveRequestId: uuid('save_request_id'),
}, (t) => [...named(t, 'sample_categories'), check('sample_categories_settings', sql`length(trim(${t.abbreviation})) between 1 and 64 and ${t.retentionDays} >= 0 and ${t.estimatedTimeInDays} >= 0`),
  check('sample_categories_estimate_finite', sql`${t.estimatedTimeInDays} not in ('NaN'::double precision, 'Infinity'::double precision, '-Infinity'::double precision)`)]);

// Plain current-state associations, consistent with sample_category_templates/workflows: no per-row history of their own.
export const sampleCategoryUsers = pgTable('sample_category_users', {
  organizationId: tenant(), sampleCategoryId: uuid('sample_category_id').notNull(), userId: uuid('user_id').notNull(),
}, (t) => [primaryKey({ columns: [t.organizationId, t.sampleCategoryId, t.userId] }), link(t, t.sampleCategoryId, sampleCategories, 'sample_category_user_category_fk'),
  foreignKey({ name: 'sample_category_user_member_fk', columns: [t.organizationId, t.userId], foreignColumns: [memberships.organizationId, memberships.userId] })]);

export const sampleCategoryIncludedFields = pgTable('sample_category_included_fields', {
  organizationId: tenant(), sampleCategoryId: uuid('sample_category_id').notNull(), fieldDefinitionId: uuid('field_definition_id').notNull(),
}, (t) => [primaryKey({ columns: [t.organizationId, t.sampleCategoryId, t.fieldDefinitionId] }), link(t, t.sampleCategoryId, sampleCategories, 'sample_category_included_field_category_fk'),
  foreignKey({ name: 'sample_category_included_field_definition_fk', columns: [t.organizationId, t.fieldDefinitionId], foreignColumns: [customFieldDefinitions.organizationId, customFieldDefinitions.id] })]);

export const products = pgTable('products', {
  ...identity(), ...metadata(), description: text('description').notNull().default(''), abbreviation: text('abbreviation'), jobTemplateId: uuid('job_template_id'),
  tagCount: integer('tag_count').notNull().default(0), saveRequestId: uuid('save_request_id'),
  customFieldCount: integer('custom_field_count').notNull().default(0), customFieldsProvided: boolean('custom_fields_provided').notNull().default(false),
}, (t) => [...named(t, 'products'), link(t, t.jobTemplateId, templates), check('product_tag_count', sql`${t.tagCount} >= 0`),
  check('product_custom_field_count', sql`${t.customFieldCount} between 0 and 500`),
  index('products_scheme_order').on(t.organizationId, t.createdAt, t.updatedAt, t.id).where(sql`${t.active}`)]);

export const productSampleCategories = pgTable('product_sample_categories', {
  organizationId: tenant(), productId: uuid('product_id').notNull(), sampleCategoryId: uuid('sample_category_id').notNull(),
}, (t) => [primaryKey({ columns: [t.organizationId, t.productId, t.sampleCategoryId] }), link(t, t.productId, products), link(t, t.sampleCategoryId, sampleCategories)]);

// Registration uses these links to filter products; this is not a tag manager.
export const tags = pgTable('tags', { ...identity(), ...metadata() }, (t) => named(t, 'tags'));
export const productTags = pgTable('product_tags', {
  organizationId: tenant(), productId: uuid('product_id').notNull(), tagId: uuid('tag_id').notNull(),
}, (t) => [primaryKey({ columns: [t.organizationId, t.productId, t.tagId] }), link(t, t.productId, products), link(t, t.tagId, tags)]);

export const customers = pgTable('customers', {
  ...identity(), ...metadata(), legalName: text('legal_name').notNull(), abbreviation: text('abbreviation'), taxIdentifier: text('tax_identifier'),
  creditDays: integer('credit_days').notNull().default(0),
  totalBalance: numeric('total_balance', { precision: 20, scale: 2 }).notNull().default('0'),
  defaultInvoiceNotes: text('default_invoice_notes'), feedbackApplicable: boolean('feedback_applicable').notNull().default(false),
  igstPercent: numeric('igst_percent', { precision: 7, scale: 4 }).notNull().default('18'),
  sgstPercent: numeric('sgst_percent', { precision: 7, scale: 4 }).notNull().default('0'),
  cgstPercent: numeric('cgst_percent', { precision: 7, scale: 4 }).notNull().default('0'),
  discountPercent: numeric('discount_percent', { precision: 7, scale: 4 }).notNull().default('0'),
  isKaleenBandhu: boolean('is_kaleen_bandhu').notNull().default(false), retired: boolean('retired').notNull().default(false),
  saveRequestId: uuid('save_request_id'), saveSource: text('save_source'),
  customFieldCount: integer('custom_field_count').notNull().default(0), customFieldsProvided: boolean('custom_fields_provided').notNull().default(false),
}, (t) => [key(t), uniqueIndex('customers_code_key').on(t.organizationId, sql`lower(${t.code})`).where(sql`not ${t.retired}`),
  check('customers_metadata', sql`length(trim(${t.code})) between 1 and 64 and length(trim(${t.name})) between 1 and 250 and ${t.revision} > 0`),
  check('customers_details', sql`length(trim(${t.legalName})) between 1 and 250 and ${t.creditDays} between 0 and 3650`),
  check('customer_master_values', sql`${finite(t.totalBalance)} and ${t.igstPercent} between 0 and 100 and ${t.sgstPercent} between 0 and 100
    and ${t.cgstPercent} between 0 and 100 and ${t.discountPercent} between 0 and 100
    and (not ${t.retired} or not ${t.active}) and ${t.customFieldCount} between 0 and 500
    and ((${t.saveRequestId} is null and ${t.saveSource} is null) or (${t.saveRequestId} is not null and ${t.saveSource} is not null and ${t.saveSource} in ('master','registration')))`),
  index('customer_scheme_order').on(t.organizationId, t.createdAt, t.updatedAt, t.id).where(sql`not ${t.retired}`),
]);

export const customerAddresses = pgTable('customer_addresses', {
  ...identity(), customerId: uuid('customer_id').notNull(), addressType: text('address_type').notNull(), attentionTo: text('attention_to'),
  line1: text('line_1'), line2: text('line_2'), city: text('city'), state: text('state'), postalCode: text('postal_code'),
  countryCode: text('country_code'), freeformAddress: text('freeform_address'), isDefault: boolean('is_default').notNull().default(false),
}, (t) => [key(t), link(t, t.customerId, customers), uniqueIndex('customer_default_address_key').on(t.organizationId, t.customerId, t.addressType).where(sql`${t.isDefault}`),
  index('customer_address_parent_idx').on(t.organizationId, t.customerId, t.addressType, t.id),
  check('customer_address_type', sql`${t.addressType} in ('billing', 'shipping', 'registered', 'other') and length(${t.countryCode}) = 2`),
  check('customer_address_representation', sql`(${t.freeformAddress} is not null and length(trim(${t.freeformAddress})) between 1 and 4000
    and num_nonnulls(${t.attentionTo}, ${t.line1}, ${t.line2}, ${t.city}, ${t.state}, ${t.postalCode}, ${t.countryCode}) = 0)
    or (${t.freeformAddress} is null and ${t.line1} is not null and ${t.city} is not null and ${t.countryCode} is not null)`)]);

export const customerContacts = pgTable('customer_contacts', {
  ...identity(), customerId: uuid('customer_id').notNull(), name: text('name').notNull(), email: text('email'), phone: text('phone'),
  designation: text('designation'), isPrimary: boolean('is_primary').notNull().default(false),
}, (t) => [key(t), link(t, t.customerId, customers), uniqueIndex('customer_primary_contact_key').on(t.organizationId, t.customerId).where(sql`${t.isPrimary}`),
  index('customer_contact_parent_idx').on(t.organizationId, t.customerId, t.id),
  check('customer_contact_details', sql`length(trim(${t.name})) between 1 and 200 and (nullif(trim(${t.email}), '') is not null or nullif(trim(${t.phone}), '') is not null)`)]);

// Quotation selection is a bounded reference dependency, not a billing module.
// Registration and workflow conditions read only their scientific references.
export const laboratoryCustomerReferences = pgView('laboratory_customer_references', {
  organizationId: uuid('organization_id'), id: uuid('id'), code: text('code'), name: text('name'), legalName: text('legal_name'), active: boolean('active'),
}).with({ securityBarrier: true, securityInvoker: false }).as(sql`
  SELECT customer.organization_id,customer.id,customer.code,customer.name,customer.legal_name,customer.active
  FROM public.customers customer
  WHERE customer.organization_id IS NOT DISTINCT FROM (SELECT public.organization_module_scope())
    AND (SELECT public.laboratory_can_read_customer_reference())
`);

export const laboratoryCustomerAddressReferences = pgView('laboratory_customer_address_references', {
  organizationId: uuid('organization_id'), id: uuid('id'), customerId: uuid('customer_id'), addressType: text('address_type'), attentionTo: text('attention_to'),
  line1: text('line_1'), line2: text('line_2'), city: text('city'), state: text('state'), postalCode: text('postal_code'), countryCode: text('country_code'),
  freeformAddress: text('freeform_address'), isDefault: boolean('is_default'),
}).with({ securityBarrier: true, securityInvoker: false }).as(sql`
  SELECT address.organization_id,address.id,address.customer_id,address.address_type,address.attention_to,
    address.line_1,address.line_2,address.city,address.state,address.postal_code,address.country_code,
    address.freeform_address,address.is_default
  FROM public.customer_addresses address
  WHERE address.organization_id IS NOT DISTINCT FROM (SELECT public.organization_module_scope())
    AND (SELECT public.laboratory_can_read_customer_reference())
`);

export const customerQuotations = pgTable('customer_quotations', {
  ...identity(), customerId: uuid('customer_id').notNull(), quotationNumber: text('quotation_number').notNull(),
  quotationDate: date('quotation_date', { mode: 'string' }).notNull(), validUntil: date('valid_until', { mode: 'string' }),
  currencyCode: text('currency_code').notNull().default('INR'), totalAmount: numeric('total_amount').notNull().default('0'),
  status: text('status').notNull().default('approved'), createdAt: time('created_at').notNull().defaultNow(),
}, (t) => [key(t), link(t, t.customerId, customers), unique('customer_quotation_number_key').on(t.organizationId, t.quotationNumber),
  unique('customer_quotation_owner_key').on(t.organizationId, t.customerId, t.id), index('customer_quotation_date_idx').on(t.organizationId, t.customerId, t.quotationDate),
  check('customer_quotation_details', sql`${t.status} in ('draft', 'approved', 'expired', 'cancelled') and ${t.totalAmount} >= 0 and ${finite(t.totalAmount)} and length(${t.currencyCode}) = 3 and (${t.validUntil} is null or ${t.validUntil} >= ${t.quotationDate})`)]);

export const testParameters = pgTable('test_parameters', {
  ...identity(), ...metadata(), description: text('description').notNull().default(''), laboratoryId: uuid('laboratory_id'), measurementUnitId: uuid('measurement_unit_id'),
  defaultScale: integer('default_scale').notNull().default(2), masterKey: text('master_key').notNull(), schemeAbbreviation: text('scheme_abbreviation').notNull(),
  displayOrder: integer('display_order').notNull().default(0),
  uncertaintyConfigured: boolean('uncertainty_configured').notNull().default(false), saveRequestId: uuid('save_request_id'),
  customFieldCount: integer('custom_field_count').notNull().default(0), customFieldsProvided: boolean('custom_fields_provided').notNull().default(false),
}, (t) => [check('parameter_custom_field_count', sql`${t.customFieldCount} between 0 and 500`), ...named(t, 'test_parameters'), link(t, t.laboratoryId, laboratories), link(t, t.measurementUnitId, measurementUnits),
  uniqueIndex('test_parameter_master_key').on(t.organizationId, sql`lower(${t.masterKey})`), uniqueIndex('test_parameter_scheme_key').on(t.organizationId, sql`lower(${t.schemeAbbreviation})`),
  check('test_parameter_display', sql`${t.defaultScale} between 0 and 12 and ${t.displayOrder} >= 0 and length(trim(${t.masterKey})) between 1 and 64 and length(trim(${t.schemeAbbreviation})) between 1 and 64`)]);

export const methodsOfAnalysis = pgTable('methods_of_analysis', {
  ...identity(), ...metadata(), description: text('description').notNull().default(''), methodUuid: text('method_uuid').notNull(),
  decimalScale: integer('decimal_scale').notNull().default(2), parseNumber: boolean('parse_number').notNull().default(false),
  accessUserCount: integer('access_user_count').notNull().default(0), saveRequestId: uuid('save_request_id'),
  customFieldCount: integer('custom_field_count').notNull().default(0), customFieldsProvided: boolean('custom_fields_provided').notNull().default(false),
}, (t) => [...named(t, 'methods_of_analysis'), uniqueIndex('method_uuid_key').on(t.organizationId, sql`lower(${t.methodUuid})`),
  check('method_custom_field_count', sql`${t.customFieldCount} between 0 and 500`),
  check('method_access_user_count', sql`${t.accessUserCount} between 0 and 500`),
  check('method_number_settings', sql`${t.decimalScale} between 0 and 12 and length(trim(${t.methodUuid})) between 1 and 100`)]);

export const parameterMethods = pgTable('parameter_methods', {
  organizationId: tenant(), testParameterId: uuid('test_parameter_id').notNull(), methodId: uuid('method_id').notNull(), isDefault: boolean('is_default').notNull().default(false),
}, (t) => [primaryKey({ columns: [t.organizationId, t.testParameterId, t.methodId] }), link(t, t.testParameterId, testParameters), link(t, t.methodId, methodsOfAnalysis),
  uniqueIndex('parameter_default_method_key').on(t.organizationId, t.testParameterId).where(sql`${t.isDefault}`)]);

export const decisionRules = pgTable('decision_rules', {
  ...identity(), code: text('code').notNull(), name: text('name'), active: boolean('active').notNull().default(true),
  revision: integer('revision').notNull().default(1), createdAt: time('created_at').notNull().defaultNow(), updatedAt: time('updated_at').notNull().defaultNow(),
  saveRequestId: uuid('save_request_id'), parentDecisionRuleId: uuid('parent_decision_rule_id'), isTestGroupParent: boolean('is_test_group_parent').notNull().default(false),
  testGroupName: text('test_group_name'), testGroupUid: text('test_group_uid'),
  productId: uuid('product_id').notNull(), testParameterId: uuid('test_parameter_id').notNull(), methodId: uuid('method_id'),
  templateId: uuid('template_id'), cutoffValue: numeric('cutoff_value').notNull().default('0'), greaterThanText: text('greater_than_text'), lessThanText: text('less_than_text'),
  minimumText: text('minimum_text'), maximumText: text('maximum_text'), unitOfMeasure: text('unit_of_measure'), isNabl: boolean('is_nabl').notNull().default(false),
  minimumSize: text('minimum_size'), estimatedTimeInDays: numeric('estimated_time_in_days').notNull().default('0'), estimatedCharges: numeric('estimated_charges').notNull().default('0'),
  expressTimeInDays: numeric('express_time_in_days').notNull().default('0'), expressCharges: numeric('express_charges').notNull().default('0'),
  resultRepresentation: text('result_representation'), defaultNarration: text('default_narration'),
  detectableUpperLimit: numeric('detectable_upper_limit'), detectableLowerLimit: numeric('detectable_lower_limit'),
  detectableUpperLimitText: text('detectable_upper_limit_text'), detectableLowerLimitText: text('detectable_lower_limit_text'),
  showDetectableLimitText: boolean('show_detectable_limit_text').notNull().default(false), showStandardLimitText: boolean('show_standard_limit_text').notNull().default(false),
  conformanceLimit: numeric('conformance_limit'), discipline: text('discipline'), ruleGroup: text('rule_group'), uniqueKey: text('unique_key'),
  hasFormula: boolean('has_formula').notNull().default(false), formula: text('formula'), formulaText: text('formula_text'),
  hasDerivedFormula: boolean('has_derived_formula').notNull().default(false), customFormula: text('custom_formula'), formulaExpression: text('formula_expression'),
}, (t) => [key(t), uniqueIndex('decision_rules_code_key').on(t.organizationId, sql`lower(${t.code})`),
  check('decision_rules_metadata', sql`length(trim(${t.code})) between 1 and 64 and (${t.name} is null or length(trim(${t.name})) between 1 and 250) and ${t.revision} > 0`),
  link(t, t.productId, products), link(t, t.testParameterId, testParameters), link(t, t.methodId, methodsOfAnalysis), link(t, t.templateId, templates),
  foreignKey({ name: 'decision_rule_parent_fk', columns: [t.organizationId, t.parentDecisionRuleId], foreignColumns: [t.organizationId, t.id] }),
  uniqueIndex('decision_rule_active_scope_key').on(t.organizationId, t.productId, t.testParameterId, t.methodId).where(sql`${t.active}`),
  uniqueIndex('decision_rule_unique_key').on(t.organizationId, sql`lower(${t.uniqueKey})`).where(sql`${t.uniqueKey} is not null`),
  check('decision_rule_finite_numbers', sql`${finite(t.cutoffValue)} and ${finite(t.detectableUpperLimit)} and ${finite(t.detectableLowerLimit)} and ${finite(t.conformanceLimit)}`),
  check('decision_rule_estimates', sql`${t.estimatedTimeInDays} >= 0 and ${finite(t.estimatedTimeInDays)} and ${t.estimatedCharges} >= 0 and ${finite(t.estimatedCharges)} and ${t.expressTimeInDays} >= 0 and ${finite(t.expressTimeInDays)} and ${t.expressCharges} >= 0 and ${finite(t.expressCharges)}`),
  check('decision_rule_test_group_fields', sql`(${t.isTestGroupParent} and ${t.testGroupName} is not null and length(trim(${t.testGroupName})) between 1 and 200
      and ${t.testGroupUid} is not null and ${t.testGroupUid} ~ '^[A-Za-z0-9_]+$' and length(${t.testGroupUid}) between 1 and 100 and ${t.parentDecisionRuleId} is null)
    or (not ${t.isTestGroupParent} and ${t.testGroupName} is null and ${t.testGroupUid} is null)`),
  check('decision_rule_formula_fields', sql`(not ${t.hasFormula} or (${t.formula} is not null and length(${t.formula}) between 1 and 5000))
    and (not ${t.hasDerivedFormula} or (${t.customFormula} is not null and length(${t.customFormula}) between 1 and 5000))
    and (${t.formulaText} is null or length(${t.formulaText}) <= 5000) and (${t.formulaExpression} is null or length(${t.formulaExpression}) <= 5000)`)]);

export const decisionRuleSampleCategories = pgTable('decision_rule_sample_categories', {
  organizationId: tenant(), decisionRuleId: uuid('decision_rule_id').notNull(), sampleCategoryId: uuid('sample_category_id').notNull(),
}, (t) => [primaryKey({ columns: [t.organizationId, t.decisionRuleId, t.sampleCategoryId] }), link(t, t.decisionRuleId, decisionRules, 'decision_rule_sample_category_rule_fk'),
  link(t, t.sampleCategoryId, sampleCategories, 'decision_rule_sample_category_category_fk')]);

export const decisionRuleFormulaVariables = pgTable('decision_rule_formula_variables', {
  organizationId: tenant(), id: uuid('id').notNull().defaultRandom(), decisionRuleId: uuid('decision_rule_id').notNull(),
  key: text('key').notNull(), label: text('label').notNull(), displayOrder: integer('display_order').notNull().default(0),
}, (t) => [primaryKey({ name: 'decision_rule_formula_variable_pk', columns: [t.organizationId, t.id] }),
  link(t, t.decisionRuleId, decisionRules, 'decision_rule_formula_variable_rule_fk'),
  unique('decision_rule_formula_variable_key').on(t.organizationId, t.decisionRuleId, t.key),
  index('decision_rule_formula_variable_order').on(t.organizationId, t.decisionRuleId, t.displayOrder),
  check('decision_rule_formula_variable_fields', sql`${t.key} ~ '^[A-Za-z0-9_]+$' and length(${t.key}) between 1 and 64
    and length(trim(${t.label})) between 1 and 200 and ${t.displayOrder} >= 0`)]);

export const decisionRuleLimits = pgTable('decision_rule_limits', {
  ...identity(), decisionRuleId: uuid('decision_rule_id').notNull(), lowerLimit: numeric('lower_limit'), upperLimit: numeric('upper_limit'),
  lowerInclusive: boolean('lower_inclusive').notNull().default(true), upperInclusive: boolean('upper_inclusive').notNull().default(true),
  outcome: text('outcome').notNull(), narration: text('narration'), displayOrder: integer('display_order').notNull().default(0),
}, (t) => [key(t), link(t, t.decisionRuleId, decisionRules), index('decision_rule_limits_order').on(t.organizationId, t.decisionRuleId, t.displayOrder),
  check('decision_rule_limit_bounds', sql`num_nonnulls(${t.lowerLimit}, ${t.upperLimit}) >= 1 and ${finite(t.lowerLimit)} and ${finite(t.upperLimit)} and (${t.lowerLimit} is null or ${t.upperLimit} is null or ${t.lowerLimit} <= ${t.upperLimit}) and ${t.displayOrder} >= 0`)]);

export const sampleCategoryTemplates = pgTable('sample_category_templates', {
  organizationId: tenant(), sampleCategoryId: uuid('sample_category_id').notNull(), templateId: uuid('template_id').notNull(), purpose: text('purpose').notNull(),
  isDefault: boolean('is_default').notNull().default(false),
}, (t) => [primaryKey({ columns: [t.organizationId, t.sampleCategoryId, t.templateId, t.purpose] }), link(t, t.sampleCategoryId, sampleCategories), link(t, t.templateId, templates),
  uniqueIndex('sample_category_default_template_key').on(t.organizationId, t.sampleCategoryId, t.purpose).where(sql`${t.isDefault}`),
  check('sample_category_template_purpose', sql`${t.purpose} in ('sample', 'datasheet', 'report', 'label')`)]);
