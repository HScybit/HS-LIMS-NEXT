import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, boolean, timestamp, integer, bigint, numeric, date, primaryKey, unique, uniqueIndex, index, check, foreignKey } from 'drizzle-orm/pg-core';
import { organizations, memberships } from './schema.js';
import { templates, templateInstances, templateOccurrences, templateValues } from './template-schema.js';
import { sampleCategories, products, productSampleCategories, customers, customerQuotations, laboratories, measurementUnits, testParameters, methodsOfAnalysis, parameterMethods, decisionRules, tags } from './master-schema.js';
import { workflowVersions, workflowStates, workflowTransitions } from './workflow-schema.js';

const time = (name) => timestamp(name, { withTimezone: true, mode: 'date' });
const tenant = () => uuid('organization_id').notNull().references(() => organizations.id);
const identity = () => ({ organizationId: tenant(), id: uuid('id').notNull().defaultRandom() });
const key = (t) => primaryKey({ columns: [t.organizationId, t.id] });
const link = (t, column, target) => foreignKey({ columns: [t.organizationId, column], foreignColumns: [target.organizationId, target.id] });
const actor = (t, column) => foreignKey({ columns: [t.organizationId, column], foreignColumns: [memberships.organizationId, memberships.userId] });
const finite = (column) => sql`${column} not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)`;
const amount = (value, currency) => sql`(${value} is null and ${currency} is null) or (${value} is not null and ${currency} is not null and ${value} >= 0 and ${finite(value)} and ${currency} ~ '^[A-Z]{3}$')`;

export const numberSequences = pgTable('number_sequences', {
  organizationId: tenant(), sequenceKey: text('sequence_key').notNull(), periodKey: text('period_key').notNull(), prefix: text('prefix').notNull(),
  minimumWidth: integer('minimum_width').notNull().default(6), nextValue: bigint('next_value', { mode: 'bigint' }).notNull().default(sql`1`),
}, (t) => [primaryKey({ columns: [t.organizationId, t.sequenceKey, t.periodKey] }),
  check('number_sequence_shape', sql`${t.sequenceKey} in ('sample', 'test_request', 'job', 'sample_report') and ${t.periodKey} ~ '^[0-9]{4}$' and ${t.nextValue} > 0 and ${t.minimumWidth} between 1 and 20`)]);

export const samples = pgTable('samples', {
  ...identity(), sampleNumber: text('sample_number').notNull(), sampleCategoryId: uuid('sample_category_id').notNull(), customerId: uuid('customer_id'), customerQuotationId: uuid('customer_quotation_id'),
  templateInstanceId: uuid('template_instance_id'),
  categoryCode: text('category_code').notNull(), categoryName: text('category_name').notNull(), categoryAbbreviation: text('category_abbreviation').notNull(),
  customerCode: text('customer_code'), customerName: text('customer_name'), customerLegalName: text('customer_legal_name'), customerAddress: text('customer_address'),
  customerReference: text('customer_reference'), sampleType: text('sample_type').notNull().default('customer'), status: text('status').notNull().default('registered'),
  receivedAt: time('received_at').notNull(), registeredAt: time('registered_at').notNull().defaultNow(), dueAt: time('due_at'),
  quantity: numeric('quantity'), description: text('description'), storageLocation: text('storage_location'), retentionDueOn: date('retention_due_on', { mode: 'string' }),
  iqcType: text('iqc_type'), participantCount: integer('participant_count'), ilcMode: text('ilc_mode'), modeOfReceipt: text('mode_of_receipt'),
  totalAmount: numeric('total_amount'), currencyCode: text('currency_code'), receivedByName: text('received_by_name'), collectionDetails: text('collection_details'),
  amendmentRemarks: text('amendment_remarks'), complaintRemarks: text('complaint_remarks'),
  revision: integer('revision').notNull().default(1), registeredBy: uuid('registered_by').notNull(), updatedAt: time('updated_at').notNull().defaultNow(),
}, (t) => [key(t), link(t, t.sampleCategoryId, sampleCategories), link(t, t.customerId, customers), actor(t, t.registeredBy), link(t, t.templateInstanceId, templateInstances),
  unique('sample_template_instance_key').on(t.organizationId, t.templateInstanceId),
  foreignKey({ columns: [t.organizationId, t.customerId, t.customerQuotationId], foreignColumns: [customerQuotations.organizationId, customerQuotations.customerId, customerQuotations.id] }),
  unique('sample_number_key').on(t.organizationId, t.sampleNumber), index('samples_received_idx').on(t.organizationId, t.receivedAt, t.id), index('samples_status_idx').on(t.organizationId, t.status, t.receivedAt),
  check('sample_type', sql`${t.sampleType} in ('customer', 'internal', 'quality_control', 'proficiency', 'interlaboratory', 'amendment', 'complaint')`),
  check('sample_status', sql`${t.status} in ('registered', 'in_progress', 'on_hold', 'completed', 'rejected', 'cancelled') and ${t.revision} > 0`),
  check('sample_dates_quantity', sql`(${t.dueAt} is null or ${t.dueAt} >= ${t.receivedAt}) and (${t.quantity} is null or (${t.quantity} > 0 and ${finite(t.quantity)}))`),
  check('sample_customer', sql`(${t.sampleType} <> 'customer' or ${t.customerId} is not null) and (${t.customerQuotationId} is null or ${t.customerId} is not null)
    and ((${t.customerId} is null and num_nonnulls(${t.customerCode}, ${t.customerName}, ${t.customerLegalName}) = 0)
      or (${t.customerId} is not null and ${t.customerCode} is not null and ${t.customerName} is not null and ${t.customerLegalName} is not null and nullif(trim(${t.customerAddress}), '') is not null))`),
  check('sample_iqc', sql`(${t.iqcType} is null or ${t.iqcType} in ('repetition', 'retest', 'blind', 'int_lab')) and (${t.participantCount} is null or ${t.participantCount} > 0)
    and (${t.sampleType} = 'quality_control' or (${t.iqcType} is null and ${t.participantCount} is null))
    and (${t.iqcType} is distinct from 'int_lab' or ${t.participantCount} is not null)`),
  check('sample_ilc', sql`(${t.ilcMode} is null or ${t.ilcMode} in ('organizer', 'participant')) and (${t.sampleType} = 'interlaboratory' or ${t.ilcMode} is null)`),
  check('sample_required_variant_details', sql`(${t.sampleType} <> 'quality_control' or ${t.iqcType} is not null) and (${t.sampleType} <> 'interlaboratory' or ${t.ilcMode} is not null)`),
  check('sample_amount', amount(t.totalAmount, t.currencyCode))]);

