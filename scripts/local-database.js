import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

const containerName = 'sampleify-next-local-postgres';
const volumeName = 'sampleify-next-local-postgres18';
const label = 'sampleify.workspace=HS-LIMS-NEXT';
const docker = (args, options = {}) => execFileSync('docker', args, { encoding: 'utf8', ...options });

mkdirSync('.local', { recursive: true, mode: 0o700 });
if (!existsSync('.env.local')) {
  const ownerPassword = randomBytes(24).toString('hex');
  const appPassword = randomBytes(24).toString('hex');
  writeFileSync('.env.local', [
    `DATABASE_URL=postgresql://sampleify_app:${appPassword}@127.0.0.1:55442/sampleify_local`,
    `MIGRATION_DATABASE_URL=postgresql://sampleify_owner:${ownerPassword}@127.0.0.1:55442/sampleify_local`,
    'APP_ORIGIN=http://127.0.0.1:3000',
    `MFA_ENCRYPTION_KEY=${randomBytes(32).toString('hex')}`,
    'MAIL_TRANSPORT=local',
    '',
  ].join('\n'), { mode: 0o600, flag: 'wx' });
}
process.loadEnvFile('.env.local');
const owner = new URL(process.env.MIGRATION_DATABASE_URL);
const app = new URL(process.env.DATABASE_URL);
if (owner.hostname !== '127.0.0.1' || owner.port !== '55442' || owner.pathname !== '/sampleify_local' ||
    owner.username !== 'sampleify_owner' || app.hostname !== owner.hostname || app.port !== owner.port ||
    app.pathname !== owner.pathname || app.username !== 'sampleify_app') {
  throw new Error('Local setup only accepts its dedicated loopback database and roles.');
}
if (!/^[a-f0-9]{48}$/.test(app.password) || !/^[a-f0-9]{48}$/.test(owner.password)) {
  throw new Error('Local setup expects its generated credentials; it will not change an existing database password.');
}
const existing = docker(['ps', '-a', '--filter', `name=^/${containerName}$`, '--format', '{{.Names}}']).trim();
if (existing) {
  const metadata = JSON.parse(docker(['inspect', containerName]))[0];
  if (metadata.Config.Labels?.['sampleify.workspace'] !== 'HS-LIMS-NEXT' ||
      !metadata.Mounts.some((mount) => mount.Name === volumeName)) {
    throw new Error('Container name is already used by an unrelated resource.');
  }
  docker(['start', containerName]);
} else {
  // Never attach an orphaned volume with unknown credentials or provenance.
  const volumes = docker(['volume', 'ls', '--format', '{{.Name}}']).trim().split('\n');
  if (volumes.includes(volumeName)) throw new Error('Existing unattached volume requires inspection; no data was changed.');
  writeFileSync('.local/postgres.env', `POSTGRES_USER=sampleify_owner\nPOSTGRES_PASSWORD=${owner.password}\nPOSTGRES_DB=sampleify_local\n`, { mode: 0o600 });
  docker(['run', '-d', '--name', containerName, '--label', label, '--env-file', '.local/postgres.env',
    '-p', '127.0.0.1:55442:5432', '-v', `${volumeName}:/var/lib/postgresql`, 'postgres:18.6'], { stdio: ['ignore', 'pipe', 'inherit'] });
}
let ready = false;
for (let attempt = 0; attempt < 30; attempt += 1) {
  try {
    docker(['exec', containerName, 'psql', '-h', '127.0.0.1', '-U', 'sampleify_owner', '-d', 'sampleify_local', '-v', 'ON_ERROR_STOP=1', '-c', 'SELECT 1'], { stdio: 'pipe' });
    ready = true;
    break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
if (!ready) throw new Error('Dedicated PostgreSQL container did not become ready.');
const roleSql = `DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'sampleify_app') THEN
    CREATE ROLE sampleify_app LOGIN PASSWORD '${app.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE sampleify_local TO sampleify_app;`;
docker(['exec', '-i', containerName, 'psql', '-U', 'sampleify_owner', '-d', 'sampleify_local', '-v', 'ON_ERROR_STOP=1'], { input: roleSql });
// Validate both credentials; do not print connection strings.
const { default: pg } = await import('pg');
for (const connectionString of [owner.href, app.href]) {
  const client = new pg.Client({ connectionString });
  try { await client.connect(); await client.query('SELECT 1'); } finally { await client.end(); }
}
console.log('Dedicated PostgreSQL is ready on 127.0.0.1:55442. Run db:migrate, then db:seed.');
