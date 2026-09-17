import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import { ownerPool, createAccount } from '../helpers/database.js';
import { emptyModuleAccess, saveModuleAccessSettings } from '../helpers/module-access.js';
import { seedCustomerScopeRows } from '../helpers/customer-write-scope.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { sampleRegistrationOptions } from '../../src/samples/options.js';
import { quickCreateCustomer } from '../../src/samples/customer.js';
import { registerSample } from '../../src/samples/register.js';
import { updateUserProfile } from '../../src/users/profiles.js';

let owner;
before(() => { owner = ownerPool(); });
after(async () => { await closePool(); await owner.end(); });
const fullTables = ['customers', 'customer_addresses', 'customer_contacts'];
const referenceViews = ['laboratory_customer_references', 'laboratory_customer_address_references'];
const work = (actor, action, readOnly = true) => withSession(actor.token, action, { readOnly });
async function account(options) {
  const actor = await createAccount(owner, options);
  return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) };
}
async function fixture() {
  const manager = await account({ permissions: ['masters.manage', 'settings.manage', 'users.manage'] });
  const own = await seedCustomerScopeRows(owner, manager.organizationId);
  const foreign = await account({ permissions: ['masters.manage'] });
  await seedCustomerScopeRows(owner, foreign.organizationId);
  return { manager, own, foreign };
}
async function configure(manager, selections = {}, enabled = true) {
  const modules = emptyModuleAccess(); Object.assign(modules[0], { enabled, ...selections });
  await saveModuleAccessSettings(manager, modules);
}
async function counts(actor, tables = fullTables) {
  return work(actor, async client => {
    const values = [];
    for (const table of tables) values.push((await client.query(`SELECT count(*)::integer AS n FROM ${table}`)).rows[0].n);
    return values;
  });
}

test('full Customer reads require enabled configured access plus a master permission', async () => {
  const { manager } = await fixture();
  const reader = await account({ organizationId: manager.organizationId, permissions: ['masters.read'] });
  const registrar = await account({ organizationId: manager.organizationId, permissions: ['samples.create'] });
  const unrelated = await account({ organizationId: manager.organizationId, permissions: ['templates.read'] });
  for (const actor of [manager, reader, registrar, unrelated]) assert.deepEqual(await counts(actor), [0, 0, 0]);
  assert.deepEqual(await counts(manager, referenceViews), [0, 0]);
  await configure(manager, { userIds: [manager.userId, reader.userId, registrar.userId, unrelated.userId] }, false);
  assert.deepEqual(await counts(manager), [0, 0, 0]);
  await configure(manager);
  assert.deepEqual(await counts(reader), [0, 0, 0]);
  await configure(manager, { userIds: [manager.userId, reader.userId, registrar.userId, unrelated.userId] });
  for (const actor of [manager, reader]) assert.deepEqual(await counts(actor), [2, 1, 1]);
  for (const actor of [registrar, unrelated]) assert.deepEqual(await counts(actor), [0, 0, 0]);
  assert.deepEqual(await counts(unrelated, referenceViews), [0, 0]);
  await configure(manager, { userIds: [manager.userId] });
  assert.deepEqual(await counts(reader), [0, 0, 0]);
});

test('Customer role access follows the active recorded Default Role', async () => {
  const { manager } = await fixture();
  const reader = await account({ organizationId: manager.organizationId, permissions: ['masters.read'] });
  await configure(manager, { roleIds: [reader.roleId] });
  assert.deepEqual(await counts(reader), [0, 0, 0]);
  const laboratoryId = randomUUID();
  await owner.query("INSERT INTO laboratories(organization_id,id,code,name) VALUES($1,$2::uuid,$2::text,'Read scope lab')", [manager.organizationId, laboratoryId]);
  await work(manager, (client, identity) => updateUserProfile(client, identity, reader.userId,
    { requestId: randomUUID(), revision: 0, defaultRoleId: reader.roleId, laboratoryId }), false);
  assert.deepEqual(await counts(reader), [2, 1, 1]);
  await owner.query('UPDATE roles SET active=false WHERE organization_id=$1 AND id=$2', [manager.organizationId, reader.roleId]);
  assert.deepEqual(await counts(reader), [0, 0, 0]);
});

test('scientific Customer projections preserve registration while hiding contacts and master fields', async () => {
  const { manager, own } = await fixture();
  for (const permission of ['samples.create', 'samples.read', 'samples.manage', 'test_requests.allocate', 'datasheets.execute', 'approvals.respond']) {
    const actor = await account({ organizationId: manager.organizationId, permissions: [permission] });
    assert.deepEqual(await counts(actor), [0, 0, 0]);
    assert.deepEqual(await counts(actor, referenceViews), [2, 1]);
    const records = await work(actor, async client => (await client.query('SELECT * FROM laboratory_customer_references ORDER BY id')).rows);
    assert.deepEqual(Object.keys(records[0]).sort(), ['organization_id', 'id', 'code', 'name', 'legal_name', 'active'].sort());
    assert(records.every(row => row.organization_id === manager.organizationId));
    if (['samples.create', 'samples.read'].includes(permission)) {
      const options = await work(actor, (client, identity) => sampleRegistrationOptions(client, identity));
      assert.equal(options.customers.length, 2);
      assert.equal(options.customers.find(row => row.id === own.parentId).addresses[0].text, 'Synthetic scope address');
    }
  }
});

