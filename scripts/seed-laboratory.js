import pg from 'pg';
import { createLaboratoryFixture } from '../tests/helpers/laboratory.js';

// Reuse the same explicitly synthetic scientific/workflow fixture exercised by
// integration and browser tests. This command never accepts an arbitrary user,
// organization or remote database, and never replaces credentials or records.
const url = new URL(process.env.MIGRATION_DATABASE_URL);
if (url.hostname !== '127.0.0.1' || url.port !== '55442' || url.pathname !== '/sampleify_local' || url.username !== 'sampleify_owner') {
  throw new Error('Laboratory seed requires the dedicated local synthetic database owner.');
}
const categoryCode = 'SYNTHETIC-DEMO-WATER'; const customerCode = 'SYNTHETIC-DEMO-CUSTOMER';
const owner = new pg.Pool({ connectionString: url.href, max: 2 });
const client = await owner.connect();
try {
  await client.query('BEGIN');
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('sampleify-demo-laboratory', 0))");
  const matches = await client.query(`SELECT person.id AS "userId", organization.id AS "organizationId", role.id AS "roleId"
    FROM users person JOIN memberships membership ON membership.user_id=person.id AND membership.active
    JOIN organizations organization ON organization.id=membership.organization_id
    JOIN membership_roles assigned ON assigned.organization_id=organization.id AND assigned.user_id=person.id
    JOIN roles role ON role.organization_id=assigned.organization_id AND role.id=assigned.role_id
    WHERE person.username='analyst.demo' AND person.email='analyst@example.invalid' AND person.active
      AND organization.code='SYNTHETIC-LAB' AND organization.active AND role.name='Laboratory Administrator'`);
  if (matches.rowCount !== 1) throw new Error('Run db:seed first; the expected synthetic analyst, laboratory and administrator role are required.');
  const account = matches.rows[0];
  const existing = await client.query('SELECT id FROM sample_categories WHERE organization_id=$1 AND code=$2', [account.organizationId, categoryCode]);
  if (!existing.rowCount) await createLaboratoryFixture(owner, account, { categoryCode, customerCode });
  const customer = await client.query('SELECT id FROM customers WHERE organization_id=$1 AND code=$2', [account.organizationId, customerCode]);
  if (customer.rowCount !== 1) throw new Error('The existing synthetic laboratory fixture is incomplete; no existing record was replaced.');
  await client.query(`INSERT INTO customer_addresses(organization_id, customer_id, address_type, freeform_address, is_default)
    SELECT $1, $2, 'billing', 'Synthetic demonstration address', true
    WHERE NOT EXISTS (SELECT 1 FROM customer_addresses WHERE organization_id=$1 AND customer_id=$2 AND address_type='billing')`, [account.organizationId, customer.rows[0].id]);
  for (const permission of ['templates.read', 'templates.manage', 'samples.read', 'samples.create', 'samples.manage', 'test_requests.allocate', 'datasheets.execute']) {
    await client.query('INSERT INTO permissions(code, description) VALUES($1, $1) ON CONFLICT DO NOTHING', [permission]);
    await client.query('INSERT INTO role_permissions(organization_id, role_id, permission_code) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [account.organizationId, account.roleId, permission]);
  }
  await client.query('COMMIT');
  console.log(`Synthetic laboratory ${existing.rowCount ? 'reused' : 'created'}; demonstration registration and allocation permissions are available. Existing passwords and laboratory records were preserved.`);
} catch (error) { await client.query('ROLLBACK'); throw error; }
finally { client.release(); await owner.end(); }
