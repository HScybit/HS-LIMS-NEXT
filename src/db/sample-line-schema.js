import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, numeric, primaryKey, unique, foreignKey, check } from 'drizzle-orm/pg-core';
import { organizations } from './schema.js';
import { sampleCategories, products } from './master-schema.js';
import { datasheets, sampleProducts } from './sample-schema.js';
import { sampleReports } from './report-schema.js';

// A line as observed when this actual consumer was created. Its owner carries
// the creation actor/time; later line or master edits cannot rewrite it.
export const sampleLineContexts = pgTable('sample_line_contexts', {
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  id: uuid('id').notNull().defaultRandom(), datasheetId: uuid('datasheet_id'), reportId: uuid('report_id'),
  sampleProductId: uuid('sample_product_id').notNull(), productId: uuid('product_id').notNull(), sampleCategoryId: uuid('sample_category_id').notNull(),
  productName: text('product_name').notNull(), categoryName: text('category_name').notNull(), description: text('description'),
  quantity: numeric('quantity').notNull(), sampleSize: text('sample_size'), quality: text('quality'),
  identificationMark: text('identification_mark'), receivedCondition: text('received_condition'),
}, (t) => [primaryKey({ name: 'sample_line_context_pk', columns: [t.organizationId, t.id] }),
  unique('sample_line_datasheet_key').on(t.organizationId, t.datasheetId), unique('sample_line_report_key').on(t.organizationId, t.reportId),
  foreignKey({ name: 'sample_line_datasheet_fk', columns: [t.organizationId, t.datasheetId], foreignColumns: [datasheets.organizationId, datasheets.id] }),
  foreignKey({ name: 'sample_line_report_fk', columns: [t.organizationId, t.reportId], foreignColumns: [sampleReports.organizationId, sampleReports.id] }),
  foreignKey({ name: 'sample_line_source_fk', columns: [t.organizationId, t.sampleProductId], foreignColumns: [sampleProducts.organizationId, sampleProducts.id] }),
  foreignKey({ name: 'sample_line_product_fk', columns: [t.organizationId, t.productId], foreignColumns: [products.organizationId, products.id] }),
  foreignKey({ name: 'sample_line_category_fk', columns: [t.organizationId, t.sampleCategoryId], foreignColumns: [sampleCategories.organizationId, sampleCategories.id] }),
  check('sample_line_owner', sql`num_nonnulls(${t.datasheetId},${t.reportId})=1`),
  check('sample_line_text_size', sql`length(${t.productName})<=16000 and length(${t.categoryName})<=16000
    and (${t.description} is null or length(${t.description})<=16000) and (${t.sampleSize} is null or length(${t.sampleSize})<=16000)
    and (${t.quality} is null or length(${t.quality})<=16000) and (${t.identificationMark} is null or length(${t.identificationMark})<=16000)
    and (${t.receivedCondition} is null or length(${t.receivedCondition})<=16000)`),
  check('sample_line_quantity', sql`${t.quantity}>0 and ${t.quantity} not in ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric) and length(${t.quantity}::text)<=16000`),
]);
