import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { emptyModuleAccess, saveModuleAccessSettings } from '../helpers/module-access.js';
import { signIn, withSession, publicIdentity } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveCustomer, retireCustomer } from '../../src/masters/customers.js';
import { listCustomers } from '../../src/masters/customer-list.js';
import { saveCustomField } from '../../src/masters/custom-fields.js';
import { customFieldColumnKey } from '../../src/custom-fields/listing-values.js';

const owner = ownerPool();
after(async () => { await closePool(); await owner.end(); });
async function account() {
  const actor = await createAccount(owner, { permissions: ['masters.manage', 'settings.manage'] });
  Object.assign(actor, await signIn({ identifier: actor.username, password: actor.password }));
  await saveModuleAccessSettings(actor, emptyModuleAccess().map(module => module.moduleKey === 'customer' ? { ...module, enabled: true, userIds: [actor.userId] } : module));
  return actor;
}
const work = (actor, action, readOnly = false) => withSession(actor.token, action, { readOnly });
const save = (actor, input) => work(actor, (client, identity) => saveCustomer(client, identity,
  { id: randomUUID(), requestId: randomUUID(), revision: 0, name: 'Synthetic customer', legalName: 'Synthetic legal name', ...input }));
const list = (actor, input = {}) => work(actor, (client, identity) => listCustomers(client, identity, input), true);

test('Customer list selects the same default relations, keeps inactive rows and excludes retired rows', async () => {
  const actor = await account();
  const first = await save(actor, { name: 'Alpha %_ customer', totalBalance: '10', status: 'inactive',
    addresses: [{ id: randomUUID(), addressType: 'shipping', freeformAddress: 'First shipping' },
      { id: randomUUID(), addressType: 'shipping', line1: 'Default street', city: 'Pune', countryCode: 'IN', isDefault: true },
      { id: randomUUID(), addressType: 'billing', freeformAddress: 'First bill' }, { id: randomUUID(), addressType: 'billing', freeformAddress: 'Second bill' }],
    contacts: [{ id: randomUUID(), name: 'First contact', phone: '1' }, { id: randomUUID(), name: 'Primary contact', email: 'primary@example.invalid', isPrimary: true }] });
  await save(actor, { name: 'Beta customer', totalBalance: '2' });
  const removed = await save(actor, { name: 'Removed customer' });
  await work(actor, (client, identity) => retireCustomer(client, identity, { id: removed.id, revision: 1, requestId: randomUUID() }));
  const all = await list(actor, { sort: { key: 'customer_total_balance', dir: 'asc' } });
  assert.equal(all.totalCount, 2); assert.deepEqual(all.rows.map(row => row.customer_total_balance), ['2.00', '10.00']);
  const row = all.rows.find(row => row._id === first.id);
  assert.equal(row.ship_to_address, first.shipToAddress); assert.equal(row.bill_to_address, first.billToAddress);
  assert.equal(row.contact_person_name, first.contactPersonName); assert.equal(row.status, 'Inactive');
  for (const search of ['%_', 'Default street', 'primary@example.invalid']) assert.deepEqual((await list(actor, { search })).rows.map(row => row._id), [first.id]);
  assert.equal((await list(actor, { search: 'Second bill' })).totalCount, 0);
  const filtered = await list(actor, { filters: { status: { type: 'select', value: 'Inactive' }, ship_to_address: { type: 'text', value: 'Default Pune' } } });
  assert.deepEqual(filtered.rows.map(row => row._id), [first.id]);
  const secondPage = await list(actor, { page: 2, pageSize: 1, sort: { key: 'name', dir: 'asc' } });
  assert.equal(secondPage.totalCount, 2); assert.equal(secondPage.rows[0].name, 'Beta customer');
  assert.deepEqual((await list(actor, { page: 4 })).rows, []);
  assert.equal((await list(await account())).totalCount, 0);
});

test('Customer list loads captured fields in batches and supports typed numeric and raw-text filters', async () => {
  const actor = await account();
  const fields = [];
  for (const input of [{ key: 'score', fieldType: 'number' }, { key: 'notes', fieldType: 'text', allowsMultiple: true }]) {
    fields.push(await work(actor, (client, identity) => saveCustomField(client, identity, { id: randomUUID(), requestId: randomUUID(), revision: 0,
      associatedWith: 'customer', label: input.key, showInList: true, showInFilter: true, ...input })));
  }
  const capture = (score, notes) => fields.map(field => ({ fieldId: field.id, fieldRevision: field.revision, value: field.key === 'score' ? score : notes }));
  const first = await save(actor, { name: 'Lower score', customFields: capture(0, ['literal %_', 'Second phrase']) });
  const second = await save(actor, { name: 'Higher score', customFields: capture(10, ['Other']) });
  const sorted = await list(actor, { sort: { key: customFieldColumnKey(fields[0]), dir: 'asc' } });
  assert.deepEqual(sorted.rows.map(row => row._id), [first.id, second.id]); assert.equal(sorted.rows[0].customFields[fields[0].id].displayValue, 0);
  for (const value of ['0', 'Second phrase', '%_']) assert.deepEqual((await list(actor, { search: value })).rows.map(row => row._id), [first.id]);
  const filtered = await list(actor, { filters: { [customFieldColumnKey(fields[1])]: { type: 'text', value: 'Second phrase' } } });
  assert.deepEqual(filtered.rows.map(row => row._id), [first.id]);
});

test('public session module flags and Customer lists follow actual configured access and current permissions', async () => {
  const actor = await account(); const id = await work(actor, publicIdentity, true);
  assert.deepEqual(id.masterModules, { customer: true, vendor: false, instrument: false, service_agreements: false });
  const denied = await createAccount(owner, { organizationId: actor.organizationId, permissions: ['masters.read'] });
  Object.assign(denied, await signIn({ identifier: denied.username, password: denied.password }));
  assert.deepEqual((await work(denied, publicIdentity, true)).masterModules, { customer: false, vendor: false, instrument: false, service_agreements: false });
  await assert.rejects(list(denied), { code: 'customer_module_access_required' });
  await saveModuleAccessSettings(actor, emptyModuleAccess());
  assert.equal((await work(actor, publicIdentity, true)).masterModules.customer, false);
  await assert.rejects(list(actor), { code: 'customer_module_access_required' });
});

test('Customer list validates query shapes, literal searches and sort/filter allowlists', async () => {
  const actor = await account();
  for (const input of [{ page: 0 }, { pageSize: 101 }, { search: '\0' }, { search: '\ud800' }, { sort: { key: 'name;drop table customers', dir: 'asc' } },
    { sort: { key: 'name', dir: 'asc nulls first' } }, { filters: { status: { type: 'text', value: 'Active' } } },
    { filters: { status: { type: 'select', value: 'retired' } } }, { filters: { unknown: { type: 'text', value: 'a' } } }]) {
    await assert.rejects(list(actor, input), error => error.status === 400);
  }
  assert.equal((await list(actor, { search: "' OR true --" })).totalCount, 0);
});
