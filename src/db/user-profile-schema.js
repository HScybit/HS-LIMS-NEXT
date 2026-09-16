import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, integer, boolean, timestamp, primaryKey, unique, uniqueIndex, check, foreignKey, customType } from 'drizzle-orm/pg-core';
import { organizations, memberships, membershipRoles, roles } from './schema.js';
import { laboratories } from './master-schema.js';
import { roleVersions } from './role-history-schema.js';

const time = (name) => timestamp(name, { withTimezone: true, mode: 'date' });
const transactionId = customType({ dataType: () => 'xid8' });
const scope = () => ({ organizationId: uuid('organization_id').notNull().references(() => organizations.id), userId: uuid('user_id').notNull() });
const member = (t, column, name) => foreignKey({ name, columns: [t.organizationId, column], foreignColumns: [memberships.organizationId, memberships.userId] });
const reference = (t, column, target, name) => foreignKey({ name, columns: [t.organizationId, column], foreignColumns: [target.organizationId, target.id] });
const versionKey = (t) => [t.organizationId, t.userId, t.revision];
const fields = () => ({
  employeeCode: text('employee_code'), phone: text('phone'), designation: text('designation'), canManagePeople: boolean('can_manage_people').notNull(),
  businessUnitId: uuid('business_unit_id'), defaultRoleId: uuid('default_role_id').notNull(), laboratoryId: uuid('laboratory_id').notNull(), reportingManagerId: uuid('reporting_manager_id'),
});
const validFields = (t, name) => check(name, sql`(${t.employeeCode} is null or length(${t.employeeCode}) between 1 and 100)
  and (${t.phone} is null or length(${t.phone}) between 1 and 50) and (${t.designation} is null or length(${t.designation}) between 1 and 150)
  and ${t.reportingManagerId} is distinct from ${t.userId}`);

// Required by the in-scope User Management unit selector; management screens follow separately.
export const businessUnits = pgTable('business_units', {
  organizationId: uuid('organization_id').notNull().references(() => organizations.id), id: uuid('id').notNull().defaultRandom(),
  code: text('code').notNull(), name: text('name').notNull(), description: text('description'), active: boolean('active').notNull().default(true),
  revision: integer('revision').notNull().default(1), createdAt: time('created_at').notNull().defaultNow(), updatedAt: time('updated_at').notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.organizationId, t.id] }), uniqueIndex('business_units_code_key').on(t.organizationId, sql`lower(${t.code})`),
  check('business_unit_fields', sql`length(trim(${t.code})) between 1 and 64 and length(trim(${t.name})) between 1 and 200
    and (${t.description} is null or length(${t.description})<=2000) and ${t.revision}>0`)]);

// Only actual native saves create versions; preexisting support rows retain their original provenance.
export const businessUnitVersions = pgTable('business_unit_versions', {
  organizationId: uuid('organization_id').notNull(), unitId: uuid('unit_id').notNull(), revision: integer('revision').notNull(),
  previousRevision: integer('previous_revision'), requestId: uuid('request_id').notNull(), code: text('code').notNull(), name: text('name').notNull(),
  description: text('description'), active: boolean('active').notNull(), savedBy: uuid('saved_by').notNull(),
  savedByUsername: text('saved_by_username').notNull(), savedByName: text('saved_by_name').notNull(),
  savedAt: time('saved_at').notNull().defaultNow(), createdTransactionId: transactionId('created_transaction_id').notNull().default(sql`pg_current_xact_id()`),
}, (t) => [primaryKey({ name: 'business_unit_version_pk', columns: [t.organizationId, t.unitId, t.revision] }),
  unique('business_unit_request_key').on(t.organizationId, t.requestId), reference(t, t.unitId, businessUnits, 'business_unit_version_head_fk'),
  member(t, t.savedBy, 'business_unit_version_actor_fk'),
  check('business_unit_version_revision', sql`(${t.previousRevision} is null and ${t.revision}=1) or (${t.previousRevision} is not null and ${t.previousRevision}>0 and ${t.revision}=${t.previousRevision}+1)`),
  check('business_unit_version_fields', sql`length(${t.code}) between 1 and 64 and ${t.code} ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'
    and length(trim(${t.name})) between 1 and 200 and (${t.description} is null or length(${t.description})<=2000)`)]);

// Absence means these membership details have not been recorded, rather than a guessed default role/lab.
export const userProfiles = pgTable('user_profiles', {
  ...scope(), ...fields(), revision: integer('revision').notNull(),
}, (t) => [primaryKey({ name: 'user_profile_pk', columns: [t.organizationId, t.userId] }),
  member(t, t.userId, 'user_profile_member_fk'), member(t, t.reportingManagerId, 'user_profile_manager_fk'),
  reference(t, t.businessUnitId, businessUnits, 'user_profile_unit_fk'), reference(t, t.laboratoryId, laboratories, 'user_profile_lab_fk'),
  foreignKey({ name: 'user_profile_default_assignment_fk', columns: [t.organizationId, t.userId, t.defaultRoleId],
    foreignColumns: [membershipRoles.organizationId, membershipRoles.userId, membershipRoles.roleId] }),
  validFields(t, 'user_profile_fields'), check('user_profile_revision', sql`${t.revision}>0`)]);

