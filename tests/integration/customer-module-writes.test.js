import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test, { before, after } from 'node:test';
import { ownerPool, createAccount } from '../helpers/database.js';
import { emptyModuleAccess, saveModuleAccessSettings } from '../helpers/module-access.js';
import { customerScopeCommands, seedCustomerScopeRows } from '../helpers/customer-write-scope.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { hashToken } from '../../src/auth/tokens.js';
import { getPool, closePool } from '../../src/db/pool.js';
import { saveLaboratorySettings } from '../../src/organization-settings/service.js';
import { updateUserProfile } from '../../src/users/profiles.js';
import { updateRole } from '../../src/roles/service.js';
import { sampleRegistrationOptions } from '../../src/samples/options.js';
import { quickCreateCustomer } from '../../src/samples/customer.js';
import { saveCustomer, retireCustomer } from '../../src/masters/customers.js';

let owner;
before(() => { owner = ownerPool(); });
after(async () => { await closePool(); await owner.end(); });
const work = (actor, action, readOnly = false) => withSession(actor.token, action, { readOnly });
const moduleDenied = { code: 'customer_module_access_required', status: 403 };
const isolationDenied = { code: '25001', constraint: 'module_access_write_isolation' };
async function account(options = {}) {
  const actor = await createAccount(owner, { permissions: ['masters.manage', 'samples.create', 'settings.manage', 'users.manage', 'roles.manage'], ...options });
  return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) };
}
async function fixture() {
  const manager = await account();
  const actor = await account({ organizationId: manager.organizationId, permissions: ['masters.manage', 'samples.create'] });
  const customerId = randomUUID(); const parentId = randomUUID(); const addressId = randomUUID(); const contactId = randomUUID();
  await owner.query("INSERT INTO customers(organization_id,id,code,name,legal_name) SELECT $1,id,id::text,'Synthetic customer','Synthetic legal name' FROM unnest($2::uuid[]) selected(id)", [actor.organizationId, [customerId, parentId]]);
  await owner.query("INSERT INTO customer_addresses(organization_id,id,customer_id,address_type,freeform_address,is_default) VALUES($1,$2,$3,'shipping','Synthetic address',true)", [actor.organizationId, addressId, parentId]);
  await owner.query("INSERT INTO customer_contacts(organization_id,id,customer_id,name,phone,is_primary) VALUES($1,$2,$3,'Synthetic contact','123',true)", [actor.organizationId, contactId, parentId]);
  const commands = [
    { name: 'customer insert', sql: "INSERT INTO customers(organization_id,id,code,name,legal_name) VALUES($1,$2::uuid,$2::text,'Synthetic insert','Synthetic legal name') RETURNING id", values: [actor.organizationId, randomUUID()] },
    { name: 'customer update', sql: "UPDATE customers SET name='Synthetic changed',revision=revision+1 WHERE organization_id=$1 AND id=$2 RETURNING id", values: [actor.organizationId, customerId] },
    { name: 'customer delete', sql: 'DELETE FROM customers WHERE organization_id=$1 AND id=$2 RETURNING id', values: [actor.organizationId, customerId] },
    { name: 'address insert', sql: "INSERT INTO customer_addresses(organization_id,id,customer_id,address_type,freeform_address) VALUES($1,$2,$3,'billing','Synthetic insert') RETURNING id", values: [actor.organizationId, randomUUID(), parentId] },
    { name: 'address update', sql: "UPDATE customer_addresses SET freeform_address='Synthetic changed' WHERE organization_id=$1 AND id=$2 RETURNING id", values: [actor.organizationId, addressId] },
    { name: 'address delete', sql: 'DELETE FROM customer_addresses WHERE organization_id=$1 AND id=$2 RETURNING id', values: [actor.organizationId, addressId] },
    { name: 'contact insert', sql: "INSERT INTO customer_contacts(organization_id,id,customer_id,name,phone) VALUES($1,$2,$3,'Synthetic insert','456') RETURNING id", values: [actor.organizationId, randomUUID(), parentId] },
    { name: 'contact update', sql: "UPDATE customer_contacts SET phone='456' WHERE organization_id=$1 AND id=$2 RETURNING id", values: [actor.organizationId, contactId] },
    { name: 'contact delete', sql: 'DELETE FROM customer_contacts WHERE organization_id=$1 AND id=$2 RETURNING id', values: [actor.organizationId, contactId] },
  ];
  const nativeCreate = { id: commands[0].values[1], requestId: randomUUID(), revision: 0, name: 'Synthetic native Customer', legalName: 'Synthetic legal name' };
  const nativeUpdate = { id: customerId, requestId: randomUUID(), revision: 1, name: 'Synthetic changed' };
  return { manager, actor, customerId, parentId, addressId, contactId, commands, nativeCreate, nativeUpdate };
}
async function configure(manager, actor, change = {}) {
  const modules = emptyModuleAccess(); Object.assign(modules[0], { enabled: true, userIds: [actor.userId] }, change);
  await saveModuleAccessSettings(manager, modules); return modules;
}
const execute = (actor, command) => work(actor, client => client.query(command.sql, command.values));
const save = (actor, input) => work(actor, (client, identity) => saveCustomer(client, identity, input));
const storedRows = async actor => Object.fromEntries(await Promise.all(['customers', 'customer_addresses', 'customer_contacts'].map(async table =>
  [table, (await owner.query(`SELECT * FROM ${table} WHERE organization_id=$1 ORDER BY id`, [actor.organizationId])).rows])));