export const sampleProducts = pgTable('sample_products', {
  ...identity(), sampleId: uuid('sample_id').notNull(), productId: uuid('product_id').notNull(), sampleCategoryId: uuid('sample_category_id').notNull(),
  productCode: text('product_code').notNull(), productName: text('product_name').notNull(), categoryCode: text('category_code').notNull(), categoryName: text('category_name').notNull(),
  quantity: numeric('quantity').notNull().default('1'), customerReference: text('customer_reference'), description: text('description'), displayOrder: integer('display_order').notNull(),
  sampleSize: text('sample_size'), quality: text('quality'), identificationMark: text('identification_mark'), receivedCondition: text('received_condition'),
  measurementUnitId: uuid('measurement_unit_id'), unitCode: text('unit_code'), unitSymbol: text('unit_symbol'), tag: text('tag'), tagId: uuid('tag_id'),
}, (t) => [key(t), link(t, t.sampleId, samples), link(t, t.productId, products), link(t, t.sampleCategoryId, sampleCategories), link(t, t.measurementUnitId, measurementUnits),
  link(t, t.tagId, tags), check('sample_product_tag', sql`${t.tagId} is null or (${t.tag} is not null and length(trim(${t.tag})) between 1 and 250)`),
  foreignKey({ columns: [t.organizationId, t.productId, t.sampleCategoryId], foreignColumns: [productSampleCategories.organizationId, productSampleCategories.productId, productSampleCategories.sampleCategoryId] }),
  unique('sample_product_order_key').on(t.organizationId, t.sampleId, t.displayOrder),
  check('sample_product_quantity', sql`${t.quantity} > 0 and ${finite(t.quantity)} and ${t.displayOrder} >= 0`),
  check('sample_product_unit', sql`(${t.measurementUnitId} is null and ${t.unitCode} is null and ${t.unitSymbol} is null) or (${t.measurementUnitId} is not null and ${t.unitCode} is not null and ${t.unitSymbol} is not null)`)]);

export const sampleTests = pgTable('sample_tests', {
  ...identity(), sampleProductId: uuid('sample_product_id').notNull(), testParameterId: uuid('test_parameter_id').notNull(), methodId: uuid('method_id').notNull(), decisionRuleId: uuid('decision_rule_id'),
  requestedQuantity: integer('requested_quantity').notNull().default(1), requestedSize: text('requested_size'), rate: numeric('rate'), currencyCode: text('currency_code'),
  estimatedDurationMinutes: integer('estimated_duration_minutes'), isAccredited: boolean('is_accredited').notNull().default(false), isRetest: boolean('is_retest').notNull().default(false),
  isSubcontracted: boolean('is_subcontracted').notNull().default(false), status: text('status').notNull().default('planned'), displayOrder: integer('display_order').notNull(),
}, (t) => [key(t), link(t, t.sampleProductId, sampleProducts), link(t, t.testParameterId, testParameters), link(t, t.methodId, methodsOfAnalysis), link(t, t.decisionRuleId, decisionRules),
  foreignKey({ columns: [t.organizationId, t.testParameterId, t.methodId], foreignColumns: [parameterMethods.organizationId, parameterMethods.testParameterId, parameterMethods.methodId] }),
  unique('sample_test_selection_key').on(t.organizationId, t.sampleProductId, t.testParameterId, t.methodId, t.isRetest),
  unique('sample_test_order_key').on(t.organizationId, t.sampleProductId, t.displayOrder),
  check('sample_test_details', sql`${t.requestedQuantity} > 0 and ${t.displayOrder} >= 0 and (${t.estimatedDurationMinutes} is null or ${t.estimatedDurationMinutes} >= 0) and ${t.status} in ('planned', 'requested', 'in_progress', 'completed', 'cancelled')`),
  check('sample_test_rate', amount(t.rate, t.currencyCode))]);