export const userProfileVersions = pgTable('user_profile_versions', {
  ...scope(), ...fields(), revision: integer('revision').notNull(), previousRevision: integer('previous_revision'), requestId: uuid('request_id').notNull(),
  employeeCodeProvided: boolean('employee_code_provided').notNull(), phoneProvided: boolean('phone_provided').notNull(),
  designationProvided: boolean('designation_provided').notNull(), canManagePeopleProvided: boolean('can_manage_people_provided').notNull(),
  businessUnitProvided: boolean('business_unit_provided').notNull(), defaultRoleProvided: boolean('default_role_provided').notNull(),
  laboratoryProvided: boolean('laboratory_provided').notNull(), reportingManagerProvided: boolean('reporting_manager_provided').notNull(), rolesProvided: boolean('roles_provided').notNull(),
  businessUnitCode: text('business_unit_code'), businessUnitName: text('business_unit_name'), laboratoryCode: text('laboratory_code').notNull(), laboratoryName: text('laboratory_name').notNull(),
  reportingManagerUsername: text('reporting_manager_username'), reportingManagerName: text('reporting_manager_name'),
  roleCount: integer('role_count').notNull(), savedBy: uuid('saved_by').notNull(), savedByUsername: text('saved_by_username').notNull(), savedByName: text('saved_by_name').notNull(),
  savedAt: time('saved_at').notNull().defaultNow(), createdTransactionId: transactionId('created_transaction_id').notNull().default(sql`pg_current_xact_id()`),
}, (t) => [primaryKey({ name: 'user_profile_version_pk', columns: versionKey(t) }), unique('user_profile_request_key').on(t.organizationId, t.requestId),
  foreignKey({ name: 'user_profile_version_head_fk', columns: [t.organizationId, t.userId], foreignColumns: [userProfiles.organizationId, userProfiles.userId] }),
  member(t, t.savedBy, 'user_profile_version_actor_fk'), member(t, t.reportingManagerId, 'user_profile_version_manager_fk'),
  reference(t, t.businessUnitId, businessUnits, 'user_profile_version_unit_fk'), reference(t, t.laboratoryId, laboratories, 'user_profile_version_lab_fk'),
  reference(t, t.defaultRoleId, roles, 'user_profile_version_default_fk'), validFields(t, 'user_profile_version_fields'),
  check('user_profile_version_revision', sql`(${t.previousRevision} is null and ${t.revision}=1)
    or (${t.previousRevision} is not null and ${t.previousRevision}>0 and ${t.revision}=${t.previousRevision}+1)`),
  check('user_profile_version_details', sql`${t.roleCount}>0
    and ((${t.businessUnitId} is null and num_nonnulls(${t.businessUnitCode},${t.businessUnitName})=0)
      or (${t.businessUnitId} is not null and num_nonnulls(${t.businessUnitCode},${t.businessUnitName})=2))
    and ((${t.reportingManagerId} is null and num_nonnulls(${t.reportingManagerUsername},${t.reportingManagerName})=0)
      or (${t.reportingManagerId} is not null and num_nonnulls(${t.reportingManagerUsername},${t.reportingManagerName})=2))
    and (${t.employeeCodeProvided} or ${t.phoneProvided} or ${t.designationProvided} or ${t.canManagePeopleProvided}
      or ${t.businessUnitProvided} or ${t.defaultRoleProvided} or ${t.laboratoryProvided} or ${t.reportingManagerProvided} or ${t.rolesProvided})`)]);

export const userProfileVersionRoles = pgTable('user_profile_version_roles', {
  ...scope(), revision: integer('revision').notNull(), roleId: uuid('role_id').notNull(), recordedRoleRevision: integer('recorded_role_revision'),
  name: text('name').notNull(), description: text('description').notNull(), active: boolean('active').notNull(), explicitlySelected: boolean('explicitly_selected').notNull(),
}, (t) => [primaryKey({ name: 'user_profile_version_role_pk', columns: [...versionKey(t), t.roleId] }),
  foreignKey({ name: 'user_profile_version_role_parent_fk', columns: versionKey(t), foreignColumns: versionKey(userProfileVersions) }),
  reference(t, t.roleId, roles, 'user_profile_version_role_fk'),
  foreignKey({ name: 'user_profile_observed_role_version_fk', columns: [t.organizationId, t.roleId, t.recordedRoleRevision],
    foreignColumns: [roleVersions.organizationId, roleVersions.roleId, roleVersions.revision] }),
  check('user_profile_observed_role_revision', sql`${t.recordedRoleRevision} is null or ${t.recordedRoleRevision}>0`)]);
