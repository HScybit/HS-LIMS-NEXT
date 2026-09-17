import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, integer, boolean, numeric, date, timestamp, primaryKey, unique, check, foreignKey, customType, index } from 'drizzle-orm/pg-core';
import { organizations, memberships } from './schema.js';
import { vendors } from './vendor-schema.js';
import { instruments } from './instrument-schema.js';

const transactionId = customType({ dataType: () => 'xid8' });
const bytes = customType({ dataType: () => 'bytea' });
const tenant = () => uuid('organization_id').notNull().references(() => organizations.id);
const time = name => timestamp(name, { withTimezone: true, mode: 'date' });
const scope = () => ({ organizationId: uuid('organization_id').notNull(), agreementId: uuid('agreement_id').notNull(), revision: integer('revision').notNull() });
const versionColumns = t => [t.organizationId, t.agreementId, t.revision];

export const serviceAgreementFiles = pgTable('service_agreement_files', {
  organizationId: tenant(), id: uuid('id').notNull(), originalName: text('original_name').notNull(), mediaType: text('media_type').notNull(),
  content: bytes('content').notNull(), byteLength: integer('byte_length').notNull(), sha256: text('sha256').notNull(),
  uploadedBy: uuid('uploaded_by').notNull(), uploadedAt: time('uploaded_at').notNull().defaultNow(),
}, t => [primaryKey({ name: 'service_agreement_file_pk', columns: [t.organizationId, t.id] }),
  foreignKey({ name: 'service_agreement_file_actor_fk', columns: [t.organizationId, t.uploadedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('service_agreement_file_values', sql`length(${t.originalName}) between 1 and 500 and ${t.originalName}=trim(${t.originalName})
    and ${t.originalName} !~ '[[:cntrl:]]' and position('/' in ${t.originalName})=0 and position(chr(92) in ${t.originalName})=0
    and ${t.mediaType} in ('application/pdf','image/jpeg','image/png','image/webp','text/plain','text/csv','application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    and ${t.byteLength} between 1 and 26214400 and ${t.byteLength}=octet_length(${t.content}) and ${t.sha256}=encode(sha256(${t.content}),'hex')`),
]);

const values = () => ({ vendorId: uuid('vendor_id').notNull(), startDate: date('start_date', { mode: 'string' }).notNull(), endDate: date('end_date', { mode: 'string' }).notNull(),
  noOfServices: integer('no_of_services').notNull().default(0), cost: numeric('cost', { precision: 18, scale: 2 }).notNull().default('0'),
  notes: text('notes'), inEffect: boolean('in_effect').notNull().default(false), attachmentFileId: uuid('attachment_file_id'), retired: boolean('retired').notNull().default(false) });
const valueCheck = (t, name) => check(name, sql`${t.startDate} between date '0001-01-01' and date '9999-12-31'
  and ${t.endDate} between date '0001-01-01' and date '9999-12-31' and ${t.startDate}<=${t.endDate}
  and ${t.noOfServices}>=0 and ${t.cost}>=0 and ${t.cost} not in ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)
  and (${t.notes} is null or length(${t.notes})<=10000) and (not ${t.retired} or not ${t.inEffect})`);
const references = (t, prefix) => [
  foreignKey({ name: `${prefix}_vendor_fk`, columns: [t.organizationId, t.vendorId], foreignColumns: [vendors.organizationId, vendors.id] }),
  foreignKey({ name: `${prefix}_file_fk`, columns: [t.organizationId, t.attachmentFileId], foreignColumns: [serviceAgreementFiles.organizationId, serviceAgreementFiles.id] }),
];

export const serviceAgreements = pgTable('service_agreements', {
  organizationId: tenant(), id: uuid('id').notNull().defaultRandom(), ...values(), revision: integer('revision').notNull().default(1),
  saveRequestId: uuid('save_request_id').notNull(), createdAt: time('created_at').notNull().defaultNow(), updatedAt: time('updated_at').notNull().defaultNow(),
}, t => [primaryKey({ name: 'service_agreement_pk', columns: [t.organizationId, t.id] }),
  valueCheck(t, 'service_agreement_values'), check('service_agreement_revision', sql`${t.revision}>0`), ...references(t, 'service_agreement'),
  index('service_agreement_listing').on(t.organizationId, t.createdAt, t.id).where(sql`not ${t.retired}`),
  index('service_agreement_vendor_use').on(t.organizationId, t.vendorId).where(sql`not ${t.retired}`),
]);

export const serviceAgreementVersions = pgTable('service_agreement_versions', {
  ...scope(), ...values(), vendorRevision: integer('vendor_revision').notNull(), vendorName: text('vendor_name').notNull(),
  requestId: uuid('request_id').notNull(), requestFingerprint: text('request_fingerprint').notNull(), previousRevision: integer('previous_revision'), operation: text('operation').notNull(),
  instrumentCount: integer('instrument_count').notNull(), serviceCount: integer('service_count').notNull(),
  instrumentsProvided: boolean('instruments_provided').notNull(), servicesProvided: boolean('services_provided').notNull(),
  savedBy: uuid('saved_by').notNull(), savedAt: time('saved_at').notNull().defaultNow(),
  createdTransactionId: transactionId('created_transaction_id').notNull().default(sql`pg_current_xact_id()`),
}, t => [primaryKey({ name: 'service_agreement_version_pk', columns: versionColumns(t) }), unique('service_agreement_save_request_key').on(t.organizationId, t.requestId),
  foreignKey({ name: 'service_agreement_version_organization_fk', columns: [t.organizationId], foreignColumns: [organizations.id] }),
  foreignKey({ name: 'service_agreement_version_parent_fk', columns: [t.organizationId, t.agreementId], foreignColumns: [serviceAgreements.organizationId, serviceAgreements.id] }),
  foreignKey({ name: 'service_agreement_version_actor_fk', columns: [t.organizationId, t.savedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  valueCheck(t, 'service_agreement_version_values'), ...references(t, 'service_agreement_version'),
  check('service_agreement_version_revision', sql`(${t.operation}='create' and ${t.previousRevision} is null and ${t.revision}=1)
    or (${t.operation} in ('update','retire') and ${t.previousRevision}>0 and ${t.previousRevision} is not null and ${t.revision}=${t.previousRevision}+1)`),
  check('service_agreement_version_command', sql`${t.requestFingerprint} ~ '^[a-f0-9]{64}$' and ${t.vendorRevision}>0
    and ${t.instrumentCount} between 1 and 500 and ${t.serviceCount} between 0 and 3 and (${t.retired}=(${t.operation}='retire'))
    and (${t.operation}<>'retire' or (not ${t.instrumentsProvided} and not ${t.servicesProvided}))`),
]);

export const serviceAgreementVersionInstruments = pgTable('service_agreement_version_instruments', {
  ...scope(), instrumentId: uuid('instrument_id').notNull(), position: integer('position').notNull(),
  instrumentRevision: integer('instrument_revision').notNull(), instrumentName: text('instrument_name').notNull(), instrumentCode: text('instrument_code').notNull(),
}, t => [primaryKey({ name: 'service_agreement_instrument_pk', columns: [...versionColumns(t), t.instrumentId] }),
  foreignKey({ name: 'service_agreement_instrument_organization_fk', columns: [t.organizationId], foreignColumns: [organizations.id] }),
  unique('service_agreement_instrument_position').on(...versionColumns(t), t.position),
  check('service_agreement_instrument_values', sql`${t.position} between 0 and 499 and ${t.instrumentRevision}>0`),
  foreignKey({ name: 'service_agreement_instrument_parent_fk', columns: versionColumns(t), foreignColumns: versionColumns(serviceAgreementVersions) }),
  foreignKey({ name: 'service_agreement_instrument_reference_fk', columns: [t.organizationId, t.instrumentId], foreignColumns: [instruments.organizationId, instruments.id] }),
  index('service_agreement_instrument_use').on(t.organizationId, t.instrumentId, t.agreementId, t.revision),
]);

export const serviceAgreementVersionServices = pgTable('service_agreement_version_services', {
  ...scope(), serviceCode: text('service_code').notNull(), position: integer('position').notNull(),
}, t => [primaryKey({ name: 'service_agreement_service_pk', columns: [...versionColumns(t), t.serviceCode] }),
  foreignKey({ name: 'service_agreement_service_organization_fk', columns: [t.organizationId], foreignColumns: [organizations.id] }),
  unique('service_agreement_service_position').on(...versionColumns(t), t.position),
  check('service_agreement_service_values', sql`${t.position} between 0 and 2 and ${t.serviceCode} in ('calibration','preventivemaintenance','breakdown')`),
  foreignKey({ name: 'service_agreement_service_parent_fk', columns: versionColumns(t), foreignColumns: versionColumns(serviceAgreementVersions) }),
]);
