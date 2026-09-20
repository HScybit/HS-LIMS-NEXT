import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

if (!process.env.MIGRATION_DATABASE_URL) throw new Error('MIGRATION_DATABASE_URL is required.');
const client = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
try {
  await client.connect();
  await client.query("SELECT pg_advisory_lock(hashtext('sampleify_schema_migrations'))");
  await migrate(drizzle(client), { migrationsFolder: './drizzle' });
  console.log('Version-controlled migrations applied successfully.');
} finally {
  await client.end();
}
