import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { emptyModuleAccess, saveModuleAccessSettings } from '../helpers/module-access.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveCustomer, loadCustomer, retireCustomer } from '../../src/masters/customers.js';
import { saveCustomField } from '../../src/masters/custom-fields.js';
import { generateCustomerCustomFields } from '../../src/masters/customer-custom-field-generation.js';
import { uploadCustomFieldAttachment, readCustomFieldAttachment } from '../../src/custom-fields/attachments.js';
import { registerSample } from '../../src/samples/register.js';
import { quickCreateCustomer } from '../../src/samples/customer.js';

const owner = ownerPool();
after(async () => { await closePool(); await owner.end(); });
const work = (actor, action, readOnly = false) => withSession(actor.token, action, { readOnly });
async function account(options = {}, configured = true) {
  const actor = await createAccount(owner, { permissions: ['masters.manage', 'settings.manage', 'samples.create'], ...options });
  Object.assign(actor, await signIn({ identifier: actor.username, password: actor.password }));
  if (configured) await saveModuleAccessSettings(actor, emptyModuleAccess().map(module => module.moduleKey === 'customer' ? { ...module, enabled: true, userIds: [actor.userId] } : module));
  return actor;
}
const command = (extra = {}) => ({ id: randomUUID(), requestId: randomUUID(), revision: 0, name: 'Synthetic Customer', legalName: 'Synthetic legal name', ...extra });
const save = (actor, input) => work(actor, (client, identity) => saveCustomer(client, identity, input));
const load = (actor, id, options) => work(actor, (client, identity) => loadCustomer(client, identity, id, options), true);
const retire = (actor, value) => work(actor, (client, identity) => retireCustomer(client, identity, value));
const field = (actor, input) => work(actor, (client, identity) => saveCustomField(client, identity,
  { id: randomUUID(), requestId: randomUUID(), revision: 0, label: 'Synthetic Customer field', key: 'field', fieldType: 'text', associatedWith: 'customer', ...input }));

test('Customer saves retain exact numeric transport, source scale, zero and API defaults', async () => {
  const actor = await account();
  const first = await save(actor, command({ totalBalance: '-12.345', creditDays: 0, igstPercent: 0, sgstPercent: '1.00005', discountPercent: 0 }));
  assert.equal(first.totalBalance, '-12.35'); assert.equal(first.creditDays, 0); assert.equal(first.igstPercent, '0.0000'); assert.equal(first.sgstPercent, '1.0001');
  assert.equal(first.savedBy, actor.userId); assert.equal(first.revision, 1); assert.equal(first.saveSource, 'master');
  assert.deepEqual(first.addresses, []); assert.deepEqual(first.contacts, []); assert.equal(Object.hasOwn(first, 'requestFingerprint'), false);
  const defaults = await save(actor, command({ name: 'Defaults' })); assert.equal(defaults.creditDays, 0); assert.equal(defaults.igstPercent, '18.0000');
  await assert.rejects(save(actor, command({ name: 'Overflow', totalBalance: '999999999999999999.999' })), { code: 'invalid_customer_number' });
  assert.equal((await owner.query('SELECT count(*)::integer AS n FROM customer_versions WHERE organization_id=$1', [actor.organizationId])).rows[0].n, 2);
});

test('flat Customer edits preserve structured addresses, stable IDs, designation and additional contacts', async () => {
  const actor = await account();
  const input = command({ addresses: [{ id: randomUUID(), addressType: 'shipping', line1: 'Original street', city: 'Pune', countryCode: 'IN', isDefault: true },
    { id: randomUUID(), addressType: 'other', freeformAddress: 'Other location' }],
  contacts: [{ id: randomUUID(), name: 'Primary', email: 'primary@example.invalid', designation: 'Manager', isPrimary: true },
    { id: randomUUID(), name: 'Additional', phone: '234' }] });
  const first = await save(actor, input);
  const unchanged = await save(actor, { id: first.id, requestId: randomUUID(), revision: 1, shipToAddress: first.shipToAddress, name: 'Renamed' });
  assert.equal(unchanged.code, first.code); assert.deepEqual(unchanged.addresses, first.addresses); assert.deepEqual(unchanged.contacts, first.contacts);
  const changed = await save(actor, { id: first.id, requestId: randomUUID(), revision: 2, shipToAddress: 'New freeform', contactPersonPhone: '456' });
  assert.equal(changed.addresses[0].id, first.addresses[0].id); assert.equal(changed.addresses[0].line1, null);
  assert.deepEqual(changed.addresses[1], first.addresses[1]); assert.equal(changed.contacts[0].designation, 'Manager'); assert.deepEqual(changed.contacts[1], first.contacts[1]);
  assert.deepEqual((await load(actor, first.id, { atRevision: 1 })).addresses, first.addresses);
  const cleared = await save(actor, { id: first.id, requestId: randomUUID(), revision: 3, addresses: [], contacts: [] });
  assert.deepEqual(cleared.addresses, []); assert.deepEqual(cleared.contacts, []);
  await assert.rejects(save(actor, command({ name: 'Reassigned', contacts: [first.contacts[0]] })), { code: 'invalid_customer' });
});

