import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, integer, boolean, numeric, timestamp, primaryKey, unique, check, foreignKey, customType } from 'drizzle-orm/pg-core';
import { organizations, memberships } from './schema.js';
import { decisionRules } from './master-schema.js';
import { instruments } from './instrument-schema.js';

const tenant = () => uuid('organization_id').notNull().references(() => organizations.id);
const link = (t, column, target, name) => foreignKey({ name, columns: [t.organizationId, column], foreignColumns: [target.organizationId, target.id] });

// Kept apart from master-schema.js: instrument-schema.js already imports laboratories from
// master-schema.js, so importing instruments back there would be circular.
export const decisionRuleInstruments = pgTable('decision_rule_instruments', {
  organizationId: tenant(), decisionRuleId: uuid('decision_rule_id').notNull(), instrumentId: uuid('instrument_id').notNull(),
}, (t) => [primaryKey({ columns: [t.organizationId, t.decisionRuleId, t.instrumentId] }), link(t, t.decisionRuleId, decisionRules, 'decision_rule_instrument_rule_fk'),
  link(t, t.instrumentId, instruments, 'decision_rule_instrument_instrument_fk')]);

const transactionId = customType({ dataType: () => 'xid8' });
const scope = () => ({ organizationId: uuid('organization_id').notNull().references(() => organizations.id), decisionRuleId: uuid('decision_rule_id').notNull(), revision: integer('revision').notNull() });

export const decisionRuleVersions = pgTable('decision_rule_versions', {
  ...scope(), requestId: uuid('request_id').notNull(), previousRevision: integer('previous_revision'), operation: text('operation').notNull(),
  code: text('code').notNull(), name: text('name'), parentDecisionRuleId: uuid('parent_decision_rule_id'), isTestGroupParent: boolean('is_test_group_parent').notNull(),
  testGroupName: text('test_group_name'), testGroupUid: text('test_group_uid'),
  productId: uuid('product_id').notNull(), testParameterId: uuid('test_parameter_id').notNull(), methodId: uuid('method_id'), templateId: uuid('template_id'),
  cutoffValue: numeric('cutoff_value').notNull(), greaterThanText: text('greater_than_text'), lessThanText: text('less_than_text'),
  minimumText: text('minimum_text'), maximumText: text('maximum_text'), unitOfMeasure: text('unit_of_measure'), isNabl: boolean('is_nabl').notNull(),
  minimumSize: text('minimum_size'), estimatedTimeInDays: numeric('estimated_time_in_days').notNull(), estimatedCharges: numeric('estimated_charges').notNull(),
  expressTimeInDays: numeric('express_time_in_days').notNull(), expressCharges: numeric('express_charges').notNull(),
  resultRepresentation: text('result_representation'), defaultNarration: text('default_narration'),
  detectableUpperLimit: numeric('detectable_upper_limit'), detectableLowerLimit: numeric('detectable_lower_limit'),
  detectableUpperLimitText: text('detectable_upper_limit_text'), detectableLowerLimitText: text('detectable_lower_limit_text'),
  showDetectableLimitText: boolean('show_detectable_limit_text').notNull(), showStandardLimitText: boolean('show_standard_limit_text').notNull(),
  conformanceLimit: numeric('conformance_limit'), discipline: text('discipline'), ruleGroup: text('rule_group'), uniqueKey: text('unique_key'),
  hasFormula: boolean('has_formula').notNull(), formula: text('formula'), formulaText: text('formula_text'),
  hasDerivedFormula: boolean('has_derived_formula').notNull(), customFormula: text('custom_formula'), formulaExpression: text('formula_expression'),
  active: boolean('active').notNull(), savedBy: uuid('saved_by').notNull(), savedAt: timestamp('saved_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  createdTransactionId: transactionId('created_transaction_id').notNull().default(sql`pg_current_xact_id()`),
}, (table) => [
  primaryKey({ name: 'decision_rule_version_pk', columns: [table.organizationId, table.decisionRuleId, table.revision] }),
  unique('decision_rule_save_request_key').on(table.organizationId, table.requestId),
  foreignKey({ name: 'decision_rule_versions_organization_id_organizations_id_fk', columns: [table.organizationId], foreignColumns: [organizations.id] }),
  foreignKey({ name: 'decision_rule_version_parent_fk', columns: [table.organizationId, table.decisionRuleId], foreignColumns: [decisionRules.organizationId, decisionRules.id] }),
  foreignKey({ name: 'decision_rule_version_actor_fk', columns: [table.organizationId, table.savedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('decision_rule_version_revision', sql`(${table.operation}='create' and ${table.previousRevision} is null and ${table.revision}=1)
    or (${table.operation} in ('update','retire') and ${table.previousRevision} is not null and ${table.previousRevision}>0 and ${table.revision}=${table.previousRevision}+1)`),
]);
