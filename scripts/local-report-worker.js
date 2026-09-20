import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';

process.loadEnvFile('.env.local');
const ownerUrl = new URL(process.env.MIGRATION_DATABASE_URL);
if (ownerUrl.hostname !== '127.0.0.1' || ownerUrl.port !== '55442' || ownerUrl.pathname !== '/sampleify_local' || ownerUrl.username !== 'sampleify_owner') {
  throw new Error('Report worker setup only accepts the dedicated local synthetic database.');
}
const filename = '.env.worker.local';
const roleName = 'sampleify_report_worker';
const owner = new pg.Client({ connectionString: ownerUrl.href });
await owner.connect();
try {
  const { rows: [existing] } = await owner.query('SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname=$1', [roleName]);
  if (existing && (existing.rolsuper || existing.rolcreatedb || existing.rolcreaterole || existing.rolbypassrls)) throw new Error('Existing worker role has unexpected privileges; no role was changed.');
  let workerUrl;
  if (existsSync(filename)) {
    const value = readFileSync(filename, 'utf8').split('\n').find((line) => line.startsWith('WORKER_DATABASE_URL='))?.slice('WORKER_DATABASE_URL='.length);
    if (!value) throw new Error('The worker environment is missing its database URL.');
    workerUrl = new URL(value);
  } else {
    if (existing) throw new Error('The worker role already exists without local credentials; no credentials were changed.');
    workerUrl = new URL(ownerUrl.href); workerUrl.username = roleName; workerUrl.password = randomBytes(24).toString('hex');
    writeFileSync(filename, `WORKER_DATABASE_URL=${workerUrl.href}\n`, { mode: 0o600, flag: 'wx' });
  }
  if (workerUrl.hostname !== ownerUrl.hostname || workerUrl.port !== ownerUrl.port || workerUrl.pathname !== ownerUrl.pathname
    || workerUrl.username !== roleName || !/^[a-f0-9]{48}$/.test(workerUrl.password)) throw new Error('Worker credentials do not identify the dedicated local role.');
  if (!existing) {
    // Only generated hexadecimal passwords enter this role DDL.
    await owner.query(`CREATE ROLE sampleify_report_worker LOGIN PASSWORD '${workerUrl.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
  }
  const memberships = await owner.query('SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=$1)', [roleName]);
  if (memberships.rowCount) throw new Error('The worker role must not inherit application or owner roles.');
  await owner.query('GRANT CONNECT ON DATABASE sampleify_local TO sampleify_report_worker');
  const worker = new pg.Client({ connectionString: workerUrl.href });
  try { await worker.connect(); await worker.query('SELECT 1'); } finally { await worker.end(); }
  console.log('Dedicated report worker role is ready. Credentials remain in .env.worker.local.');
} finally { await owner.end(); }