test('registrar quick creation stays module gated and returns its new scientific reference', async () => {
  const { manager } = await fixture();
  const registrar = await account({ organizationId: manager.organizationId, permissions: ['samples.create'] });
  const input = { name: `Quick read ${randomUUID()}`, legalName: 'Quick legal', contactPersonName: 'Contact', contactPersonEmail: 'quick@example.invalid',
    contactPersonPhone: '123', billToAddress: 'Billing address', shipToAddress: 'Shipping address' };
  await assert.rejects(work(registrar, (client, identity) => quickCreateCustomer(client, identity, input), false), { code: 'customer_module_access_required' });
  await configure(manager, { userIds: [registrar.userId] });
  const result = await work(registrar, (client, identity) => quickCreateCustomer(client, identity, input), false);
  assert.equal(result.name, input.name); assert.equal(result.legalName, input.legalName); assert(result.id);
  assert.equal(result.addresses.length, 2); assert.deepEqual(await counts(registrar), [0, 0, 0]);
  assert.deepEqual(await counts(registrar, referenceViews), [3, 3]);
});

test('registration captures the selected Customer without full master access and keeps its original labels', async () => {
  const registrar = await account({ permissions: ['samples.create'] });
  const laboratory = await createLaboratoryFixture(owner, registrar);
  const input = { ...laboratory.registration, sampleType: 'customer', customerId: laboratory.customer.id, customerAddress: 'Selected address' };
  const saved = await work(registrar, (client, identity) => registerSample(client, identity, input), false);
  assert.deepEqual(await counts(registrar), [0, 0, 0]);
  await owner.query("UPDATE customers SET name='Later customer label',revision=revision+1 WHERE organization_id=$1 AND id=$2", [registrar.organizationId, laboratory.customer.id]);
  const snapshot = (await owner.query('SELECT customer_id,customer_code,customer_name,customer_legal_name,customer_address FROM samples WHERE organization_id=$1 AND id=$2', [registrar.organizationId, saved.id])).rows[0];
  assert.deepEqual(snapshot, { customer_id: laboratory.customer.id, customer_code: laboratory.customer.code, customer_name: laboratory.customer.name,
    customer_legal_name: laboratory.customer.legalName, customer_address: 'Selected address' });
});

test('full and scientific Customer reads remain bound to the authenticated session organization', async () => {
  const { manager, foreign } = await fixture();
  await configure(manager, { userIds: [manager.userId] });
  for (const table of [...fullTables, ...referenceViews]) {
    await work(manager, async client => {
      const result = await client.query(`SELECT organization_id,set_config('app.organization_id',$1,true) AS changed FROM ${table}`, [foreign.organizationId]);
      assert(result.rowCount > 0); assert(result.rows.every(row => row.organization_id === manager.organizationId));
      assert.equal((await client.query(`SELECT * FROM ${table}`)).rowCount, 0);
    });
    for (const value of ['', foreign.organizationId]) await work(manager, async client => {
      await client.query("SELECT set_config('app.organization_id',$1,true)", [value]);
      assert.equal((await client.query(`SELECT * FROM ${table}`)).rowCount, 0);
    });
    await work(manager, async client => {
      await client.query("SELECT set_config('app.session_id',$1,true)", [randomUUID()]);
      assert.equal((await client.query(`SELECT * FROM ${table}`)).rowCount, 0);
    });
  }
});

test('Customer projections grant no writes and the report worker gets no master or projection access', async () => {
  const { manager } = await fixture(); await configure(manager, { userIds: [manager.userId] });
  for (const view of referenceViews) {
    await assert.rejects(work(manager, client => client.query(`DELETE FROM ${view}`), false), { code: '42501' });
    await assert.rejects(work(manager, client => client.query(`UPDATE ${view} SET id=id`), false), { code: '42501' });
    await assert.rejects(work(manager, client => client.query(`INSERT INTO ${view}(organization_id,id) VALUES($1,$2)`, [manager.organizationId, randomUUID()]), false), { code: '42501' });
  }
  for (const table of [...fullTables, ...referenceViews]) {
    const privilege = (await owner.query("SELECT has_table_privilege('sampleify_report_worker',$1,'SELECT') AS allowed", [table])).rows[0];
    assert.equal(privilege.allowed, false);
  }
});