export const sampleParticipatingLabs = pgTable('sample_participating_labs', {
  ...identity(), sampleId: uuid('sample_id').notNull(), laboratoryId: uuid('laboratory_id'), laboratoryName: text('laboratory_name').notNull(), displayOrder: integer('display_order').notNull(),
}, (t) => [key(t), link(t, t.sampleId, samples), link(t, t.laboratoryId, laboratories), unique('sample_participating_lab_order_key').on(t.organizationId, t.sampleId, t.displayOrder),
  check('sample_participating_lab_details', sql`length(trim(${t.laboratoryName})) between 1 and 250 and ${t.displayOrder} >= 0`)]);

// Immutable interpretation at test-request generation. Each datasheet references
// the specification actually used; later master edits cannot reinterpret it.
export const analyticalSpecifications = pgTable('analytical_specifications', {
  ...identity(), basisSpecificationId: uuid('basis_specification_id'), testParameterId: uuid('test_parameter_id').notNull(), parameterRevision: integer('parameter_revision').notNull(), parameterCode: text('parameter_code').notNull(), parameterName: text('parameter_name').notNull(),
  parameterMasterKey: text('parameter_master_key').notNull(), parameterScale: integer('parameter_scale').notNull(),
  methodId: uuid('method_id').notNull(), methodRevision: integer('method_revision').notNull(), methodCode: text('method_code').notNull(), methodName: text('method_name').notNull(),
  methodDescription: text('method_description').notNull(), methodUuid: text('method_uuid').notNull(), decimalScale: integer('decimal_scale').notNull(), parseNumber: boolean('parse_number').notNull(),
  measurementUnitId: uuid('measurement_unit_id'), unitRevision: integer('unit_revision'), unitCode: text('unit_code'), unitName: text('unit_name'), unitSymbol: text('unit_symbol'), unitDimension: text('unit_dimension'),
  decisionRuleId: uuid('decision_rule_id'), ruleRevision: integer('rule_revision'), ruleCode: text('rule_code'), ruleName: text('rule_name'), templateId: uuid('template_id'),
  cutoffValue: numeric('cutoff_value'), greaterThanText: text('greater_than_text'), lessThanText: text('less_than_text'), minimumText: text('minimum_text'), maximumText: text('maximum_text'),
  unitOfMeasure: text('unit_of_measure'), resultRepresentation: text('result_representation'), defaultNarration: text('default_narration'),
  detectableUpperLimit: numeric('detectable_upper_limit'), detectableLowerLimit: numeric('detectable_lower_limit'), detectableUpperLimitText: text('detectable_upper_limit_text'), detectableLowerLimitText: text('detectable_lower_limit_text'),
  showDetectableLimitText: boolean('show_detectable_limit_text').notNull().default(false), showStandardLimitText: boolean('show_standard_limit_text').notNull().default(false), conformanceLimit: numeric('conformance_limit'),
  recordedBy: uuid('recorded_by').notNull(), recordedAt: time('recorded_at').notNull().defaultNow(),
}, (t) => [key(t), link(t, t.testParameterId, testParameters), link(t, t.methodId, methodsOfAnalysis), link(t, t.measurementUnitId, measurementUnits), link(t, t.decisionRuleId, decisionRules), link(t, t.templateId, templates), actor(t, t.recordedBy),
  foreignKey({ name: 'analytical_spec_basis_fk', columns: [t.organizationId, t.basisSpecificationId], foreignColumns: [t.organizationId, t.id] }),
  check('analytical_spec_basis_identity', sql`${t.basisSpecificationId} is distinct from ${t.id}`),
  unique('analytical_specification_method_key').on(t.organizationId, t.id, t.methodId),
  check('analytical_specification_revisions', sql`${t.parameterRevision} > 0 and ${t.methodRevision} > 0 and ${t.parameterScale} between 0 and 12 and ${t.decimalScale} between 0 and 12`),
  check('analytical_specification_unit', sql`(${t.measurementUnitId} is null and num_nonnulls(${t.unitRevision}, ${t.unitCode}, ${t.unitName}, ${t.unitSymbol}, ${t.unitDimension}) = 0)
    or (${t.measurementUnitId} is not null and ${t.unitRevision} is not null and ${t.unitRevision} > 0 and ${t.unitCode} is not null and ${t.unitName} is not null and ${t.unitSymbol} is not null)`),
  check('analytical_specification_rule', sql`(${t.decisionRuleId} is null and ${t.ruleRevision} is null and ${t.ruleCode} is null and ${t.ruleName} is null)
    or (${t.decisionRuleId} is not null and ${t.ruleRevision} is not null and ${t.ruleRevision} > 0 and ${t.ruleCode} is not null and ${t.ruleName} is not null)`),
  check('analytical_specification_numbers', sql`${finite(t.cutoffValue)} and ${finite(t.detectableUpperLimit)} and ${finite(t.detectableLowerLimit)} and ${finite(t.conformanceLimit)}`)]);

