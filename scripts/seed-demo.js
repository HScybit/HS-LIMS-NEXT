import { signIn } from '../src/auth/service.js';
import { closePool } from '../src/db/pool.js';
import { SEED_ADMIN_USERNAME, SEED_ADMIN_PASSWORD } from './seed.js';
import { runDemoSeedProvisioning } from '../src/seed/run-demo-seed.js';

const session = await signIn({ identifier: SEED_ADMIN_USERNAME, password: SEED_ADMIN_PASSWORD });
try {
  await runDemoSeedProvisioning(session, { onStep: (label) => console.log(`✓ ${label}`) });
  console.log('\nSeed complete.');
} finally {
  await closePool();
}
