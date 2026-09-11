import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { organizations, users, credentials, memberships, roles, permissions, rolePermissions, membershipRoles } from '../src/db/schema.js';
import { hashPassword } from '../src/auth/passwords.js';

const url = new URL(process.env.MIGRATION_DATABASE_URL);
if (url.hostname !== '127.0.0.1' || url.port !== '55442' || url.pathname !== '/sampleify_local') {
  throw new Error('Synthetic seed only runs on the dedicated local database.');
}
const client = new pg.Client({ connectionString: url.href });
try {
  await client.connect();
  const db = drizzle(client);
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.username, 'analyst.demo'));
  if (existing.length) {
    console.log('Synthetic analyst already exists; no credentials or records were overwritten.');
  } else {
    const password = `Demo-${randomBytes(12).toString('base64url')}!`;
    const passwordHash = await hashPassword(password);
    await db.transaction(async (tx) => {
      const [organization] = await tx.insert(organizations).values({ code: 'SYNTHETIC-LAB', name: 'Sampleify Demonstration Laboratory' }).returning();
      const [user] = await tx.insert(users).values({ username: 'analyst.demo', email: 'analyst@example.invalid', displayName: 'Demo Analyst' }).returning();
      await tx.insert(credentials).values({ userId: user.id, passwordHash });
      await tx.insert(memberships).values({ userId: user.id, organizationId: organization.id, isDefault: true });
      const [role] = await tx.insert(roles).values({ organizationId: organization.id, name: 'Laboratory Administrator' }).returning();
      await tx.insert(membershipRoles).values({ userId: user.id, organizationId: organization.id, roleId: role.id });
      for (const [code, description] of [
        ['templates.read', 'Read templates'], ['templates.manage', 'Manage templates'],
        ['samples.read', 'Read samples'], ['samples.manage', 'Manage samples'],
        ['datasheets.execute', 'Enter datasheet results'],
      ]) {
        await tx.insert(permissions).values({ code, description }).onConflictDoNothing();
        await tx.insert(rolePermissions).values({ organizationId: organization.id, roleId: role.id, permissionCode: code });
      }
    });
    await mkdir('.local', { recursive: true, mode: 0o700 });
    await writeFile('.local/demo-credentials.txt', `Username: analyst.demo\nPassword: ${password}\n`, { mode: 0o600, flag: 'wx' });
    console.log('Synthetic analyst created. Local sign-in credentials: .local/demo-credentials.txt');
  }
} finally { await client.end(); }