export const analyticalSpecificationLimits = pgTable('analytical_specification_limits', {
  organizationId: tenant(), specificationId: uuid('specification_id').notNull(), id: uuid('id').notNull(), lowerLimit: numeric('lower_limit'), upperLimit: numeric('upper_limit'),
  lowerInclusive: boolean('lower_inclusive').notNull(), upperInclusive: boolean('upper_inclusive').notNull(), outcome: text('outcome').notNull(), narration: text('narration'), displayOrder: integer('display_order').notNull(),
}, (t) => [primaryKey({ name: 'analytical_specification_limit_pk', columns: [t.organizationId, t.specificationId, t.id] }), link(t, t.specificationId, analyticalSpecifications),
  check('analytical_specification_limit_bounds', sql`num_nonnulls(${t.lowerLimit}, ${t.upperLimit}) >= 1 and ${finite(t.lowerLimit)} and ${finite(t.upperLimit)} and (${t.lowerLimit} is null or ${t.upperLimit} is null or ${t.lowerLimit} <= ${t.upperLimit}) and ${t.displayOrder} >= 0`)]);

export const testRequests = pgTable('test_requests', {
  ...identity(), requestNumber: text('request_number').notNull(), sampleTestId: uuid('sample_test_id'), specificationId: uuid('specification_id'),
  isJob: boolean('is_job').notNull().default(false), isAutoCreated: boolean('is_auto_created').notNull().default(false), jobSampleProductId: uuid('job_sample_product_id'),
  parentTestRequestId: uuid('parent_test_request_id'), jobMemberPosition: integer('job_member_position'), jobLinkedBy: uuid('job_linked_by'), jobLinkedAt: time('job_linked_at'),
  attemptNumber: integer('attempt_number').notNull().default(1),
  status: text('status').notNull().default('created'), priority: text('priority').notNull().default('normal'), dueAt: time('due_at'), startedAt: time('started_at'), completedAt: time('completed_at'),
  datasheetTemplateId: uuid('datasheet_template_id'), finalDatasheetId: uuid('final_datasheet_id'),
  revision: integer('revision').notNull().default(1), createdBy: uuid('created_by').notNull(), createdAt: time('created_at').notNull().defaultNow(), updatedAt: time('updated_at').notNull().defaultNow(),
}, (t) => [key(t), link(t, t.sampleTestId, sampleTests), link(t, t.specificationId, analyticalSpecifications), link(t, t.parentTestRequestId, t), link(t, t.jobSampleProductId, sampleProducts),
  link(t, t.datasheetTemplateId, templates), actor(t, t.createdBy), actor(t, t.jobLinkedBy),
  foreignKey({ name: 'test_request_final_datasheet_fk', columns: [t.organizationId, t.id, t.finalDatasheetId], foreignColumns: [datasheets.organizationId, datasheets.testRequestId, datasheets.id] }),
  unique('test_request_number_key').on(t.organizationId, t.requestNumber), unique('test_request_attempt_key').on(t.organizationId, t.sampleTestId, t.attemptNumber),
  uniqueIndex('test_request_job_member_position').on(t.organizationId, t.parentTestRequestId, t.jobMemberPosition).where(sql`${t.parentTestRequestId} is not null`),
  index('test_request_job_product_idx').on(t.organizationId, t.jobSampleProductId).where(sql`${t.isJob}`),
  index('test_request_status_idx').on(t.organizationId, t.status, t.createdAt),
  check('test_request_kind_shape', sql`(${t.isJob} and ${t.sampleTestId} is null and ${t.specificationId} is null and ${t.jobSampleProductId} is not null and ${t.parentTestRequestId} is null)
    or (not ${t.isJob} and not ${t.isAutoCreated} and ${t.sampleTestId} is not null and ${t.specificationId} is not null and ${t.jobSampleProductId} is null)`),
  check('test_request_job_link_shape', sql`(${t.parentTestRequestId} is null and num_nonnulls(${t.jobMemberPosition},${t.jobLinkedBy},${t.jobLinkedAt})=0)
    or (${t.parentTestRequestId} is not null and ${t.jobMemberPosition} is not null and ${t.jobMemberPosition}>=0 and ${t.jobLinkedBy} is not null and ${t.jobLinkedAt} is not null and ${t.parentTestRequestId}<>${t.id})`),
  check('test_request_state', sql`${t.status} in ('created', 'allocated', 'in_progress', 'under_review', 'approved', 'rejected', 'cancelled') and ${t.priority} in ('low', 'normal', 'high', 'urgent') and ${t.revision} > 0 and ${t.attemptNumber} > 0`),
  check('test_request_dates', sql`${t.completedAt} is null or ${t.startedAt} is null or ${t.completedAt} >= ${t.startedAt}`),
  check('test_request_parent', sql`${t.parentTestRequestId} is distinct from ${t.id}`)]);