async function recordProfile(manager, person, values = {}) {
  const lab = randomUUID();
  await owner.query("INSERT INTO laboratories(organization_id,id,code,name) VALUES($1,$2::uuid,$2::text,'Synthetic laboratory')", [person.organizationId, lab]);
  return work(manager, (client, identity) => updateUserProfile(client, identity, person.userId,
    { requestId: randomUUID(), revision: 0, defaultRoleId: person.roleId, laboratoryId: lab, ...values }));
}
async function waitForLock(pid, failure) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (failure()) throw failure();
    if (pid() && (await owner.query("SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1", [pid()])).rows[0]?.waiting) return;
    await delay(10);
  }
  assert.fail('Expected Customer writer to wait on a database lock');
}
const quickInput = () => ({ name: `Customer gate ${randomUUID()}`, legalName: 'Synthetic legal name', contactPersonName: 'Synthetic contact',
  contactPersonEmail: 'synthetic@example.invalid', contactPersonPhone: '123', billToAddress: 'Synthetic billing', shipToAddress: 'Synthetic shipping' });

test('raw Customer writes and unconfigured native commands reject without changing rows', async () => {
  const { manager, actor, commands, nativeCreate, nativeUpdate } = await fixture(); const original = await storedRows(actor);
  for (const state of ['absent', 'disabled', 'empty']) {
    if (state === 'disabled') await configure(manager, actor, { enabled: false });
    if (state === 'empty') await configure(manager, actor, { userIds: [] });
    for (const command of commands) await assert.rejects(execute(actor, command), { code: '42501' }, `${state}: ${command.name}`);
    for (const input of [nativeCreate, nativeUpdate]) await assert.rejects(save(actor, input), moduleDenied);
    await assert.rejects(work(actor, (client, identity) => retireCustomer(client, identity,
      { id: nativeUpdate.id, requestId: randomUUID(), revision: 1 })), moduleDenied);
    assert.deepEqual(await storedRows(actor), original);
  }
});

test('configured grants authorize native Customer and relationship commands with stable identity and revisions', async () => {
  const { manager, actor, customerId, parentId, addressId, contactId, commands, nativeCreate, nativeUpdate } = await fixture(); await configure(manager, actor);
  for (const command of commands) await assert.rejects(execute(actor, command), { code: '42501' }, command.name);
  assert.equal((await save(actor, nativeCreate)).revision, 1);
  assert.equal((await save(actor, nativeUpdate)).revision, 2);
  await assert.rejects(save(actor, { ...nativeUpdate, requestId: randomUUID() }), { code: 'stale_customer' });
  const parent = await save(actor, { id: parentId, requestId: randomUUID(), revision: 1, shipToAddress: 'Changed address', contactPersonPhone: '456' });
  assert.equal(parent.addresses[0].id, addressId); assert.equal(parent.contacts[0].id, contactId);
  await work(actor, (client, identity) => retireCustomer(client, identity, { id: customerId, requestId: randomUUID(), revision: 2 }));
  const rows = await storedRows(actor);
  assert.equal(rows.customers.length, 3); assert(rows.customers.some(row => row.id === nativeCreate.id));
  assert.equal(rows.customers.find(row => row.id === customerId).retired, true);
  assert.equal(rows.customer_addresses[0].freeform_address, 'Changed address'); assert.equal(rows.customer_contacts[0].phone, '456');
});

