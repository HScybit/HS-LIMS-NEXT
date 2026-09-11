import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createAccount } from '../tests/helpers/database.js';
import { signIn, withSession } from '../src/auth/service.js';
import { closePool, getPool } from '../src/db/pool.js';
import { createAnalyticalTemplate } from '../tests/helpers/templates.js';
import { freezeTemplate } from '../src/templates/authoring.js';
import { createCapture } from '../src/templates/capture.js';
import { loadCapture, loadDefinition } from '../src/templates/loader.js';
import { createLaboratoryFixture } from '../tests/helpers/laboratory.js';
import { quickCreateCustomer } from '../src/samples/customer.js';
import { registerSample } from '../src/samples/register.js';
import { loadSample } from '../src/samples/load.js';
import { generateTestRequests } from '../src/test-requests/generate.js';
import { allocateTestRequest } from '../src/test-requests/allocate.js';

const ownerUrl = new URL(process.env.MIGRATION_DATABASE_URL);
const appUrl = new URL(process.env.DATABASE_URL);
for (const [url, username] of [[ownerUrl, 'sampleify_owner'], [appUrl, 'sampleify_app']]) {
  if (url.hostname !== '127.0.0.1' || url.port !== '55442' || url.pathname !== '/sampleify_local' || url.username !== username) {
    throw new Error('Migration verification requires the dedicated local synthetic database roles.');
  }
}

// A new database exercises every migration from an empty schema. Keep it for inspection;
// neither existing data nor previously applied migrations are reset or removed.
const databaseName = `sampleify_verify_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Client({ connectionString: ownerUrl.href });
let owner;
try {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  ownerUrl.pathname = `/${databaseName}`;
  appUrl.pathname = `/${databaseName}`;
  process.env.DATABASE_URL = appUrl.href;
  owner = new pg.Pool({ connectionString: ownerUrl.href, max: 2 });
  const client = await owner.connect();
  try {
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: './drizzle' });
    await migrate(db, { migrationsFolder: './drizzle' }); // Reapplying must be a no-op.
  } finally { client.release(); }
  const expected = JSON.parse(await readFile('drizzle/meta/_journal.json', 'utf8')).entries.length;
  const count = Number((await owner.query('SELECT count(*) FROM drizzle.__drizzle_migrations')).rows[0].count);
  assert.equal(count, expected);
  assert.equal((await owner.query("SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND data_type IN ('json', 'jsonb')")).rowCount, 0);
  const role = (await getPool().query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0];
  assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });
  assert.equal((await getPool().query('SELECT * FROM templates')).rowCount, 0);
  const account = await createAccount(owner, { permissions: ['templates.read', 'templates.manage', 'datasheets.execute', 'samples.read', 'samples.create', 'samples.manage', 'test_requests.allocate'] });
  const session = await signIn({ identifier: account.username, password: account.password });
  await withSession(session.token, async (client, identity) => {
    const template = await createAnalyticalTemplate(client, identity);
    await freezeTemplate(client, identity, template.versionId, 1);
    const capture = await createCapture(client, identity, template.versionId);
    const definition = await loadDefinition(client, identity.organization_id, template.versionId);
    const loaded = await loadCapture(client, identity.organization_id, capture.instanceId);
    assert.equal(definition.model.version.status, 'frozen');
    assert.equal(loaded.instance.version_id, template.versionId);
    assert.equal(loaded.occurrences.length, 3);
  }, { csrfToken: session.csrfToken });
  const laboratory = await createLaboratoryFixture(owner, account);
  await withSession(session.token, async (client, identity) => {
    const customer = await quickCreateCustomer(client, identity, { name: 'Synthetic fresh customer', legalName: 'Synthetic legal name', contactPersonName: 'Synthetic contact',
      contactPersonEmail: 'fresh@example.invalid', contactPersonPhone: '00000000', billToAddress: 'Synthetic billing\nSecond line', shipToAddress: 'Synthetic receiving' });
    const sample = await registerSample(client, identity, { ...laboratory.registration, sampleType: 'customer', customerId: customer.id, customerAddress: customer.addresses[0].text });
    const generated = await generateTestRequests(client, identity, sample.id);
    assert.equal(generated.items.length, 1);
    const allocated = await allocateTestRequest(client, identity, generated.items[0].id, { revision: 1, assignmentType: 'analyst', assignedUserId: account.userId });
    assert.ok(allocated.datasheetId); assert.equal(allocated.status, 'allocated');
    const loaded = await loadSample(client, identity, sample.id);
    assert.equal(loaded.customerName, customer.name); assert.equal(loaded.products[0].tests[0].requestStatus, 'allocated');
  }, { csrfToken: session.csrfToken });
  await mkdir('.local', { recursive: true, mode: 0o700 });
  await writeFile('.local/migration-verification.json', JSON.stringify({ databaseName, migrations: count, status: 'passed', verifiedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  console.log(`Fresh install and repeat application passed for ${count} migrations; authentication, template capture, registration and allocation passed with RLS. Synthetic database retained: ${databaseName}`);
} finally {
  await closePool();
  await owner?.end();
  await admin.end();
}
