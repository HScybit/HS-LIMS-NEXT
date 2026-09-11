import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { hashPassword } from '../../src/auth/passwords.js';

export function ownerPool() {
  const url = new URL(process.env.MIGRATION_DATABASE_URL);
  if (url.hostname !== '127.0.0.1' || url.port !== '55442' || url.pathname !== '/sampleify_local') {
    throw new Error('Integration fixtures require the dedicated local synthetic database.');
  }
  return new pg.Pool({ connectionString: url.href, max: 4 });
}

export async function createAccount(owner, options = {}) {
  const userId = randomUUID();
  const organizationId = options.organizationId ?? randomUUID();
  const roleId = randomUUID();
  const username = `test-${userId}`;
  const email = options.email ?? `${username}@example.invalid`;
  const password = 'Synthetic-Password-For-Tests!';
  const hash = await hashPassword(password);
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO organizations(id, code, name) VALUES($1, $2, $3) ON CONFLICT DO NOTHING', [organizationId, `test-${organizationId}`, 'Synthetic Test Laboratory']);
    await client.query('INSERT INTO users(id, username, email, display_name, must_change_password) VALUES($1, $2, $3, $4, $5)', [userId, username, email, 'Synthetic Analyst', options.mustChangePassword ?? false]);
    await client.query('INSERT INTO credentials(user_id, password_hash) VALUES($1, $2)', [userId, hash]);
    await client.query('INSERT INTO memberships(organization_id, user_id, is_default) VALUES($1, $2, $3)', [organizationId, userId, options.isDefault ?? true]);
    await client.query('INSERT INTO roles(organization_id, id, name) VALUES($1, $2, $3)', [organizationId, roleId, `Reader ${roleId}`]);
    await client.query('INSERT INTO membership_roles(organization_id, user_id, role_id) VALUES($1, $2, $3)', [organizationId, userId, roleId]);
    for (const permission of options.permissions ?? ['templates.read']) {
      await client.query('INSERT INTO permissions(code, description) VALUES($1, $1) ON CONFLICT DO NOTHING', [permission]);
      await client.query('INSERT INTO role_permissions(organization_id, role_id, permission_code) VALUES($1, $2, $3)', [organizationId, roleId, permission]);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  return { userId, organizationId, roleId, username, email, password };
}