test('Customer Default Role grants use the recorded profile and do not grant master-write permission or foreign access', async () => {
  const { manager, actor, commands, nativeCreate, nativeUpdate } = await fixture();
  await configure(manager, actor, { userIds: [], roleIds: [actor.roleId] });
  await assert.rejects(save(actor, nativeCreate), moduleDenied);
  await recordProfile(manager, actor, { roleIds: [actor.roleId, manager.roleId] });
  assert.equal((await save(actor, nativeCreate)).revision, 1);
  await configure(manager, actor, { userIds: [], roleIds: [manager.roleId] });
  await assert.rejects(save(actor, { ...nativeCreate, id: randomUUID(), requestId: randomUUID() }), moduleDenied);
  await configure(manager, actor);
  const foreign = await account();
  await configure(foreign, foreign);
  await assert.rejects(execute(actor, { ...commands[0], values: [foreign.organizationId, randomUUID()] }), { code: '42501' });
  await assert.rejects(save(foreign, nativeUpdate), { code: 'customer_not_found' });
  const registrar = await account({ organizationId: actor.organizationId, permissions: ['samples.create'] });
  await configure(manager, registrar);
  await assert.rejects(execute(registrar, { ...commands[0], values: [actor.organizationId, randomUUID()] }), { code: '42501' });
  await assert.rejects(save(registrar, nativeCreate), { code: 'forbidden' });
});

test('sample reference projections and the configured create-only quick command survive the module policies', async () => {
  const { manager, actor, parentId, commands } = await fixture();
  const registrar = await account({ organizationId: actor.organizationId, permissions: ['samples.create'] });
  const reader = await account({ organizationId: actor.organizationId, permissions: ['samples.read'] });
  const options = await work(registrar, sampleRegistrationOptions, true);
  assert(options.customers.some(row => row.id === parentId)); assert.equal(options.canQuickCreateCustomer, false);
  for (const table of ['customers', 'customer_addresses', 'customer_contacts']) {
    assert.equal((await work(reader, client => client.query(`SELECT id FROM ${table} WHERE organization_id=$1`, [actor.organizationId]), true)).rowCount, 0);
  }
  for (const view of ['laboratory_customer_references', 'laboratory_customer_address_references']) {
    assert((await work(reader, client => client.query(`SELECT id FROM ${view} WHERE organization_id=$1`, [actor.organizationId]), true)).rowCount > 0);
  }
  await configure(manager, registrar);
  const saved = await work(registrar, (client, identity) => quickCreateCustomer(client, identity, quickInput()));
  assert.equal(saved.addresses.length, 2);
  await assert.rejects(execute(registrar, { ...commands[0], values: [actor.organizationId, randomUUID()] }), { code: '42501' });
  await saveModuleAccessSettings(manager, emptyModuleAccess());
  await assert.rejects(work(registrar, (client, identity) => quickCreateCustomer(client, identity, quickInput())), { status: 403 });
  assert((await work(registrar, sampleRegistrationOptions, true)).customers.some(row => row.id === saved.id));
});

