import pg from 'pg';

// Granting platform-administrator status is deliberately not exposed through any
// application API (platform_administrators/auth_is_platform_administrator() come
// from drizzle/0133_user_account_administration.sql). Run this once, against the
// owner connection, for each user who should be able to create and list
// organizations across the whole deployment: node scripts/grant-platform-admin.js <username>
const url = new URL(process.env.MIGRATION_DATABASE_URL);
const username = process.argv[2]?.trim();
if (!username) throw new Error('Usage: node scripts/grant-platform-admin.js <username>');

const client = new pg.Client({ connectionString: url.href });
await client.connect();
try {
  const result = await client.query(
    `SELECT membership.organization_id, membership.user_id, organization.code
     FROM users person
     JOIN memberships membership ON membership.user_id=person.id AND membership.active
     JOIN organizations organization ON organization.id=membership.organization_id
     WHERE lower(person.username)=lower($1) AND person.active`,
    [username],
  );
  if (!result.rowCount) throw new Error(`An active user with username "${username}" was not found.`);
  const { organization_id: organizationId, user_id: userId, code } = result.rows[0];
  await client.query(
    `INSERT INTO platform_administrators(organization_id,user_id,granted_at,granted_by) VALUES($1,$2,clock_timestamp(),$3)
     ON CONFLICT(organization_id,user_id) DO NOTHING`,
    [organizationId, userId, 'scripts/grant-platform-admin.js'],
  );
  console.log(`Platform administrator access granted to "${username}" (home organization: ${code}).`);
} finally {
  await client.end();
}
