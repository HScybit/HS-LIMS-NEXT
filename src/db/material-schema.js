import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, boolean, integer, timestamp, numeric, date, primaryKey, unique, uniqueIndex, index, foreignKey, check, customType } from 'drizzle-orm/pg-core';
import { organizations, memberships } from './schema.js';
import { measurementUnits } from './master-schema.js';

const time = name => timestamp(name, { withTimezone: true, mode: 'date' });
const transactionId = customType({ dataType: () => 'xid8' });

export const materialCategories = pgTable('material_categories', {
  organizationId: uuid('organization_id').notNull(), id: uuid('id').notNull().defaultRandom(),
  name: text('name').notNull(), description: text('description').notNull().default(''),
  reusable: boolean('reusable').notNull().default(false), expirable: boolean('expirable').notNull().default(false),
  active: boolean('active').notNull().default(true), revision: integer('revision').notNull().default(1), saveRequestId: uuid('save_request_id'),
  createdBy: uuid('created_by'), updatedBy: uuid('updated_by'), createdAt: time('created_at').notNull().defaultNow(), updatedAt: time('updated_at').notNull().defaultNow(),
}, table => [primaryKey({ name: 'material_categories_pkey', columns: [table.organizationId, table.id] }),
  foreignKey({ name: 'material_categories_organization_id_fkey', columns: [table.organizationId], foreignColumns: [organizations.id] }),
  uniqueIndex('material_category_active_name').on(table.organizationId, sql`lower(${table.name})`).where(sql`${table.active}`),
  index('material_category_created').on(table.organizationId, table.createdAt, table.id).where(sql`${table.active}`),
  foreignKey({ name: 'material_category_creator_fk', columns: [table.organizationId, table.createdBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  foreignKey({ name: 'material_category_editor_fk', columns: [table.organizationId, table.updatedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('material_category_fields', sql`length(trim(${table.name})) between 1 and 200 and length(${table.description})<=16000 and ${table.revision}>0`),
]);

export const materialCategoryVersions = pgTable('material_category_versions', {
  organizationId: uuid('organization_id').notNull(), categoryId: uuid('category_id').notNull(), revision: integer('revision').notNull(),
  requestId: uuid('request_id').notNull(), previousRevision: integer('previous_revision'), operation: text('operation').notNull(),
  name: text('name').notNull(), description: text('description').notNull(), reusable: boolean('reusable').notNull(), expirable: boolean('expirable').notNull(), active: boolean('active').notNull(),
  savedBy: uuid('saved_by').notNull(), savedAt: time('saved_at').notNull().defaultNow(),
  createdTransactionId: transactionId('created_transaction_id').notNull().default(sql`pg_current_xact_id()`),
}, table => [primaryKey({ name: 'material_category_version_pk', columns: [table.organizationId, table.categoryId, table.revision] }),
  foreignKey({ name: 'material_category_versions_organization_id_fkey', columns: [table.organizationId], foreignColumns: [organizations.id] }),
  unique('material_category_save_request').on(table.organizationId, table.requestId),
  foreignKey({ name: 'material_category_version_parent_fk', columns: [table.organizationId, table.categoryId], foreignColumns: [materialCategories.organizationId, materialCategories.id] }),
  foreignKey({ name: 'material_category_version_actor_fk', columns: [table.organizationId, table.savedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('material_category_version_revision', sql`(${table.operation}='create' and ${table.previousRevision} is null and ${table.revision}=1 and ${table.active})
    or (${table.operation} in ('update','retire') and ${table.previousRevision} is not null and ${table.previousRevision}>0 and ${table.revision}=${table.previousRevision}+1
      and ${table.active}=(${table.operation}='update'))`),
  check('material_category_version_fields', sql`length(trim(${table.name})) between 1 and 200 and length(${table.description})<=16000`),
]);

export const materials = pgTable('materials', {
  organizationId: uuid('organization_id').notNull(), id: uuid('id').notNull().defaultRandom(),
  name: text('name').notNull(), code: text('code').notNull(), description: text('description').notNull().default(''),
  categoryId: uuid('category_id').notNull(), measurementUnitId: uuid('measurement_unit_id').notNull(),
  initialQuantity: numeric('initial_quantity').notNull().default('0'), minimumQuantity: numeric('minimum_quantity').notNull().default('0'), maximumQuantity: numeric('maximum_quantity'),
  initialStockId: uuid('initial_stock_id'), initialStockCreatedAt: time('initial_stock_created_at'), initialStockCreatedBy: uuid('initial_stock_created_by'),
  active: boolean('active').notNull().default(true), revision: integer('revision').notNull().default(1), saveRequestId: uuid('save_request_id'), maximumProvided: boolean('maximum_provided').notNull().default(false),
  createdBy: uuid('created_by'), updatedBy: uuid('updated_by'), createdAt: time('created_at').notNull().defaultNow(), updatedAt: time('updated_at').notNull().defaultNow(),
}, table => [primaryKey({ name: 'materials_pk', columns: [table.organizationId, table.id] }),
  foreignKey({ name: 'materials_organization_id_fkey', columns: [table.organizationId], foreignColumns: [organizations.id] }),
  foreignKey({ name: 'material_category_fk', columns: [table.organizationId, table.categoryId], foreignColumns: [materialCategories.organizationId, materialCategories.id] }),
  foreignKey({ name: 'material_unit_fk', columns: [table.organizationId, table.measurementUnitId], foreignColumns: [measurementUnits.organizationId, measurementUnits.id] }),
  foreignKey({ name: 'material_creator_fk', columns: [table.organizationId, table.createdBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  foreignKey({ name: 'material_editor_fk', columns: [table.organizationId, table.updatedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  foreignKey({ name: 'material_opening_actor_fk', columns: [table.organizationId, table.initialStockCreatedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  uniqueIndex('material_active_code').on(table.organizationId, table.code).where(sql`${table.active}`),
  index('material_created').on(table.organizationId, table.createdAt, table.id).where(sql`${table.active}`),
  index('material_category_use').on(table.organizationId, table.categoryId, table.id).where(sql`${table.active}`),
  check('material_fields', sql`length(trim(${table.name})) between 1 and 200 and length(trim(${table.code})) between 1 and 64 and length(${table.description})<=16000 and ${table.revision}>0`),
  check('material_amounts', sql`${table.initialQuantity} between 0 and 1.7976931348623157e308::numeric and ${table.minimumQuantity} between 0 and 1.7976931348623157e308::numeric
    and (${table.maximumQuantity} is null or ${table.maximumQuantity} between ${table.minimumQuantity} and 1.7976931348623157e308::numeric)`),
  check('material_opening_identity', sql`(${table.initialQuantity}=0 and ${table.initialStockId} is null and ${table.initialStockCreatedAt} is null and ${table.initialStockCreatedBy} is null)
    or (${table.initialQuantity}>0 and ${table.initialStockId} is not null and ${table.initialStockCreatedAt} is not null)`),
]);

export const materialVersions = pgTable('material_versions', {
  organizationId: uuid('organization_id').notNull(), materialId: uuid('material_id').notNull(), revision: integer('revision').notNull(),
  requestId: uuid('request_id').notNull(), previousRevision: integer('previous_revision'), operation: text('operation').notNull(),
  name: text('name').notNull(), code: text('code').notNull(), description: text('description').notNull(),
  categoryId: uuid('category_id').notNull(), categoryName: text('category_name').notNull(), categoryReusable: boolean('category_reusable').notNull(), categoryExpirable: boolean('category_expirable').notNull(),
  measurementUnitId: uuid('measurement_unit_id').notNull(), unitName: text('unit_name').notNull(), unitSymbol: text('unit_symbol').notNull(),
  initialQuantity: numeric('initial_quantity').notNull(), minimumQuantity: numeric('minimum_quantity').notNull(), maximumQuantity: numeric('maximum_quantity'),
  initialStockId: uuid('initial_stock_id'), initialStockCreatedAt: time('initial_stock_created_at'), initialStockCreatedBy: uuid('initial_stock_created_by'),
  active: boolean('active').notNull(), maximumProvided: boolean('maximum_provided').notNull(), savedBy: uuid('saved_by').notNull(), savedAt: time('saved_at').notNull().defaultNow(),
  createdTransactionId: transactionId('created_transaction_id').notNull().default(sql`pg_current_xact_id()`),
}, table => [primaryKey({ name: 'material_version_pk', columns: [table.organizationId, table.materialId, table.revision] }),
  foreignKey({ name: 'material_versions_organization_id_fkey', columns: [table.organizationId], foreignColumns: [organizations.id] }),
  unique('material_save_request').on(table.organizationId, table.requestId),
  foreignKey({ name: 'material_version_parent_fk', columns: [table.organizationId, table.materialId], foreignColumns: [materials.organizationId, materials.id] }),
  foreignKey({ name: 'material_version_category_fk', columns: [table.organizationId, table.categoryId], foreignColumns: [materialCategories.organizationId, materialCategories.id] }),
  foreignKey({ name: 'material_version_unit_fk', columns: [table.organizationId, table.measurementUnitId], foreignColumns: [measurementUnits.organizationId, measurementUnits.id] }),
  foreignKey({ name: 'material_version_actor_fk', columns: [table.organizationId, table.savedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  foreignKey({ name: 'material_version_opening_actor_fk', columns: [table.organizationId, table.initialStockCreatedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('material_version_revision', sql`(${table.operation}='create' and ${table.previousRevision} is null and ${table.revision}=1 and ${table.active})
    or (${table.operation} in ('update','retire') and ${table.previousRevision} is not null and ${table.previousRevision}>0 and ${table.revision}=${table.previousRevision}+1 and ${table.active}=(${table.operation}='update'))`),
]);

export const materialTransactions = pgTable('material_transactions', {
  organizationId: uuid('organization_id').notNull(), id: uuid('id').notNull().defaultRandom(), materialId: uuid('material_id').notNull(),
  requestId: uuid('request_id').notNull(), transactionType: text('transaction_type').notNull(), quantity: numeric('quantity').notNull(), cost: numeric('cost'),
  supplier: text('supplier').notNull().default(''), batchSerialNumber: text('batch_serial_number').notNull(), expiryDate: date('expiry_date'),
  measurementUnitId: uuid('measurement_unit_id').notNull(), unitName: text('unit_name').notNull(), unitSymbol: text('unit_symbol').notNull(), categoryExpirable: boolean('category_expirable').notNull(),
  createdBy: uuid('created_by').notNull(), createdAt: time('created_at').notNull().defaultNow(), createdTransactionId: transactionId('created_transaction_id').notNull().default(sql`pg_current_xact_id()`),
}, table => [primaryKey({ name: 'material_transaction_pk', columns: [table.organizationId, table.id] }),
  foreignKey({ name: 'material_transactions_organization_id_fkey', columns: [table.organizationId], foreignColumns: [organizations.id] }),
  unique('material_transaction_request').on(table.organizationId, table.requestId),
  foreignKey({ name: 'material_transaction_parent_fk', columns: [table.organizationId, table.materialId], foreignColumns: [materials.organizationId, materials.id] }),
  foreignKey({ name: 'material_transaction_unit_fk', columns: [table.organizationId, table.measurementUnitId], foreignColumns: [measurementUnits.organizationId, measurementUnits.id] }),
  foreignKey({ name: 'material_transaction_actor_fk', columns: [table.organizationId, table.createdBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  index('material_transaction_date').on(table.organizationId, table.materialId, table.createdAt, table.id),
  index('material_transaction_batch').on(table.organizationId, table.materialId, table.batchSerialNumber),
  index('material_in_batch_lookup').on(table.organizationId, table.materialId, sql`lower(${table.batchSerialNumber})`).where(sql`${table.transactionType}='in'`),
  check('material_transaction_fields', sql`${table.transactionType} in ('in','out','out_damaged') and length(trim(${table.batchSerialNumber})) between 1 and 150 and length(${table.supplier})<=250`),
  check('material_transaction_amounts', sql`${table.quantity}>0 and ${table.quantity}<=1.7976931348623157e308::numeric
    and ((${table.transactionType}='in' and ${table.cost} is not null and ${table.cost} between 0 and 1.7976931348623157e308::numeric)
      or (${table.transactionType}<>'in' and ${table.cost} is null and ${table.expiryDate} is null))`),
  check('material_transaction_expiry', sql`${table.expiryDate} is null or ${table.expiryDate} between date '0001-01-01' and date '9999-12-31'`),
]);
