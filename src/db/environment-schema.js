import { sql } from 'drizzle-orm';
import { pgTable, uuid, numeric, integer, timestamp, primaryKey, foreignKey, check, index } from 'drizzle-orm/pg-core';
import { organizations, memberships } from './schema.js';
import { laboratories } from './master-schema.js';

const time = (name) => timestamp(name, { withTimezone: true, mode: 'date' });
const tenant = () => uuid('organization_id').notNull().references(() => organizations.id);
const finite = (column) => sql`${column} not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)`;

// Step 10c: current-state readings, matching Meteor/PERN (no approval
// workflow, no versioned history) — same precedent as Leave Management.
// Laboratory min/max limits stay as free text (laboratories.minimum/
// maximumTemperature/Humidity, from an earlier masters step); validation
// parses that text at write time rather than duplicating numeric columns.
export const environmentData = pgTable('environment_data', {
  organizationId: tenant(), id: uuid('id').notNull().defaultRandom(),
  laboratoryId: uuid('laboratory_id').notNull(), recordedAt: time('recorded_at').notNull(),
  temperatureCelsius: numeric('temperature_celsius'), relativeHumidityPercent: numeric('relative_humidity_percent'),
  revision: integer('revision').notNull().default(1),
  recordedBy: uuid('recorded_by').notNull(), createdAt: time('created_at').notNull().defaultNow(), updatedAt: time('updated_at').notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.organizationId, t.id] }),
  foreignKey({ name: 'environment_data_laboratory_fk', columns: [t.organizationId, t.laboratoryId], foreignColumns: [laboratories.organizationId, laboratories.id] }),
  foreignKey({ name: 'environment_data_actor_fk', columns: [t.organizationId, t.recordedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('environment_data_fields', sql`(${t.temperatureCelsius} is not null or ${t.relativeHumidityPercent} is not null)
    and (${t.temperatureCelsius} is null or (${t.temperatureCelsius} between -100 and 200 and ${finite(t.temperatureCelsius)}))
    and (${t.relativeHumidityPercent} is null or (${t.relativeHumidityPercent} between 0 and 100 and ${finite(t.relativeHumidityPercent)}))
    and ${t.revision} > 0`),
  index('environment_data_listing').on(t.organizationId, t.recordedAt, t.id),
]);