export const testRequestAssignments = pgTable('test_request_assignments', {
  ...identity(), testRequestId: uuid('test_request_id').notNull(), assignedUserId: uuid('assigned_user_id').notNull(), assignmentType: text('assignment_type').notNull(),
  assignedBy: uuid('assigned_by').notNull(), assignedAt: time('assigned_at').notNull().defaultNow(), unassignedAt: time('unassigned_at'),
}, (t) => [key(t), link(t, t.testRequestId, testRequests), actor(t, t.assignedUserId), actor(t, t.assignedBy),
  uniqueIndex('test_request_current_assignment_key').on(t.organizationId, t.testRequestId, t.assignmentType).where(sql`${t.unassignedAt} is null`),
  index('test_request_assigned_user_idx').on(t.organizationId, t.assignedUserId).where(sql`${t.unassignedAt} is null`),
  check('test_request_assignment_details', sql`${t.assignmentType} in ('analyst', 'reviewer', 'final_approver') and (${t.unassignedAt} is null or ${t.unassignedAt} >= ${t.assignedAt})`)]);

export const datasheets = pgTable('datasheets', {
  ...identity(), testRequestId: uuid('test_request_id').notNull(), templateInstanceId: uuid('template_instance_id').notNull(), specificationId: uuid('specification_id'), methodId: uuid('method_id'),
  attemptNumber: integer('attempt_number').notNull(), status: text('status').notNull().default('in_progress'), revision: integer('revision').notNull().default(1),
  createdBy: uuid('created_by').notNull(), createdAt: time('created_at').notNull().defaultNow(), completedBy: uuid('completed_by'), completedAt: time('completed_at'), latestSubmissionId: uuid('latest_submission_id'),
}, (t) => [key(t), link(t, t.testRequestId, testRequests), link(t, t.templateInstanceId, templateInstances), link(t, t.methodId, methodsOfAnalysis), actor(t, t.createdBy), actor(t, t.completedBy),
  foreignKey({ columns: [t.organizationId, t.specificationId, t.methodId], foreignColumns: [analyticalSpecifications.organizationId, analyticalSpecifications.id, analyticalSpecifications.methodId] }),
  unique('datasheet_request_id_key').on(t.organizationId, t.testRequestId, t.id), unique('datasheet_capture_key').on(t.organizationId, t.templateInstanceId),
  unique('datasheet_instance_id_key').on(t.organizationId, t.id, t.templateInstanceId),
  foreignKey({ name: 'datasheet_latest_submission_fk', columns: [t.organizationId, t.id, t.latestSubmissionId], foreignColumns: [datasheetSubmissions.organizationId, datasheetSubmissions.datasheetId, datasheetSubmissions.id] }),
  unique('datasheet_attempt_key').on(t.organizationId, t.testRequestId, t.attemptNumber),
  check('datasheet_specification_shape', sql`(${t.specificationId} is null)=(${t.methodId} is null)`),
  check('datasheet_status', sql`${t.status} in ('in_progress', 'completed', 'under_review', 'approved', 'rejected', 'void') and ${t.revision} > 0 and ${t.attemptNumber} > 0`),
  check('datasheet_completion', sql`(${t.completedAt} is null) = (${t.completedBy} is null) and (${t.status} not in ('completed', 'under_review', 'approved') or ${t.completedAt} is not null)`)]);

// A parameter-loop occurrence belongs to one real request and its frozen
// specification. Manual descendants inherit that subject through ancestry.
export const datasheetSubjects = pgTable('datasheet_subjects', {
  ...identity(), datasheetId: uuid('datasheet_id').notNull(), instanceId: uuid('instance_id').notNull(), versionId: uuid('version_id').notNull(),
  occurrenceId: uuid('occurrence_id').notNull(), testRequestId: uuid('test_request_id').notNull(), specificationId: uuid('specification_id').notNull(),
  createdRevision: integer('created_revision').notNull(), createdBy: uuid('created_by').notNull(), createdAt: time('created_at').notNull().defaultNow(),
}, (t) => [key(t), actor(t, t.createdBy), link(t, t.testRequestId, testRequests), link(t, t.specificationId, analyticalSpecifications),
  foreignKey({ name: 'datasheet_subject_capture_fk', columns: [t.organizationId, t.datasheetId, t.instanceId], foreignColumns: [datasheets.organizationId, datasheets.id, datasheets.templateInstanceId] }),
  foreignKey({ name: 'datasheet_subject_occurrence_fk', columns: [t.organizationId, t.instanceId, t.versionId, t.occurrenceId], foreignColumns: [templateOccurrences.organizationId, templateOccurrences.instanceId, templateOccurrences.versionId, templateOccurrences.id] }),
  unique('datasheet_subject_occurrence_key').on(t.organizationId, t.instanceId, t.occurrenceId),
  index('datasheet_subject_request_idx').on(t.organizationId, t.testRequestId, t.datasheetId),
  check('datasheet_subject_revision', sql`${t.createdRevision}>0`),
]);