test('Customer commands recheck committed settings, role and Default Role revocations after native writer locks', { timeout: 30000 }, async () => {
  for (const kind of ['settings', 'role', 'profile']) {
    const { manager, actor, nativeCreate } = await fixture();
    await recordProfile(manager, actor, kind === 'profile' ? { roleIds: [actor.roleId, manager.roleId] } : {});
    await configure(manager, actor, { userIds: [], roleIds: [actor.roleId] });
    let release; const gate = new Promise(resolve => { release = resolve; }); let ready; const entered = new Promise(resolve => { ready = resolve; }); let editorFailure;
    const editing = work(manager, async (client, identity) => {
      if (kind === 'settings') await saveLaboratorySettings(client, identity, { revision: 1, autoCreateJobs: false, moduleAccess: emptyModuleAccess() });
      if (kind === 'role') await updateRole(client, identity, { id: actor.roleId, requestId: randomUUID(), revision: 0, name: `Reader ${actor.roleId}`, permissionCodes: [] });
      if (kind === 'profile') await updateUserProfile(client, identity, actor.userId, { requestId: randomUUID(), revision: 1, defaultRoleId: manager.roleId });
      ready(); await gate;
    });
    void editing.catch(error => { editorFailure = error; }); let pending; let failure; let pid;
    try {
      await Promise.race([entered, editing.then(() => { throw new Error('Native writer did not reach the transaction gate'); })]);
      pending = work(actor, async (client, identity) => { pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid; return saveCustomer(client, identity, nativeCreate); });
      void pending.catch(error => { failure = error; }); await waitForLock(() => pid, () => failure ?? editorFailure); release(); await editing;
      await assert.rejects(pending, { status: 403 });
      assert.equal((await owner.query('SELECT id FROM customers WHERE organization_id=$1 AND id=$2', [actor.organizationId, nativeCreate.id])).rowCount, 0);
    } finally { release(); await editing.catch(() => {}); if (pending) await pending.catch(() => {}); }
  }
});

test('Customer commands recheck session, membership, user, organization, credential and expiry changes after waiting', { timeout: 30000 }, async () => {
  for (const kind of ['session', 'membership', 'user', 'organization', 'credential', 'expiry']) {
    const { manager, actor, nativeUpdate } = await fixture(); await configure(manager, actor); const original = await storedRows(actor);
    const blocker = await owner.connect(); let pending; let failure; let pid;
    try {
      await blocker.query('BEGIN'); await blocker.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [actor.userId]);
      if (kind === 'expiry') await blocker.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '700 milliseconds' WHERE user_id=$1", [actor.userId]);
      pending = work(actor, async (client, identity) => { pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid; return saveCustomer(client, identity, nativeUpdate); });
      void pending.catch(error => { failure = error; }); await waitForLock(() => pid, () => failure);
      if (kind === 'session') await blocker.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [actor.userId]);
      if (kind === 'membership') await blocker.query('UPDATE memberships SET active=false WHERE organization_id=$1 AND user_id=$2', [actor.organizationId, actor.userId]);
      if (kind === 'user') await blocker.query('UPDATE users SET must_change_password=true WHERE id=$1', [actor.userId]);
      if (kind === 'organization') await blocker.query('UPDATE organizations SET active=false WHERE id=$1', [actor.organizationId]);
      if (kind === 'credential') await blocker.query('UPDATE credentials SET revision=revision+1 WHERE user_id=$1', [actor.userId]);
      if (kind === 'expiry') await delay(750);
      await blocker.query('COMMIT'); await assert.rejects(pending, { status: 403 }); assert.deepEqual(await storedRows(actor), original);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); if (pending) await pending.catch(() => {}); }
  }
});

test('module writes reject old transaction snapshots while statement snapshots observe revocation', async () => {
  const { manager, actor, nativeCreate, nativeUpdate } = await fixture();
  for (const isolation of ['READ COMMITTED', 'READ UNCOMMITTED', 'REPEATABLE READ', 'SERIALIZABLE']) {
    await configure(manager, actor);
    const client = await getPool().connect();
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      const identity = (await client.query('SELECT * FROM auth_session_context($1)', [hashToken(actor.token)])).rows[0]; assert(identity);
      assert.equal((await client.query("SELECT organization_has_module_access('customer') AS allowed")).rows[0].allowed, true);
      if (['READ COMMITTED', 'READ UNCOMMITTED'].includes(isolation)) {
        await saveModuleAccessSettings(manager, emptyModuleAccess());
        await assert.rejects(saveCustomer(client, identity, nativeCreate), moduleDenied);
      } else {
        for (const input of [nativeCreate, nativeUpdate]) {
          await client.query('SAVEPOINT isolation_probe'); await assert.rejects(saveCustomer(client, identity, input), { code: 'customer_write_isolation' });
          await client.query('ROLLBACK TO SAVEPOINT isolation_probe'); await client.query('RELEASE SAVEPOINT isolation_probe');
        }
        await saveModuleAccessSettings(manager, emptyModuleAccess());
        await assert.rejects(quickCreateCustomer(client, identity, quickInput()), isolationDenied);
      }
    } finally { await client.query('ROLLBACK'); client.release(); }
  }
  assert.equal((await owner.query('SELECT id FROM customers WHERE organization_id=$1 AND id=$2', [actor.organizationId, nativeCreate.id])).rowCount, 0);
});

