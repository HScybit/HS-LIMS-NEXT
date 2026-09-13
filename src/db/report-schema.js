import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, boolean, timestamp, integer, numeric, primaryKey, unique, index, check, foreignKey, customType } from 'drizzle-orm/pg-core';
import { organizations, memberships } from './schema.js';
import { templateVersions } from './template-schema.js';
import { reportDocumentVersions, organizationCustomCssVersions } from './report-assets-schema.js';
import { samples, sampleProducts, sampleTests, testRequests, datasheetSubmissions, analyticalSpecifications, analyticalSpecificationLimits, sampleEvents } from './sample-schema.js';

const time = (name) => timestamp(name, { withTimezone: true, mode: 'date' });
const transactionId = customType({ dataType: () => 'xid8' });
const tenant = () => uuid('organization_id').notNull().references(() => organizations.id);
const link = (t, column, target, name) => foreignKey({ name, columns: [t.organizationId, column], foreignColumns: [target.organizationId, target.id] });

// Every generated revision owns its selection and print settings. No report
// definition, HTML, result object, or editable master is a second authority.
export const sampleReports = pgTable('sample_reports', {
  organizationId: tenant(), id: uuid('id').notNull().defaultRandom(), sampleId: uuid('sample_id').notNull(),
  templateVersionId: uuid('template_version_id').notNull(), reportNumber: text('report_number').notNull(), revision: integer('revision').notNull(),
  reportType: text('report_type').notNull(), groupKey: text('group_key').notNull(), sampleProductId: uuid('sample_product_id'), sampleTestId: uuid('sample_test_id'),
  productContextLineId: uuid('product_context_line_id'),
  status: text('status').notNull().default('draft'), generatedBy: uuid('generated_by').notNull(), generatedAt: time('generated_at').notNull().defaultNow(),
  generatedEventId: uuid('generated_event_id').notNull(), isFinalized: boolean('is_finalized').notNull().default(false),
  issuedBy: uuid('issued_by'), issuedAt: time('issued_at'),
  sampleRevision: integer('sample_revision').notNull(), sampleNumber: text('sample_number').notNull(), sampleType: text('sample_type').notNull(),
  sampleCategoryName: text('sample_category_name').notNull(), customerName: text('customer_name'), customerAddress: text('customer_address'),
  customerReference: text('customer_reference'), receivedAt: time('received_at').notNull(), registeredAt: time('registered_at').notNull(), dueAt: time('due_at'), description: text('description'),
}, (t) => [primaryKey({ columns: [t.organizationId, t.id] }), link(t, t.sampleId, samples), link(t, t.templateVersionId, templateVersions),
  link(t, t.sampleProductId, sampleProducts), link(t, t.sampleTestId, sampleTests), link(t, t.generatedEventId, sampleEvents, 'report_generated_event_fk'),
  link(t, t.productContextLineId, sampleProducts, 'report_product_context_line_fk'),
  foreignKey({ name: 'report_generated_actor_fk', columns: [t.organizationId, t.generatedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  foreignKey({ name: 'report_issued_actor_fk', columns: [t.organizationId, t.issuedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  unique('report_group_revision_key').on(t.organizationId, t.sampleId, t.groupKey, t.revision),
  unique('report_number_revision_key').on(t.organizationId, t.reportNumber, t.revision),
  index('report_sample_history_idx').on(t.organizationId, t.sampleId, t.generatedAt, t.id),
  check('report_revision', sql`${t.revision} > 0 and ${t.sampleRevision} > 0 and length(trim(${t.reportNumber})) between 1 and 100`),
  check('report_group', sql`(${t.reportType} = 'consolidated' and ${t.groupKey} = 'consolidated' and ${t.sampleProductId} is null and ${t.sampleTestId} is null)
    or (${t.reportType} = 'product_wise' and ${t.sampleProductId} is not null and ${t.sampleTestId} is null and ${t.groupKey} = 'product:' || ${t.sampleProductId}::text)
    or (${t.reportType} = 'parameter_wise' and ${t.sampleProductId} is not null and ${t.sampleTestId} is not null and ${t.groupKey} = 'parameter:' || ${t.sampleTestId}::text)`),
  check('report_status', sql`(${t.status} = 'draft' and ${t.issuedBy} is null and ${t.issuedAt} is null)
    or (${t.status} in ('issued', 'superseded') and ${t.issuedBy} is not null and ${t.issuedAt} is not null and ${t.issuedAt} >= ${t.generatedAt})`),
]);

// Finalise completes the sample when a generation succeeds. It is separate
// from report issue and from a transition in the sample's workflow graph.
export const sampleReportFinalizations = pgTable('sample_report_finalizations', {
  organizationId: tenant(), eventId: uuid('event_id').notNull(), sampleId: uuid('sample_id').notNull(),
  previousRevision: integer('previous_revision').notNull(), completedRevision: integer('completed_revision').notNull(),
  finalizedBy: uuid('finalized_by').notNull(), finalizedAt: time('finalized_at').notNull(), transactionId: transactionId('transaction_id').notNull(),
}, (t) => [primaryKey({ name: 'report_finalization_pk', columns: [t.organizationId, t.eventId] }),
  link(t, t.eventId, sampleEvents, 'report_finalization_event_fk'), link(t, t.sampleId, samples, 'report_finalization_sample_fk'),
  foreignKey({ name: 'report_finalization_actor_fk', columns: [t.organizationId, t.finalizedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  unique('report_finalization_sample_revision_key').on(t.organizationId, t.sampleId, t.completedRevision),
  check('report_finalization_revision', sql`${t.previousRevision} > 0 and ${t.completedRevision} = ${t.previousRevision} + 1`),
]);

export const sampleReportTests = pgTable('sample_report_tests', {
  organizationId: tenant(), reportId: uuid('report_id').notNull(), sampleTestId: uuid('sample_test_id').notNull(),
  sampleProductId: uuid('sample_product_id').notNull(), testRequestId: uuid('test_request_id').notNull(), submissionId: uuid('submission_id').notNull(), specificationId: uuid('specification_id').notNull(),
  decisionLimitId: uuid('decision_limit_id'), displayOrder: integer('display_order').notNull(),
  productCode: text('product_code').notNull(), productName: text('product_name').notNull(), requestNumber: text('request_number').notNull(),
  analystName: text('analyst_name').notNull(), isAccredited: boolean('is_accredited').notNull(),
  requestStatus: text('request_status').notNull(), datasheetStatus: text('datasheet_status').notNull(), completedAt: time('completed_at'),
}, (t) => [primaryKey({ name: 'report_test_pk', columns: [t.organizationId, t.reportId, t.sampleTestId] }),
  link(t, t.reportId, sampleReports, 'report_test_report_fk'), link(t, t.sampleTestId, sampleTests, 'report_test_selection_fk'),
  link(t, t.sampleProductId, sampleProducts, 'report_test_product_fk'), link(t, t.testRequestId, testRequests, 'report_test_request_fk'),
  link(t, t.submissionId, datasheetSubmissions, 'report_test_submission_fk'), link(t, t.specificationId, analyticalSpecifications, 'report_test_specification_fk'),
  foreignKey({ name: 'report_test_decision_limit_fk', columns: [t.organizationId, t.specificationId, t.decisionLimitId], foreignColumns: [analyticalSpecificationLimits.organizationId, analyticalSpecificationLimits.specificationId, analyticalSpecificationLimits.id] }),
  unique('report_test_order_key').on(t.organizationId, t.reportId, t.displayOrder),
  check('report_test_state', sql`${t.displayOrder} >= 0 and ${t.requestStatus} in ('under_review', 'approved') and ${t.datasheetStatus} in ('under_review', 'approved')`),
]);

export const sampleReportPrintSettings = pgTable('sample_report_print_settings', {
  organizationId: tenant(), reportId: uuid('report_id').notNull(), pageSize: text('page_size').notNull().default('A4'),
  scale: numeric('scale').notNull().default('1'), xMargin: numeric('x_margin').notNull().default('1'), isLandscape: boolean('is_landscape').notNull().default(false),
  printHeader: boolean('print_header').notNull().default(true), printFooter: boolean('print_footer').notNull().default(true),
  printWithoutSignature: boolean('print_without_signature').notNull().default(false), printWithoutImage: boolean('print_without_image').notNull().default(false),
  useCustomTopMargin: boolean('use_custom_top_margin').notNull().default(false), topMargin: numeric('top_margin').notNull().default('1'),
  useCustomBottomMargin: boolean('use_custom_bottom_margin').notNull().default(false), bottomMargin: numeric('bottom_margin').notNull().default('1'),
}, (t) => [primaryKey({ name: 'report_print_settings_pk', columns: [t.organizationId, t.reportId] }), link(t, t.reportId, sampleReports, 'report_print_settings_report_fk'),
  check('report_print_settings_shape', sql`${t.pageSize} in ('A3', 'A4', 'A5', 'Letter', 'Legal') and ${t.scale} between 0.1 and 1
    and ${t.xMargin} between 0 and 500 and ${t.topMargin} between 0 and 500 and ${t.bottomMargin} between 0 and 500`),
]);

export const sampleReportAssets = pgTable('sample_report_assets', {
  organizationId: tenant(), reportId: uuid('report_id').notNull(),
  headerVersionId: uuid('header_version_id'), footerVersionId: uuid('footer_version_id'),
  nablHeaderVersionId: uuid('nabl_header_version_id'), nablFooterVersionId: uuid('nabl_footer_version_id'),
  cssVersionId: uuid('css_version_id'),
}, (t) => [primaryKey({ name: 'report_asset_pk', columns: [t.organizationId, t.reportId] }),
  link(t, t.reportId, sampleReports, 'report_asset_report_fk'),
  ...[t.headerVersionId, t.footerVersionId, t.nablHeaderVersionId, t.nablFooterVersionId].map((column) => link(t, column, reportDocumentVersions)),
  link(t, t.cssVersionId, organizationCustomCssVersions, 'report_asset_custom_css_fk'),
]);