// A job result records its real summary input and the child method selected at
// that time. The value/actor/time remain in template_values; clearing a value
// and deleting its rendered row do not erase this selection history.
export const jobResultEntries = pgTable('job_result_entries', {
  ...identity(), datasheetId: uuid('datasheet_id').notNull(), childDatasheetId: uuid('child_datasheet_id').notNull(),
  subjectId: uuid('subject_id').notNull(), instanceId: uuid('instance_id').notNull(), fieldId: uuid('field_id').notNull(),
  occurrenceId: uuid('occurrence_id').notNull(), valueRevision: integer('value_revision').notNull(), position: integer('position').notNull(),
  recordedBy: uuid('recorded_by').notNull(), recordedAt: time('recorded_at').notNull().defaultNow(),
}, (t) => [key(t), actor(t, t.recordedBy), link(t, t.childDatasheetId, datasheets), link(t, t.subjectId, datasheetSubjects),
  foreignKey({ name: 'job_result_capture_fk', columns: [t.organizationId, t.datasheetId, t.instanceId], foreignColumns: [datasheets.organizationId, datasheets.id, datasheets.templateInstanceId] }),
  foreignKey({ name: 'job_result_value_fk', columns: [t.organizationId, t.instanceId, t.fieldId, t.occurrenceId, t.valueRevision], foreignColumns: [templateValues.organizationId, templateValues.instanceId, templateValues.fieldId, templateValues.occurrenceId, templateValues.revision] }),
  unique('job_result_value_key').on(t.organizationId, t.instanceId, t.fieldId, t.occurrenceId, t.valueRevision),
  unique('job_result_order_key').on(t.organizationId, t.instanceId, t.valueRevision, t.position),
  index('job_result_child_history_idx').on(t.organizationId, t.childDatasheetId, t.valueRevision),
  check('job_result_position', sql`${t.valueRevision}>0 and ${t.position} between 0 and 999`),
]);

// Each submission pins the authoritative capture history and exact selected
// value. HTML and result objects are derived for transport/printing only.
export const datasheetSubmissions = pgTable('datasheet_submissions', {
  ...identity(), datasheetId: uuid('datasheet_id').notNull(), number: integer('number').notNull(),
  sourceDatasheetId: uuid('source_datasheet_id').notNull(), specificationId: uuid('specification_id'), jobResultEntryId: uuid('job_result_entry_id'),
  instanceId: uuid('instance_id').notNull(), versionId: uuid('version_id').notNull(), captureRevision: integer('capture_revision').notNull(),
  fieldId: uuid('field_id').notNull(), occurrenceId: uuid('occurrence_id').notNull(), valueRevision: integer('value_revision').notNull(),
  source: text('source').notNull(), selectionSemantics: text('selection_semantics').notNull(), resultType: text('result_type').notNull(),
  numberValue: numeric('number_value'), textValue: text('text_value'), booleanValue: boolean('boolean_value'),
  measurementUnitId: uuid('measurement_unit_id'), unitRevision: integer('unit_revision'), unitCode: text('unit_code'), unitName: text('unit_name'), unitSymbol: text('unit_symbol'), unitDimension: text('unit_dimension'),
  narration: text('narration'), submittedBy: uuid('submitted_by').notNull(), submittedAt: time('submitted_at').notNull().defaultNow(),
}, (t) => [key(t), actor(t, t.submittedBy), link(t, t.measurementUnitId, measurementUnits), link(t, t.datasheetId, datasheets),
  link(t, t.specificationId, analyticalSpecifications), link(t, t.jobResultEntryId, jobResultEntries),
  foreignKey({ name: 'submission_source_capture_fk', columns: [t.organizationId, t.sourceDatasheetId, t.instanceId], foreignColumns: [datasheets.organizationId, datasheets.id, datasheets.templateInstanceId] }),
  foreignKey({ name: 'submission_capture_version_fk', columns: [t.organizationId, t.instanceId, t.versionId], foreignColumns: [templateInstances.organizationId, templateInstances.id, templateInstances.versionId] }),
  foreignKey({ name: 'submission_selected_value_fk', columns: [t.organizationId, t.instanceId, t.fieldId, t.occurrenceId, t.valueRevision], foreignColumns: [templateValues.organizationId, templateValues.instanceId, templateValues.fieldId, templateValues.occurrenceId, templateValues.revision] }),
  unique('submission_datasheet_id_key').on(t.organizationId, t.datasheetId, t.id),
  unique('submission_number_key').on(t.organizationId, t.datasheetId, t.number),
  unique('submission_capture_revision_key').on(t.organizationId, t.instanceId, t.captureRevision, t.datasheetId),
  check('submission_revision', sql`${t.number} > 0 and ${t.captureRevision} > 0 and ${t.valueRevision} > 0 and ${t.valueRevision} <= ${t.captureRevision}`),
  check('submission_source', sql`${t.selectionSemantics} = 'source-agreement-v1' and (
    (${t.source} in ('section', 'column') and ${t.sourceDatasheetId}=${t.datasheetId} and ${t.jobResultEntryId} is null)
    or (${t.source}='result_widget' and ${t.sourceDatasheetId}<>${t.datasheetId} and ${t.jobResultEntryId} is not null and ${t.specificationId} is not null))`),
  check('submission_payload', sql`num_nonnulls(${t.numberValue}, ${t.textValue}, ${t.booleanValue}) = 1 and (
    (${t.resultType} = 'numeric' and ${t.numberValue} is not null and ${finite(t.numberValue)}) or
    (${t.resultType} = 'text' and ${t.textValue} is not null and length(trim(${t.textValue})) between 1 and 100000) or
    (${t.resultType} = 'boolean' and ${t.booleanValue} is not null))`),
  check('submission_unit', sql`(${t.measurementUnitId} is null and num_nonnulls(${t.unitRevision}, ${t.unitCode}, ${t.unitName}, ${t.unitSymbol}, ${t.unitDimension}) = 0)
    or (${t.measurementUnitId} is not null and ${t.unitRevision} is not null and ${t.unitRevision} > 0 and ${t.unitCode} is not null and ${t.unitName} is not null and ${t.unitSymbol} is not null)`),
  check('submission_narration', sql`${t.narration} is null or length(${t.narration}) <= 5000`),
]);

