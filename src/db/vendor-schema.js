import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, integer, boolean, numeric, timestamp, primaryKey, unique, uniqueIndex, check, foreignKey, customType, index } from 'drizzle-orm/pg-core';
import { organizations, memberships } from './schema.js';

const transactionId = customType({ dataType: () => 'xid8' });
const tenant = () => uuid('organization_id').notNull().references(() => organizations.id);
const time = name => timestamp(name, { withTimezone: true, mode: 'date' });
const values = () => ({ code: text('code').notNull(), name: text('name').notNull(), legalName: text('legal_name').notNull(),
  abbreviation: text('abbreviation'), taxIdentifier: text('tax_identifier'), totalBalance: numeric('total_balance', { precision: 18, scale: 2 }).notNull().default('0'),
  active: boolean('active').notNull().default(true), retired: boolean('retired').notNull().default(false),
  customFieldCount: integer('custom_field_count').notNull().default(0), customFieldsProvided: boolean('custom_fields_provided').notNull().default(false) });
const valueCheck = (t, name) => check(name, sql`length(trim(${t.code})) between 1 and 64 and ${t.code} ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'
  and length(trim(${t.name})) between 1 and 250 and length(trim(${t.legalName})) between 1 and 250
  and (${t.abbreviation} is null or length(${t.abbreviation})<=64) and (${t.taxIdentifier} is null or length(${t.taxIdentifier})<=100)
  and ${t.totalBalance} not in ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)
  and (not ${t.retired} or not ${t.active}) and ${t.customFieldCount} between 0 and 500`);

export const vendors = pgTable('vendors', {
  organizationId: tenant(), id: uuid('id').notNull().defaultRandom(), ...values(), revision: integer('revision').notNull().default(1),
  saveRequestId: uuid('save_request_id').notNull(), createdAt: time('created_at').notNull().defaultNow(), updatedAt: time('updated_at').notNull().defaultNow(),
}, t => [primaryKey({ name: 'vendor_pk', columns: [t.organizationId, t.id] }),
  uniqueIndex('vendors_code_key').on(t.organizationId, sql`lower(${t.code})`).where(sql`not ${t.retired}`),
  valueCheck(t, 'vendor_values'), check('vendor_revision', sql`${t.revision}>0`),
  index('vendor_scheme_order').on(t.organizationId, t.createdAt, t.updatedAt, t.id).where(sql`not ${t.retired}`),
]);

const contactValues = () => ({ name: text('name').notNull(), email: text('email').notNull(), phone: text('phone').notNull(), isPrimary: boolean('is_primary').notNull().default(false) });
const contactCheck = (t, name) => check(name, sql`length(trim(${t.name})) between 1 and 200 and length(${t.email}) between 3 and 320
  and ${t.email} ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' and length(trim(${t.phone})) between 1 and 50`);

export const vendorContacts = pgTable('vendor_contacts', {
  organizationId: tenant(), id: uuid('id').notNull().defaultRandom(), vendorId: uuid('vendor_id').notNull(), ...contactValues(),
}, t => [primaryKey({ name: 'vendor_contact_pk', columns: [t.organizationId, t.id] }),
  foreignKey({ name: 'vendor_contact_parent_fk', columns: [t.organizationId, t.vendorId], foreignColumns: [vendors.organizationId, vendors.id] }),
  uniqueIndex('vendor_primary_contact_key').on(t.organizationId, t.vendorId).where(sql`${t.isPrimary}`),
  index('vendor_contact_parent_idx').on(t.organizationId, t.vendorId, t.id), contactCheck(t, 'vendor_contact_values'),
]);

const scope = () => ({ organizationId: tenant(), vendorId: uuid('vendor_id').notNull(), revision: integer('revision').notNull() });
const versionColumns = t => [t.organizationId, t.vendorId, t.revision];

export const vendorVersions = pgTable('vendor_versions', {
  ...scope(), ...values(), requestId: uuid('request_id').notNull(), requestFingerprint: text('request_fingerprint').notNull(),
  previousRevision: integer('previous_revision'), operation: text('operation').notNull(), contactCount: integer('contact_count').notNull(),
  savedBy: uuid('saved_by').notNull(), savedAt: time('saved_at').notNull().defaultNow(),
  createdTransactionId: transactionId('created_transaction_id').notNull().default(sql`pg_current_xact_id()`),
}, t => [primaryKey({ name: 'vendor_version_pk', columns: versionColumns(t) }), unique('vendor_save_request_key').on(t.organizationId, t.requestId),
  foreignKey({ name: 'vendor_version_parent_fk', columns: [t.organizationId, t.vendorId], foreignColumns: [vendors.organizationId, vendors.id] }),
  foreignKey({ name: 'vendor_version_actor_fk', columns: [t.organizationId, t.savedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  valueCheck(t, 'vendor_version_values'),
  check('vendor_version_revision', sql`(${t.operation}='create' and ${t.previousRevision} is null and ${t.revision}=1)
    or (${t.operation} in ('update','retire') and ${t.previousRevision}>0 and ${t.previousRevision} is not null and ${t.revision}=${t.previousRevision}+1)`),
  check('vendor_version_command', sql`${t.requestFingerprint} ~ '^[a-f0-9]{64}$' and ${t.contactCount} between 1 and 100
    and (${t.retired}=(${t.operation}='retire')) and (not ${t.retired} or not ${t.customFieldsProvided})`),
]);

export const vendorVersionContacts = pgTable('vendor_version_contacts', {
  ...scope(), id: uuid('id').notNull(), position: integer('position').notNull(), ...contactValues(),
}, t => [primaryKey({ name: 'vendor_version_contact_pk', columns: [...versionColumns(t), t.id] }),
  unique('vendor_version_contact_position').on(...versionColumns(t), t.position), check('vendor_version_contact_order', sql`${t.position} between 0 and 99`),
  index('vendor_version_contact_identity').on(t.organizationId, t.id, t.vendorId), contactCheck(t, 'vendor_version_contact_values'),
  foreignKey({ name: 'vendor_version_contact_parent_fk', columns: versionColumns(t), foreignColumns: versionColumns(vendorVersions) }),
]);