test('inactive Customers remain editable while retirement preserves immutable history and frees the code', async () => {
  const actor = await account(); const input = command({ status: 'inactive', shipToAddress: 'Address' }); const first = await save(actor, input);
  const second = await save(actor, { id: first.id, requestId: randomUUID(), revision: 1, legalName: 'Updated legal name' });
  assert.equal(second.active, false); assert.equal(second.retired, false);
  const deletion = { id: first.id, requestId: randomUUID(), revision: 2 };
  assert.deepEqual(await retire(actor, deletion), { id: first.id, revision: 3 }); assert.deepEqual(await retire(actor, deletion), { id: first.id, revision: 3 });
  await assert.rejects(load(actor, first.id), { code: 'customer_not_found' });
  const retired = await load(actor, first.id, { atRevision: 3 }); assert.equal(retired.retired, true); assert.deepEqual(retired.addresses, first.addresses);
  assert.equal((await save(actor, command({ name: 'Replacement', code: first.code }))).code, first.code);
  await assert.rejects(owner.query("UPDATE customer_versions SET name='Forged' WHERE organization_id=$1 AND customer_id=$2", [actor.organizationId, first.id]), { code: '55000' });
});

test('concurrent exact retries create one Customer revision and later partial retries return their original values', async () => {
  const actor = await account(); const input = command({ shipToAddress: 'Address', contactPersonName: 'Primary', contactPersonPhone: '123' });
  const [first, replayed] = await Promise.all([save(actor, input), save(actor, input)]); assert.deepEqual(replayed, first);
  const change = { id: first.id, requestId: randomUUID(), revision: 1, totalBalance: '1.001' }; const second = await save(actor, change);
  await save(actor, { id: first.id, requestId: randomUUID(), revision: 2, name: 'Later name', totalBalance: '99' });
  assert.deepEqual(await save(actor, change), second); assert.deepEqual(await save(actor, input), first);
  await assert.rejects(save(actor, { ...change, totalBalance: '1.002' }), { code: 'save_request_reused' });
  const attempts = await Promise.allSettled([save(actor, { id: first.id, requestId: randomUUID(), revision: 3, name: 'First editor' }),
    save(actor, { id: first.id, requestId: randomUUID(), revision: 3, name: 'Second editor' })]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1); assert.equal(attempts.find(result => result.status === 'rejected').reason.code, 'stale_customer');
  assert.equal((await owner.query('SELECT count(*)::integer AS n FROM customer_versions WHERE organization_id=$1 AND customer_id=$2', [actor.organizationId, first.id])).rows[0].n, 4);
});

test('required and unique Customer fields apply to inactive records and are preserved on retirement', async () => {
  const actor = await account(); const definition = await field(actor, { isRequired: true, validateUniqueness: true });
  const values = [{ fieldId: definition.id, fieldRevision: definition.revision, value: 'Unique' }];
  await assert.rejects(save(actor, command()), { code: 'customer_custom_fields_changed' });
  await assert.rejects(save(actor, command({ customFields: [{ ...values[0], value: '' }] })), { code: 'invalid_custom_field_value' });
  const first = await save(actor, command({ status: 'inactive', customFields: values }));
  await assert.rejects(save(actor, command({ name: 'Duplicate', customFields: values })), { code: 'duplicate_custom_field_value' });
  await retire(actor, { id: first.id, requestId: randomUUID(), revision: 1 });
  assert.deepEqual((await load(actor, first.id, { atRevision: 2 })).customFields, first.customFields);
  assert.equal((await save(actor, command({ name: 'Available again', customFields: values }))).customFields[0].value, 'Unique');
});