// Exact child submissions covered by a parent job submission. Existing submitted
// child results retain their original actor/time; new summary inputs reference
// their actual source capture through datasheet_submissions.
export const jobSubmissionMembers = pgTable('job_submission_members', {
  ...identity(), parentSubmissionId: uuid('parent_submission_id').notNull(), testRequestId: uuid('test_request_id').notNull(), submissionId: uuid('submission_id').notNull(),
}, (t) => [key(t), link(t, t.parentSubmissionId, datasheetSubmissions), link(t, t.testRequestId, testRequests), link(t, t.submissionId, datasheetSubmissions),
  unique('job_submission_member_key').on(t.organizationId, t.parentSubmissionId, t.testRequestId),
  unique('job_submission_result_key').on(t.organizationId, t.parentSubmissionId, t.submissionId),
  index('job_submission_member_request_idx').on(t.organizationId, t.testRequestId),
]);

export const workflowRuns = pgTable('workflow_runs', {
  ...identity(), workflowVersionId: uuid('workflow_version_id').notNull(), sampleId: uuid('sample_id'), testRequestId: uuid('test_request_id'), currentStateId: uuid('current_state_id').notNull(),
  status: text('status').notNull().default('active'), revision: integer('revision').notNull().default(1), startedBy: uuid('started_by').notNull(), startedAt: time('started_at').notNull().defaultNow(), completedAt: time('completed_at'),
}, (t) => [key(t), link(t, t.workflowVersionId, workflowVersions), link(t, t.sampleId, samples), link(t, t.testRequestId, testRequests), actor(t, t.startedBy),
  foreignKey({ columns: [t.organizationId, t.workflowVersionId, t.currentStateId], foreignColumns: [workflowStates.organizationId, workflowStates.workflowVersionId, workflowStates.id] }),
  unique('workflow_run_sample_key').on(t.organizationId, t.sampleId), unique('workflow_run_request_key').on(t.organizationId, t.testRequestId),
  unique('workflow_run_version_key').on(t.organizationId, t.id, t.workflowVersionId),
  check('workflow_run_owner', sql`num_nonnulls(${t.sampleId}, ${t.testRequestId}) = 1`),
  check('workflow_run_state', sql`${t.status} in ('active', 'completed', 'cancelled') and ${t.revision} > 0 and (${t.completedAt} is null or ${t.completedAt} >= ${t.startedAt})`)]);

