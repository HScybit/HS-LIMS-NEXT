import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { emptyModuleAccess, saveModuleAccessSettings } from '../helpers/module-access.js';
import { signIn, withSession, publicIdentity } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveVendor, retireVendor } from '../../src/masters/vendors.js';
import { listVendors } from '../../src/masters/vendor-list.js';
import { saveCustomField } from '../../src/masters/custom-fields.js';
import { customFieldColumnKey } from '../../src/custom-fields/listing-values.js';

const owner = ownerPool();
after(async () => { await closePool(); await owner.end(); });
async function account() {
  const actor = await createAccount(owner, { permissions: ['masters.manage', 'settings.manage'] });
  Object.assign(actor, await signIn({ identifier: actor.username, password: actor.password }));
  await saveModuleAccessSettings(actor, emptyModuleAccess().map(module => module.moduleKey === 'vendor' ? { ...module, enabled: true, userIds: [actor.userId] } : module));
  return actor;
}
const work = (actor, action, readOnly = false) => withSession(actor.token, action, { readOnly });
const save = (actor, input) => work(actor, (client, identity) => saveVendor(client, identity,
  { id: randomUUID(), requestId: randomUUID(), revision: 0, name: 'Synthetic vendor', legalName: 'Synthetic legal name', ...(input?.contacts ? {} : { contactPersonName: 'Contact', contactPersonEmail: 'contact@example.invalid', contactPersonPhone: '123' }), ...input }));
const list = (actor, input = {}) => work(actor, (client, identity) => listVendors(client, identity, input), true);

test('Vendor list selects the same primary contact, searches literal text and retains inactive rows', async () => {
  const actor = await account();
  const first = await save(actor, { name: 'Alpha %_ vendor', status: 'inactive',
    contacts: [{ id: randomUUID(), name: 'First contact', email: 'first@example.invalid', phone: '1' },
      { id: randomUUID(), name: 'Primary contact', email: 'primary@example.invalid', phone: '2', isPrimary: true }] });
  await save(actor, { name: 'Beta vendor' }); const removed = await save(actor, { name: 'Removed vendor' });
  await work(actor, (client, identity) => retireVendor(client, identity, { id: removed.id, revision: 1, requestId: randomUUID() }));
  const all = await list(actor, { sort: { key: 'name', dir: 'asc' } });
  assert.equal(all.totalCount, 2); assert.equal(all.rows[0]._id, first.id);
  assert.equal(all.rows[0].contact_person_name, first.contactPersonName);
  assert.deepEqual(Object.keys(all.rows[0]).filter(key => key !== 'customFields').sort(), ['_id', 'contact_person_email', 'contact_person_name', 'contact_person_phone', 'name', 'revision']);
  for (const search of ['%_', 'primary@example.invalid']) assert.deepEqual((await list(actor, { search })).rows.map(row => row._id), [first.id]);
  assert.equal((await list(actor, { search: 'first@example.invalid' })).totalCount, 0);
  assert.deepEqual((await list(actor, { filters: { contact_person_name: { type: 'text', value: 'Primary contact' } } })).rows.map(row => row._id), [first.id]);
  assert.equal((await list(actor, { page: 2, pageSize: 1, sort: { key: 'name', dir: 'asc' } })).rows[0].name, 'Beta vendor');
  assert.deepEqual((await list(actor, { page: 4 })).rows, []); assert.equal((await list(await account())).totalCount, 0);
});

test('Vendor list loads captured fields in batches and supports typed numeric and raw-text filters', async () => {
  const actor = await account();
  const fields = [];
  for (const input of [{ key: 'score', fieldType: 'number' }, { key: 'notes', fieldType: 'text', allowsMultiple: true }]) {
    fields.push(await work(actor, (client, identity) => saveCustomField(client, identity, { id: randomUUID(), requestId: randomUUID(), revision: 0,
      associatedWith: 'vendor', label: input.key, showInList: true, showInFilter: true, ...input })));
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

test('public session module flags and Vendor lists follow actual configured access and current permissions', async () => {
  const actor = await account(); const id = await work(actor, publicIdentity, true);
  assert.deepEqual(id.masterModules, { customer: false, vendor: true, instrument: false, service_agreements: false, inventory: false });
  const denied = await createAccount(owner, { organizationId: actor.organizationId, permissions: ['masters.read'] });
  Object.assign(denied, await signIn({ identifier: denied.username, password: denied.password }));
  assert.deepEqual((await work(denied, publicIdentity, true)).masterModules, { customer: false, vendor: false, instrument: false, service_agreements: false, inventory: false });
  await assert.rejects(list(denied), { code: 'vendor_module_access_required' });
  await saveModuleAccessSettings(actor, emptyModuleAccess());
  assert.equal((await work(actor, publicIdentity, true)).masterModules.vendor, false);
  await assert.rejects(list(actor), { code: 'vendor_module_access_required' });
});

test('Vendor list validates query shapes, literal searches and sort/filter allowlists', async () => {
  const actor = await account();
  for (const input of [{ page: 0 }, { pageSize: 101 }, { search: '\0' }, { search: '\ud800' }, { sort: { key: 'name;drop table vendors', dir: 'asc' } },
    { sort: { key: 'name', dir: 'asc nulls first' } }, { filters: { status: { type: 'text', value: 'Active' } } },
    { filters: { status: { type: 'select', value: 'retired' } } }, { filters: { unknown: { type: 'text', value: 'a' } } }]) {
    await assert.rejects(list(actor, input), error => error.status === 400);
  }
  assert.equal((await list(actor, { search: "' OR true --" })).totalCount, 0);
});