test('Customer attachments require configured access, retain bytes and reject cross-master references', async () => {
  const actor = await account(); const definition = await field(actor, { fieldType: 'attachment' });
  const input = { requestId: randomUUID(), fieldId: definition.id, fieldRevision: definition.revision, originalName: 'evidence.txt', mediaType: 'text/plain', content: Buffer.from('Synthetic Customer file') };
  const file = await work(actor, (client, identity) => uploadCustomFieldAttachment(client, identity, input));
  assert.equal((await work(actor, (client, identity) => uploadCustomFieldAttachment(client, identity, input))).replayed, true);
  assert.deepEqual((await work(actor, (client, identity) => readCustomFieldAttachment(client, identity, file.id), true)).content, input.content);
  const first = await save(actor, command({ customFields: [{ fieldId: definition.id, fieldRevision: definition.revision, value: file.id }] }));
  assert.equal(first.customFields[0].items[0].attachmentId, file.id);
  const other = await account({ organizationId: actor.organizationId, permissions: ['masters.read', 'masters.manage'] }, false);
  await assert.rejects(work(other, (client, identity) => uploadCustomFieldAttachment(client, identity, input)), { code: 'customer_module_access_required' });
  await assert.rejects(work(other, (client, identity) => readCustomFieldAttachment(client, identity, file.id), true), { code: 'attachment_not_found' });
  const productField = await field(actor, { id: randomUUID(), key: 'product_file', fieldType: 'attachment', associatedWith: 'product' });
  const productFile = await work(actor, (client, identity) => uploadCustomFieldAttachment(client, identity, { ...input, requestId: randomUUID(), fieldId: productField.id }));
  await assert.rejects(save(actor, command({ name: 'Foreign file', customFields: [{ fieldId: definition.id, fieldRevision: definition.revision, value: productFile.id }] })), { code: 'invalid_customer_custom_field_attachment' });
});

test('Customer generation counts inactive masters and excludes retired records', async () => {
  const actor = await account(); const definition = await field(actor, { scheme: '{{customer_abbr}}/{{scheme_counter}}', splitter: '/', generatedAt: 'on_init' });
  const input = { customer: { name: 'Client', abbreviation: 'CL', status: 'inactive' }, customFields: [{ fieldId: definition.id, fieldRevision: definition.revision, value: '' }] };
  const generate = () => work(actor, (client, identity) => generateCustomerCustomFields(client, identity, input), true);
  assert.equal((await generate()).values[0].value, 'CL/1');
  const first = await save(actor, command({ status: 'inactive', customFields: [{ ...input.customFields[0], value: 'CL/1' }] }));
  assert.equal((await generate()).values[0].value, 'CL/2');
  assert.equal((await work(actor, client => client.query('SELECT * FROM masters_customer_scheme_context(true,false)'), true)).rows[0].customerCount, 1);
  await retire(actor, { id: first.id, requestId: randomUUID(), revision: 1 }); assert.equal((await generate()).values[0].value, 'CL/1');
});

test('native Customer retirement rejects quotations and Samples while edits preserve frozen Sample labels', async () => {
  const actor = await account(); const fixture = await createLaboratoryFixture(owner, actor);
  const input = { ...fixture.registration, sampleType: 'customer', customerId: fixture.customer.id, customerAddress: 'Original chosen address' };
  const sample = await work(actor, (client, identity) => registerSample(client, identity, input));
  await assert.rejects(retire(actor, { id: fixture.customer.id, requestId: randomUUID(), revision: 1 }), { code: 'customer_in_use' });
  const edited = await save(actor, { id: fixture.customer.id, requestId: randomUUID(), revision: 1, name: 'Later name', shipToAddress: 'Later address' });
  assert.equal(edited.revision, 2); await assert.rejects(load(actor, edited.id, { atRevision: 1 }), { code: 'customer_not_found' });
  const frozen = (await owner.query('SELECT customer_name,customer_address FROM samples WHERE organization_id=$1 AND id=$2', [actor.organizationId, sample.id])).rows[0];
  assert.deepEqual(frozen, { customer_name: fixture.customer.name, customer_address: 'Original chosen address' });
  const quoted = await save(actor, command({ name: 'Quoted Customer' }));
  await owner.query("INSERT INTO customer_quotations(organization_id,customer_id,quotation_number,quotation_date) VALUES($1,$2,$3,current_date)", [actor.organizationId, quoted.id, randomUUID()]);
  await assert.rejects(retire(actor, { id: quoted.id, requestId: randomUUID(), revision: 1 }), { code: 'customer_in_use' });
});

test('quick registration records its actual actor and children without granting full Customer history reads', async () => {
  const manager = await account(); const registrar = await account({ organizationId: manager.organizationId, permissions: ['samples.create'] }, false);
  await saveModuleAccessSettings(manager, emptyModuleAccess().map(module => module.moduleKey === 'customer' ? { ...module, enabled: true, userIds: [registrar.userId] } : module));
  const saved = await work(registrar, (client, identity) => quickCreateCustomer(client, identity, { name: 'Quick Customer', legalName: 'Quick legal', contactPersonName: 'Contact',
    contactPersonEmail: 'contact@example.invalid', contactPersonPhone: '123', billToAddress: 'Bill', shipToAddress: 'Ship' }));
  assert.equal((await work(registrar, client => client.query('SELECT * FROM customer_versions'), true)).rowCount, 0);
  const version = (await owner.query('SELECT saved_by,save_source,address_count,contact_count,custom_field_count FROM customer_versions WHERE organization_id=$1 AND customer_id=$2', [registrar.organizationId, saved.id])).rows[0];
  assert.deepEqual(version, { saved_by: registrar.userId, save_source: 'registration', address_count: 2, contact_count: 1, custom_field_count: 0 });
});
