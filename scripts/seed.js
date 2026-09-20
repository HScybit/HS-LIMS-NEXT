import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { organizations, users, credentials, memberships, roles, permissions, rolePermissions, membershipRoles } from '../src/db/schema.js';
import { roleCapabilities } from '../src/db/role-history-schema.js';
import { hashPassword } from '../src/auth/passwords.js';
import { roleCapabilityKeys } from '../src/roles/capabilities.js';
import { PERMISSION_CATALOG } from '../src/auth/permission-catalog.js';

const url = new URL(process.env.MIGRATION_DATABASE_URL);
if (url.hostname !== '127.0.0.1' || url.port !== '55442' || url.pathname !== '/sampleify_local') {
  throw new Error('Synthetic seed only runs on the dedicated local database.');
}

export const SEED_ORGANIZATION_CODE = 'SAMPLEIFY';
export const SEED_ADMIN_USERNAME = 'admin';
export const SEED_ADMIN_EMAIL = 'admin@sampleify.local';
export const SEED_ADMIN_PASSWORD = '1linkwok@';

async function run() {
  const client = new pg.Client({ connectionString: url.href });
  await client.connect();
  try {
    const db = drizzle(client);
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.username, SEED_ADMIN_USERNAME));
    if (existing.length) {
      console.log(`Superuser "${SEED_ADMIN_USERNAME}" already exists; no credentials or records were overwritten.`);
      return;
    }
    const passwordHash = await hashPassword(SEED_ADMIN_PASSWORD);
    await db.transaction(async (tx) => {
      const [org] = await tx.insert(organizations).values({ code: SEED_ORGANIZATION_CODE, name: 'Sampleify Laboratory' }).returning();
      const [user] = await tx.insert(users)
        .values({ username: SEED_ADMIN_USERNAME, email: SEED_ADMIN_EMAIL, displayName: 'System Administrator' })
        .returning();
      await tx.insert(credentials).values({ userId: user.id, passwordHash });
      await tx.insert(memberships).values({ userId: user.id, organizationId: org.id, isDefault: true });
      const [role] = await tx.insert(roles)
        .values({ organizationId: org.id, name: 'System Administrator', description: 'Full organization administration.', protected: true })
        .returning();
      await tx.insert(membershipRoles).values({ userId: user.id, organizationId: org.id, roleId: role.id });
      for (const key of roleCapabilityKeys) {
        await tx.insert(roleCapabilities).values({ organizationId: org.id, roleId: role.id, capabilityKey: key });
      }
      for (const [code, description] of PERMISSION_CATALOG) {
        await tx.insert(permissions).values({ code, description }).onConflictDoNothing();
        await tx.insert(rolePermissions).values({ organizationId: org.id, roleId: role.id, permissionCode: code });
      }
    });
    console.log(`Superuser created. Organization: ${SEED_ORGANIZATION_CODE}. Username: ${SEED_ADMIN_USERNAME}. Password: ${SEED_ADMIN_PASSWORD}`);
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await run();
export { run as seedSuperuser };
