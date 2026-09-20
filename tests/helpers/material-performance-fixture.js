import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAccount } from './database.js';
import { emptyModuleAccess, saveModuleAccessSettings } from './module-access.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { saveMaterial } from '../../src/materials/service.js';

// Both service and Chrome measurements use the same explicitly synthetic distribution.
export async function materialPerformanceFixture(owner, materials, transactions) {
  assert.match(process.env.SAMPLEIFY_TEST_DATABASE_NAME ?? '', /^sampleify_verify_[a-f0-9]{32}$/);
  assert([100, 1000].includes(materials)); assert.equal(transactions, materials * 10);
  const account = await createAccount(owner, { permissions: ['masters.manage', 'settings.manage'] });
  Object.assign(account, await signIn({ identifier: account.username, password: account.password }));
  await saveModuleAccessSettings(account, emptyModuleAccess().map(module => module.moduleKey === 'inventory' ? { ...module, enabled: true, userIds: [account.userId] } : module));
  const work = action => withSession(account.token, action, { csrfToken: account.csrfToken });
  const category = (await owner.query("INSERT INTO material_categories(organization_id,name) VALUES($1,'Synthetic stock category') RETURNING id", [account.organizationId])).rows[0];
  const unit = (await owner.query("INSERT INTO measurement_units(organization_id,code,name,symbol) VALUES($1,'BENCH_G','Grams','g') RETURNING id", [account.organizationId])).rows[0];
  const input = { id: randomUUID(), requestId: randomUUID(), revision: 0, name: 'Synthetic material editable', code: 'BENCH_EDIT',
    description: 'Synthetic '.repeat(16), categoryId: category.id, measurementUnitId: unit.id, initialQuantity: '0', minimumQuantity: '0' };
  const material = await work((client, identity) => saveMaterial(client, identity, input));
  await owner.query(`INSERT INTO materials(organization_id,name,code,description,category_id,measurement_unit_id,created_by,updated_by)
    SELECT $1,'Synthetic material '||lpad(n::text,5,'0'),'BENCH_'||n,$2,$3,$4,$5,$5 FROM generate_series(1,$6::integer) n`,
  [account.organizationId, input.description, category.id, unit.id, account.userId, materials - 1]);
  await owner.query(`INSERT INTO material_transactions(organization_id,material_id,request_id,transaction_type,quantity,cost,supplier,batch_serial_number,
      measurement_unit_id,unit_name,unit_symbol,category_expirable,created_by,created_at)
    SELECT $1,$2,gen_random_uuid(),'in',10,0,'Synthetic supplier','Batch '||lpad(n::text,5,'0'),$3,'Grams','g',false,$4,
      TIMESTAMPTZ '2026-01-01T00:00:00Z'+n*interval '1 second' FROM generate_series(1,$5::integer) n`,
  [account.organizationId, material.id, unit.id, account.userId, transactions]);
  for (const table of ['materials', 'material_versions', 'material_transactions', 'material_categories']) await owner.query(`ANALYZE ${table}`);
  return { account, input, material, work };
}
