import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, integer, boolean, numeric, date, timestamp, primaryKey, unique, check, foreignKey, customType, index } from 'drizzle-orm/pg-core';
import { organizations, memberships, roles } from './schema.js';
import { laboratories } from './master-schema.js';
import { templates } from './template-schema.js';
import { workflows } from './workflow-schema.js';
import { organizationInstrumentServiceEntries } from './organization-settings-schema.js';

const transactionId = customType({ dataType: () => 'xid8' });
const bytes = customType({ dataType: () => 'bytea' });
const tenant = () => uuid('organization_id').notNull().references(() => organizations.id);
const time = name => timestamp(name, { withTimezone: true, mode: 'date' });
const day = name => date(name, { mode: 'string' });
const scope = () => ({ organizationId: tenant(), instrumentId: uuid('instrument_id').notNull(), revision: integer('revision').notNull() });
const versionColumns = t => [t.organizationId, t.instrumentId, t.revision];

export const instrumentFiles = pgTable('instrument_files', {
  organizationId: tenant(), id: uuid('id').notNull(), originalName: text('original_name').notNull(), mediaType: text('media_type').notNull(),
  content: bytes('content').notNull(), byteLength: integer('byte_length').notNull(), sha256: text('sha256').notNull(),
  uploadedBy: uuid('uploaded_by').notNull(), uploadedAt: time('uploaded_at').notNull().defaultNow(),
}, t => [primaryKey({ name: 'instrument_file_pk', columns: [t.organizationId, t.id] }),
  foreignKey({ name: 'instrument_file_actor_fk', columns: [t.organizationId, t.uploadedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('instrument_file_values', sql`length(${t.originalName}) between 1 and 500 and ${t.originalName}=trim(${t.originalName})
    and ${t.originalName} !~ '[[:cntrl:]]' and position('/' in ${t.originalName})=0 and position(chr(92) in ${t.originalName})=0
    and length(${t.mediaType}) between 1 and 255 and ${t.mediaType}=lower(${t.mediaType})
    and ${t.mediaType} ~ '^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$'
    and ${t.byteLength} between 0 and 26214400 and ${t.byteLength}=octet_length(${t.content}) and ${t.sha256}=encode(sha256(${t.content}),'hex')`),
]);

const values = () => ({ code: text('code').notNull(), name: text('name').notNull(), description: text('description'), laboratoryId: uuid('laboratory_id'),
  make: text('make'), modelName: text('model_name'), serialNumber: text('serial_number'), dateOfInstallation: day('date_of_installation'),
  calibrationAgency: text('calibration_agency'), calibrated: boolean('calibrated').notNull().default(true),
  costOfEquipment: numeric('cost_of_equipment', { precision: 18, scale: 2 }), purchaseFileId: uuid('purchase_file_id'),
  currentLocation: text('current_location'), manufacturerSupplier: text('manufacturer_supplier'),
  active: boolean('active').notNull().default(true), retired: boolean('retired').notNull().default(false),
  status: text('status').notNull().default('available'), currentStatus: text('current_status').notNull().default('is_working'),
  customFieldCount: integer('custom_field_count').notNull().default(0), customFieldsProvided: boolean('custom_fields_provided').notNull().default(false) });
const valueCheck = (t, name) => check(name, sql`length(trim(${t.code})) between 1 and 64 and ${t.code} ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'
  and length(trim(${t.name})) between 1 and 200 and (${t.description} is null or length(${t.description})<=5000)
  and (${t.make} is null or length(${t.make})<=200) and (${t.modelName} is null or length(${t.modelName})<=200)
  and (${t.serialNumber} is null or length(${t.serialNumber})<=200) and (${t.calibrationAgency} is null or length(${t.calibrationAgency})<=250)
  and (${t.currentLocation} is null or length(${t.currentLocation})<=250) and (${t.manufacturerSupplier} is null or length(${t.manufacturerSupplier})<=250)
  and (${t.dateOfInstallation} is null or ${t.dateOfInstallation} between date '0001-01-01' and date '9999-12-31')
  and (${t.costOfEquipment} is null or (${t.costOfEquipment}>=0 and ${t.costOfEquipment} not in ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)))
  and ${t.status} in ('available','in_use','maintenance','out_of_service','retired') and ${t.currentStatus} in ('is_working','in_breakdown')
  and (not ${t.retired} or not ${t.active}) and (${t.active} or ${t.status}='retired')
  and ${t.customFieldCount} between 0 and 500 and (not ${t.retired} or not ${t.customFieldsProvided})`);
const references = (t, prefix) => [
  foreignKey({ name: `${prefix}_lab_fk`, columns: [t.organizationId, t.laboratoryId], foreignColumns: [laboratories.organizationId, laboratories.id] }),
  foreignKey({ name: `${prefix}_purchase_file_fk`, columns: [t.organizationId, t.purchaseFileId], foreignColumns: [instrumentFiles.organizationId, instrumentFiles.id] }),
];

export const instruments = pgTable('instruments', {
  organizationId: tenant(), id: uuid('id').notNull().defaultRandom(), ...values(), revision: integer('revision').notNull().default(1),
  saveRequestId: uuid('save_request_id').notNull(), createdAt: time('created_at').notNull().defaultNow(), updatedAt: time('updated_at').notNull().defaultNow(),
}, t => [primaryKey({ name: 'instrument_pk', columns: [t.organizationId, t.id] }), unique('instruments_code_key').on(t.organizationId, t.code),
  valueCheck(t, 'instrument_values'), check('instrument_revision', sql`${t.revision}>0`), ...references(t, 'instrument'),
  index('instrument_listing').on(t.organizationId, t.createdAt, t.id).where(sql`not ${t.retired}`),
]);

export const instrumentVersions = pgTable('instrument_versions', {
  ...scope(), ...values(), laboratoryName: text('laboratory_name'), requestId: uuid('request_id').notNull(), requestFingerprint: text('request_fingerprint').notNull(),
  previousRevision: integer('previous_revision'), operation: text('operation').notNull(), userCount: integer('user_count').notNull(), serviceCount: integer('service_count').notNull(),
  usersProvided: boolean('users_provided').notNull(), servicesProvided: boolean('services_provided').notNull(),
  savedBy: uuid('saved_by').notNull(), savedAt: time('saved_at').notNull().defaultNow(),
  createdTransactionId: transactionId('created_transaction_id').notNull().default(sql`pg_current_xact_id()`),
}, t => [primaryKey({ name: 'instrument_version_pk', columns: versionColumns(t) }), unique('instrument_save_request_key').on(t.organizationId, t.requestId),
  foreignKey({ name: 'instrument_version_parent_fk', columns: [t.organizationId, t.instrumentId], foreignColumns: [instruments.organizationId, instruments.id] }),
  foreignKey({ name: 'instrument_version_actor_fk', columns: [t.organizationId, t.savedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  valueCheck(t, 'instrument_version_values'), ...references(t, 'instrument_version'),
  check('instrument_version_revision', sql`(${t.operation}='create' and ${t.previousRevision} is null and ${t.revision}=1)
    or (${t.operation} in ('update','retire') and ${t.previousRevision}>0 and ${t.previousRevision} is not null and ${t.revision}=${t.previousRevision}+1)`),
  check('instrument_version_command', sql`${t.requestFingerprint} ~ '^[a-f0-9]{64}$' and ${t.userCount} between 1 and 500 and ${t.serviceCount} between 0 and 100
    and (${t.retired}=(${t.operation}='retire')) and (${t.operation}<>'retire' or (not ${t.usersProvided} and not ${t.servicesProvided}))`),
]);

export const instrumentVersionUsers = pgTable('instrument_version_users', {
  ...scope(), userId: uuid('user_id').notNull(), position: integer('position').notNull(), userName: text('user_name').notNull(), username: text('username').notNull(),
}, t => [primaryKey({ name: 'instrument_version_user_pk', columns: [...versionColumns(t), t.userId] }),
  unique('instrument_version_user_position').on(...versionColumns(t), t.position), check('instrument_version_user_order', sql`${t.position} between 0 and 499`),
  foreignKey({ name: 'instrument_version_user_parent_fk', columns: versionColumns(t), foreignColumns: versionColumns(instrumentVersions) }),
  foreignKey({ name: 'instrument_version_user_fk', columns: [t.organizationId, t.userId], foreignColumns: [memberships.organizationId, memberships.userId] }),
]);

export const instrumentVersionServices = pgTable('instrument_version_services', {
  ...scope(), id: uuid('id').notNull(), position: integer('position').notNull(), serviceDefinitionId: uuid('service_definition_id').notNull(),
  serviceDefinitionRevision: integer('service_definition_revision').notNull(), serviceCode: text('service_code').notNull(), serviceLabel: text('service_label').notNull(),
  templateId: uuid('template_id'), workflowId: uuid('workflow_id'), templateName: text('template_name'), workflowName: text('workflow_name'),
  reminderBeforeDays: integer('reminder_before_days').notNull(), frequencyDays: integer('frequency_days'), lastPerformedOn: day('last_performed_on'),
  reminderFrequencyDays: integer('reminder_frequency_days'), nextReminderOn: day('next_reminder_on'), active: boolean('active').notNull(), roleCount: integer('role_count').notNull(),
}, t => [primaryKey({ name: 'instrument_version_service_pk', columns: [...versionColumns(t), t.id] }),
  unique('instrument_version_service_position').on(...versionColumns(t), t.position), unique('instrument_version_service_code').on(...versionColumns(t), t.serviceCode),
  foreignKey({ name: 'instrument_version_service_parent_fk', columns: versionColumns(t), foreignColumns: versionColumns(instrumentVersions) }),
  foreignKey({ name: 'instrument_service_definition_fk', columns: [t.organizationId, t.serviceDefinitionRevision, t.serviceDefinitionId],
    foreignColumns: [organizationInstrumentServiceEntries.organizationId, organizationInstrumentServiceEntries.revision, organizationInstrumentServiceEntries.id] }),
  foreignKey({ name: 'instrument_service_template_fk', columns: [t.organizationId, t.templateId], foreignColumns: [templates.organizationId, templates.id] }),
  foreignKey({ name: 'instrument_service_workflow_fk', columns: [t.organizationId, t.workflowId], foreignColumns: [workflows.organizationId, workflows.id] }),
  check('instrument_service_values', sql`${t.position} between 0 and 99 and ${t.roleCount} between 0 and 500 and ${t.reminderBeforeDays} between 0 and 3650
    and (${t.frequencyDays} is null or ${t.frequencyDays} between 1 and 36500) and (${t.reminderFrequencyDays} is null or ${t.reminderFrequencyDays} between 1 and 3650)
    and (${t.lastPerformedOn} is null or ${t.lastPerformedOn} between date '0001-01-01' and date '9999-12-31')
    and (${t.nextReminderOn} is null or ${t.nextReminderOn} between date '0001-01-01' and date '9999-12-31')
    and ((${t.templateId} is null)=(${t.workflowId} is null)) and (${t.templateId} is null or ${t.roleCount}>0)`),
]);

export const instrumentVersionServiceRoles = pgTable('instrument_version_service_roles', {
  ...scope(), serviceId: uuid('service_id').notNull(), roleId: uuid('role_id').notNull(), position: integer('position').notNull(), roleName: text('role_name').notNull(),
}, t => [primaryKey({ name: 'instrument_service_role_pk', columns: [...versionColumns(t), t.serviceId, t.roleId] }),
  unique('instrument_service_role_position').on(...versionColumns(t), t.serviceId, t.position), check('instrument_service_role_order', sql`${t.position} between 0 and 499`),
  foreignKey({ name: 'instrument_service_role_parent_fk', columns: [...versionColumns(t), t.serviceId], foreignColumns: [...versionColumns(instrumentVersionServices), instrumentVersionServices.id] }),
  foreignKey({ name: 'instrument_service_role_fk', columns: [t.organizationId, t.roleId], foreignColumns: [roles.organizationId, roles.id] }),
]);
