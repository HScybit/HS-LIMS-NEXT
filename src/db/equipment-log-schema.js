import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, numeric, integer, date, timestamp, primaryKey, foreignKey, check, index } from 'drizzle-orm/pg-core';
import { organizations, memberships } from './schema.js';
import { instruments } from './instrument-schema.js';
import { vendors } from './vendor-schema.js';

const time = (name) => timestamp(name, { withTimezone: true, mode: 'date' });
const tenant = () => uuid('organization_id').notNull().references(() => organizations.id);
const finite = (column) => sql`${column} not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)`;

// Step 10d: current-state logs against the already-built Instrument master
// (no approval workflow, no versioned history — same precedent as Leave
// Management/Environmental Monitoring). service_code is one of the fixed
// Instrument service types (breakdown events go through instrumentBreakdownLogs
// instead, so it isn't a valid service_code here).
export const instrumentServiceLogs = pgTable('instrument_service_logs', {
  organizationId: tenant(), id: uuid('id').notNull().defaultRandom(),
  instrumentId: uuid('instrument_id').notNull(), serviceCode: text('service_code').notNull(),
  serviceDate: date('service_date', { mode: 'string' }).notNull(), nextServiceOn: date('next_service_on', { mode: 'string' }),
  summary: text('summary').notNull(), details: text('details'),
  vendorId: uuid('vendor_id'), vendorName: text('vendor_name'), cost: numeric('cost'), calibrationType: text('calibration_type'),
  revision: integer('revision').notNull().default(1),
  createdBy: uuid('created_by').notNull(), createdAt: time('created_at').notNull().defaultNow(),
  updatedBy: uuid('updated_by').notNull(), updatedAt: time('updated_at').notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.organizationId, t.id] }),
  foreignKey({ name: 'instrument_service_log_instrument_fk', columns: [t.organizationId, t.instrumentId], foreignColumns: [instruments.organizationId, instruments.id] }),
  foreignKey({ name: 'instrument_service_log_vendor_fk', columns: [t.organizationId, t.vendorId], foreignColumns: [vendors.organizationId, vendors.id] }),
  foreignKey({ name: 'instrument_service_log_created_actor_fk', columns: [t.organizationId, t.createdBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  foreignKey({ name: 'instrument_service_log_updated_actor_fk', columns: [t.organizationId, t.updatedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('instrument_service_log_fields', sql`length(trim(${t.serviceCode})) between 1 and 64 and length(trim(${t.summary})) between 1 and 500
    and (${t.details} is null or length(${t.details}) between 1 and 10000)
    and (${t.nextServiceOn} is null or ${t.nextServiceOn} >= ${t.serviceDate})
    and (${t.cost} is null or (${t.cost} >= 0 and ${finite(t.cost)})) and (${t.calibrationType} is null or length(trim(${t.calibrationType})) between 1 and 100)
    and ${t.revision} > 0`),
  check('instrument_service_log_code_values', sql`${t.serviceCode}=ANY(ARRAY['preventive_maintenance','calibration'])`),
  index('instrument_service_log_listing').on(t.organizationId, t.instrumentId, t.serviceDate, t.id),
]);

export const instrumentBreakdownLogs = pgTable('instrument_breakdown_logs', {
  organizationId: tenant(), id: uuid('id').notNull().defaultRandom(),
  instrumentId: uuid('instrument_id').notNull(), breakdownDate: date('breakdown_date', { mode: 'string' }).notNull(),
  summary: text('summary').notNull(), details: text('details'), status: text('status').notNull().default('open'),
  resolvedOn: date('resolved_on', { mode: 'string' }), resolutionVendorId: uuid('resolution_vendor_id'), resolutionVendorName: text('resolution_vendor_name'),
  resolutionCost: numeric('resolution_cost'), resolutionComments: text('resolution_comments'),
  revision: integer('revision').notNull().default(1),
  createdBy: uuid('created_by').notNull(), createdAt: time('created_at').notNull().defaultNow(),
  updatedBy: uuid('updated_by').notNull(), updatedAt: time('updated_at').notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.organizationId, t.id] }),
  foreignKey({ name: 'instrument_breakdown_log_instrument_fk', columns: [t.organizationId, t.instrumentId], foreignColumns: [instruments.organizationId, instruments.id] }),
  foreignKey({ name: 'instrument_breakdown_log_vendor_fk', columns: [t.organizationId, t.resolutionVendorId], foreignColumns: [vendors.organizationId, vendors.id] }),
  foreignKey({ name: 'instrument_breakdown_log_created_actor_fk', columns: [t.organizationId, t.createdBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  foreignKey({ name: 'instrument_breakdown_log_updated_actor_fk', columns: [t.organizationId, t.updatedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('instrument_breakdown_log_fields', sql`length(trim(${t.summary})) between 1 and 500 and (${t.details} is null or length(${t.details}) between 1 and 10000)
    and ${t.status} in ('open', 'resolved') and ${t.revision} > 0
    and (${t.status} = 'open' and ${t.resolvedOn} is null and ${t.resolutionVendorId} is null and ${t.resolutionVendorName} is null
        and ${t.resolutionCost} is null and ${t.resolutionComments} is null
      or ${t.status} = 'resolved' and ${t.resolvedOn} is not null and ${t.resolvedOn} >= ${t.breakdownDate}
        and (${t.resolutionVendorId} is not null or ${t.resolutionVendorName} is not null)
        and ${t.resolutionCost} is not null and ${t.resolutionCost} >= 0 and ${finite(t.resolutionCost)}
        and ${t.resolutionComments} is not null and length(trim(${t.resolutionComments})) between 1 and 10000)`),
  index('instrument_breakdown_log_listing').on(t.organizationId, t.instrumentId, t.breakdownDate, t.id),
]);