test('Customer write policies remain restrictive and the write helper rejects forged session scope and worker access', async () => {
  const { manager, actor, commands } = await fixture(); await configure(manager, actor); const foreign = await account();
  const policies = (await owner.query("SELECT tablename,permissive,cmd FROM pg_policies WHERE policyname LIKE 'customer_module_%' AND cmd<>'SELECT' ORDER BY tablename,cmd")).rows;
  assert.equal(policies.length, 9); assert(policies.every(row => row.permissive === 'RESTRICTIVE'));
  for (const table of ['customers', 'customer_addresses', 'customer_contacts']) assert.deepEqual(policies.filter(row => row.tablename === table).map(row => row.cmd).sort(), ['DELETE', 'INSERT', 'UPDATE']);
  const privileges = (await owner.query("SELECT has_function_privilege('sampleify_report_worker','masters_require_customer_write()','EXECUTE') AS worker,EXISTS(SELECT 1 FROM pg_proc routine,LATERAL aclexplode(routine.proacl) acl WHERE routine.oid='masters_require_customer_write()'::regprocedure AND acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public")).rows[0];
  assert.deepEqual(privileges, { worker: false, public: false });
  for (const [key, value] of [['app.user_id', foreign.userId], ['app.organization_id', foreign.organizationId], ['app.session_id', randomUUID()]]) {
    await assert.rejects(work(actor, async client => { await client.query('SELECT set_config($1,$2,true)', [key, value]); return client.query(commands[0].sql, commands[0].values); }), { code: '42501' });
    await assert.rejects(work(actor, async client => { await client.query('SELECT set_config($1,$2,true)', [key, value]); return client.query('SELECT masters_require_customer_write()'); }), { code: '42501' });
  }
});

test('Customer commands remain bound to the session organization and raw multirow writes cannot bypass them', async () => {
  const actor = await account(); await configure(actor, actor);
  const foreign = await account();
  const own = await seedCustomerScopeRows(owner, actor.organizationId);
  const sameTenant = await seedCustomerScopeRows(owner, actor.organizationId);
  const otherTenant = await seedCustomerScopeRows(owner, foreign.organizationId);
  const before = { own: await storedRows(actor), foreign: await storedRows(foreign) };
  const rollback = new Error('Roll back multirow Customer write probe');
  for (const command of customerScopeCommands(own, sameTenant)) {
    await assert.rejects(execute(actor, command), { code: '42501' });
  }
  await assert.rejects(work(actor, async client => {
    const result = await client.query("SELECT masters_retire_customer(id,1,gen_random_uuid(),repeat('a',64)) AS revision FROM unnest($1::uuid[]) selected(id)", [[own.customerId, sameTenant.customerId]]);
    assert.deepEqual(result.rows, [{ revision: 2 }, { revision: 2 }]); throw rollback;
  }), error => error === rollback);
  for (const accessPath of ['automatic', 'sequential']) {
    for (const command of customerScopeCommands(own, otherTenant)) {
      const attempt = () => work(actor, async client => {
        if (accessPath === 'sequential') await client.query('SET LOCAL enable_indexscan=off; SET LOCAL enable_bitmapscan=off');
        return client.query(command.sql, command.values);
      });
      await assert.rejects(attempt, { code: '42501' }, `${accessPath}: ${command.name}`);
      assert.deepEqual(await storedRows(actor), before.own, command.name);
      assert.deepEqual(await storedRows(foreign), before.foreign, command.name);
    }
  }
  await assert.rejects(work(actor, client => client.query(`SELECT masters_retire_customer(
    CASE WHEN position=1 THEN $1::uuid WHEN set_config('app.organization_id',$3,true)=$3 THEN $2::uuid END,
    1,gen_random_uuid(),repeat('a',64)) FROM generate_series(1,2) selected(position)`, [own.customerId, otherTenant.customerId, foreign.organizationId])), { code: '42501' });
  assert.deepEqual(await storedRows(actor), before.own); assert.deepEqual(await storedRows(foreign), before.foreign);
});