export const workflowRunHistory = pgTable('workflow_run_history', {
  ...identity(), workflowRunId: uuid('workflow_run_id').notNull(), workflowVersionId: uuid('workflow_version_id').notNull(), fromStateId: uuid('from_state_id'), toStateId: uuid('to_state_id').notNull(),
  transitionId: uuid('transition_id'), datasheetSubmissionId: uuid('datasheet_submission_id'),
  action: text('action').notNull(), actorUserId: uuid('actor_user_id').notNull(), comment: text('comment'), occurredAt: time('occurred_at').notNull().defaultNow(),
}, (t) => [key(t), actor(t, t.actorUserId), link(t, t.datasheetSubmissionId, datasheetSubmissions), unique('workflow_history_transition_key').on(t.organizationId, t.id, t.transitionId),
  foreignKey({ name: 'workflow_history_transition_fk', columns: [t.organizationId, t.workflowVersionId, t.transitionId], foreignColumns: [workflowTransitions.organizationId, workflowTransitions.workflowVersionId, workflowTransitions.id] }),
  foreignKey({ columns: [t.organizationId, t.workflowRunId, t.workflowVersionId], foreignColumns: [workflowRuns.organizationId, workflowRuns.id, workflowRuns.workflowVersionId] }),
  foreignKey({ columns: [t.organizationId, t.workflowVersionId, t.fromStateId], foreignColumns: [workflowStates.organizationId, workflowStates.workflowVersionId, workflowStates.id] }),
  foreignKey({ columns: [t.organizationId, t.workflowVersionId, t.toStateId], foreignColumns: [workflowStates.organizationId, workflowStates.workflowVersionId, workflowStates.id] }),
  index('workflow_run_history_idx').on(t.organizationId, t.workflowRunId, t.occurredAt),
  check('workflow_run_history_action', sql`${t.action} in ('started', 'requested', 'transitioned', 'approved', 'rejected', 'cancelled', 'completed')`)]);

// Parent workflow decisions can govern a job's covered child results without
// replacing the child's workflow definition or fabricating a child transition.
// The parent history remains the authority for the real actor, time and action.
export const jobWorkflowEffects = pgTable('job_workflow_effects', {
  ...identity(), parentHistoryId: uuid('parent_history_id').notNull(), jobSubmissionMemberId: uuid('job_submission_member_id').notNull(),
  parentRunRevision: integer('parent_run_revision').notNull(),
  childWorkflowRunId: uuid('child_workflow_run_id'), childWorkflowVersionId: uuid('child_workflow_version_id'),
  childStateId: uuid('child_state_id'), childRunRevision: integer('child_run_revision'),
}, (t) => [key(t), link(t, t.parentHistoryId, workflowRunHistory), link(t, t.jobSubmissionMemberId, jobSubmissionMembers),
  foreignKey({ name: 'job_effect_child_run_fk', columns: [t.organizationId, t.childWorkflowRunId, t.childWorkflowVersionId], foreignColumns: [workflowRuns.organizationId, workflowRuns.id, workflowRuns.workflowVersionId] }),
  foreignKey({ name: 'job_effect_child_state_fk', columns: [t.organizationId, t.childWorkflowVersionId, t.childStateId], foreignColumns: [workflowStates.organizationId, workflowStates.workflowVersionId, workflowStates.id] }),
  unique('job_effect_history_member_key').on(t.organizationId, t.parentHistoryId, t.jobSubmissionMemberId),
  index('job_effect_child_run_idx').on(t.organizationId, t.childWorkflowRunId),
  check('job_effect_parent_revision', sql`${t.parentRunRevision}>1`),
  check('job_effect_child_context', sql`num_nonnulls(${t.childWorkflowRunId},${t.childWorkflowVersionId},${t.childStateId},${t.childRunRevision})=0
    or (num_nonnulls(${t.childWorkflowRunId},${t.childWorkflowVersionId},${t.childStateId},${t.childRunRevision})=4 and ${t.childRunRevision}>0)`),
]);

export const sampleEvents = pgTable('sample_events', {
  ...identity(), sampleId: uuid('sample_id').notNull(), testRequestId: uuid('test_request_id'), datasheetId: uuid('datasheet_id'), eventType: text('event_type').notNull(), actorUserId: uuid('actor_user_id').notNull(),
  description: text('description').notNull(), occurredAt: time('occurred_at').notNull().defaultNow(),
}, (t) => [key(t), link(t, t.sampleId, samples), link(t, t.testRequestId, testRequests), actor(t, t.actorUserId),
  foreignKey({ name: 'sample_event_datasheet_fk', columns: [t.organizationId, t.testRequestId, t.datasheetId], foreignColumns: [datasheets.organizationId, datasheets.testRequestId, datasheets.id] }),
  check('sample_event_datasheet_owner', sql`(${t.datasheetId} is null or ${t.testRequestId} is not null) and (${t.eventType} not in ('datasheet_method_added','datasheet_method_voided') or ${t.datasheetId} is not null)`),
  index('sample_events_time_idx').on(t.organizationId, t.sampleId, t.occurredAt),
  check('sample_event_type', sql`${t.eventType} in ('sample_registered', 'test_requests_generated', 'test_request_assigned', 'datasheet_created', 'datasheet_submitted', 'reports_generated', 'reports_finalized', 'datasheet_method_added', 'datasheet_method_voided', 'test_request_job_created')`)]);
