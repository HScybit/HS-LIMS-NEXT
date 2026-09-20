import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { emptyModuleAccess, saveModuleAccessSettings } from '../helpers/module-access.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveVendor, loadVendor, retireVendor } from '../../src/masters/vendors.js';
import { saveCustomField, retireCustomField, vendorCustomFields } from '../../src/masters/custom-fields.js';
import { generateVendorCustomFields } from '../../src/masters/vendor-custom-field-generation.js';
import { uploadCustomFieldAttachment, readCustomFieldAttachment } from '../../src/custom-fields/attachments.js';
import { saveLookupSourceObservation, loadMasterFieldLookupOptions } from '../../src/custom-fields/lookup-sources.js';

const owner = ownerPool();
after(async () => { await closePool(); await owner.end(); });
const work = (actor, action, readOnly = false) => withSession(actor.token, action, { readOnly });
async function account(options = {}, configured = true) {
  const actor = await createAccount(owner, { permissions: ['masters.manage', 'settings.manage'], ...options });
  Object.assign(actor, await signIn({ identifier: actor.username, password: actor.password }));
  if (configured) await saveModuleAccessSettings(actor, emptyModuleAccess().map(module => module.moduleKey === 'vendor' ? { ...module, enabled: true, userIds: [actor.userId] } : module));
  return actor;
}
const command = (extra = {}) => ({ id: randomUUID(), requestId: randomUUID(), revision: 0, name: 'Synthetic Vendor', legalName: 'Synthetic legal name',
  ...(Object.hasOwn(extra, 'contacts') ? {} : { contactPersonName: 'Contact', contactPersonEmail: 'contact@example.invalid', contactPersonPhone: '123' }), ...extra });
const save = (actor, input) => work(actor, (client, identity) => saveVendor(client, identity, input));
const load = (actor, id, options) => work(actor, (client, identity) => loadVendor(client, identity, id, options), true);
const retire = (actor, input) => work(actor, (client, identity) => retireVendor(client, identity, input));
const field = (actor, input) => work(actor, (client, identity) => saveCustomField(client, identity,
  { id: randomUUID(), requestId: randomUUID(), revision: 0, label: 'Synthetic Vendor field', key: 'field', fieldType: 'text', associatedWith: 'vendor', ...input }));

test('Vendor numeric transport retains zero, negative balances, native scale and finite bounds', async () => {
  const actor = await account(); const first = await save(actor, command({ totalBalance: '-12.345' }));
  assert.equal(first.totalBalance, '-12.35'); assert.equal(first.savedBy, actor.userId); assert.equal(first.revision, 1); assert.equal(first.contacts.length, 1);
  assert.equal(Object.hasOwn(first, 'requestFingerprint'), false);
  assert.equal((await save(actor, command({ name: 'Default balance' }))).totalBalance, '0.00');
  assert.equal((await save(actor, command({ name: 'Large exact balance', totalBalance: '9007199254740993.12' }))).totalBalance, '9007199254740993.12');
  await assert.rejects(save(actor, command({ name: 'Overflow', totalBalance: '9999999999999999.999' })), { code: 'invalid_vendor_number' });
  for (const totalBalance of [NaN, Infinity, 'Infinity', '', null]) await assert.rejects(save(actor, command({ totalBalance })), { code: 'invalid_number' });
  assert.equal((await owner.query('SELECT count(*)::integer AS count FROM vendor_versions WHERE organization_id=$1', [actor.organizationId])).rows[0].count, 3);
});

test('Vendor contacts require valid name, email and phone and preserve unedited extra contacts', async () => {
  const actor = await account();
  for (const key of ['name', 'legalName', 'contactPersonName', 'contactPersonEmail', 'contactPersonPhone']) await assert.rejects(save(actor, command({ [key]: '' })), { code: 'invalid_input' });
  await assert.rejects(save(actor, command({ contactPersonEmail: 'invalid' })), { code: 'invalid_email' });
  await assert.rejects(save(actor, command({ contacts: [] })), { code: 'invalid_party_contact' });
  const input = command({ contacts: [{ id: randomUUID(), name: 'Primary', email: 'primary@example.invalid', phone: '123', isPrimary: true },
    { id: randomUUID(), name: 'Additional', email: 'extra@example.invalid', phone: '234' }] });
  const first = await save(actor, input);
  const second = await save(actor, { id: first.id, requestId: randomUUID(), revision: 1, name: 'Renamed', contactPersonPhone: '456' });
  assert.equal(second.code, first.code); assert.equal(second.contacts[0].id, first.contacts[0].id); assert.equal(second.contacts[0].phone, '456');
  assert.deepEqual(second.contacts[1], first.contacts[1]); assert.deepEqual((await load(actor, first.id, { atRevision: 1 })).contacts, first.contacts);
  const third = await save(actor, { id: first.id, requestId: randomUUID(), revision: 2, contacts: [{ ...second.contacts[0], isPrimary: false }, { ...second.contacts[1], isPrimary: true }] });
  assert.equal(third.contactPersonName, 'Additional');
  await assert.rejects(save(actor, command({ name: 'Reassigned', contacts: first.contacts })), { code: 'invalid_vendor' });
  await assert.rejects(save(actor, { id: first.id, requestId: randomUUID(), revision: 3, contacts: [] }), { code: 'invalid_party_contact' });
});

test('inactive Vendors stay editable and retirement preserves history while permitting code reuse', async () => {
  const actor = await account(); const first = await save(actor, command({ status: 'inactive' }));
  const second = await save(actor, { id: first.id, requestId: randomUUID(), revision: 1, abbreviation: 'Later', legalName: 'Updated legal name' });
  assert.equal(second.active, false); assert.equal(second.retired, false); assert.equal(second.code, first.code);
  await assert.rejects(save(actor, command({ name: 'Duplicate', code: first.code.toLowerCase() })), { code: 'duplicate_vendor' });
  const deletion = { id: first.id, requestId: randomUUID(), revision: 2 };
  assert.deepEqual(await retire(actor, deletion), { id: first.id, revision: 3 }); assert.deepEqual(await retire(actor, deletion), { id: first.id, revision: 3 });
  await assert.rejects(load(actor, first.id), { code: 'vendor_not_found' });
  const retired = await load(actor, first.id, { atRevision: 3 }); assert.equal(retired.retired, true); assert.deepEqual(retired.contacts, first.contacts);
  assert.equal((await save(actor, command({ name: 'Replacement', code: first.code }))).code, first.code);
  await assert.rejects(owner.query("UPDATE vendor_versions SET name='Forged' WHERE organization_id=$1 AND vendor_id=$2", [actor.organizationId, first.id]), { code: '55000' });
});

test('concurrent Vendor retries create one revision and partial retries retain their original response', async () => {
  const actor = await account(); const input = command();
  const [first, replayed] = await Promise.all([save(actor, input), save(actor, input)]); assert.deepEqual(replayed, first);
  const change = { id: first.id, requestId: randomUUID(), revision: 1, totalBalance: '1.001' }; const second = await save(actor, change);
  await save(actor, { id: first.id, requestId: randomUUID(), revision: 2, name: 'Later', totalBalance: '99' });
  assert.deepEqual(await save(actor, change), second); assert.deepEqual(await save(actor, input), first);
  await assert.rejects(save(actor, { ...change, totalBalance: '1.002' }), { code: 'save_request_reused' });
  const attempts = await Promise.allSettled([save(actor, { id: first.id, requestId: randomUUID(), revision: 3, name: 'First editor' }),
    save(actor, { id: first.id, requestId: randomUUID(), revision: 3, name: 'Second editor' })]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1); assert.equal(attempts.find(result => result.status === 'rejected').reason.code, 'stale_vendor');
  assert.equal((await owner.query('SELECT count(*)::integer AS count FROM vendor_versions WHERE organization_id=$1 AND vendor_id=$2', [actor.organizationId, first.id])).rows[0].count, 4);
});

test('Vendor required and unique fields include inactive records and retain exact values after definition retirement', async () => {
  const actor = await account(); const definition = await field(actor, { isRequired: true, validateUniqueness: true });
  const values = [{ fieldId: definition.id, fieldRevision: definition.revision, value: 'Unique' }];
  await assert.rejects(save(actor, command()), { code: 'vendor_custom_fields_changed' });
  await assert.rejects(save(actor, command({ customFields: [{ ...values[0], value: '' }] })), { code: 'invalid_custom_field_value' });
  const first = await save(actor, command({ status: 'inactive', customFields: values }));
  await assert.rejects(save(actor, command({ name: 'Duplicate', customFields: values })), { code: 'duplicate_custom_field_value' });
  await work(actor, (client, identity) => retireCustomField(client, identity, { id: definition.id, requestId: randomUUID(), revision: 1 }));
  const second = await save(actor, { id: first.id, requestId: randomUUID(), revision: 1, name: 'Renamed' });
  assert.deepEqual(second.customFields, first.customFields);
  await retire(actor, { id: first.id, requestId: randomUUID(), revision: 2 });
  assert.deepEqual((await load(actor, first.id, { atRevision: 3 })).customFields, first.customFields);
});

test('Vendor files require current configured access and keep their original association on definition moves', async () => {
  const actor = await account(); const definition = await field(actor, { fieldType: 'attachment' });
  const upload = { requestId: randomUUID(), fieldId: definition.id, fieldRevision: definition.revision, originalName: 'evidence.txt', mediaType: 'text/plain', content: Buffer.from('Synthetic Vendor file') };
  const file = await work(actor, (client, identity) => uploadCustomFieldAttachment(client, identity, upload));
  assert.equal((await work(actor, (client, identity) => uploadCustomFieldAttachment(client, identity, upload))).replayed, true);
  const first = await save(actor, command({ customFields: [{ fieldId: definition.id, fieldRevision: definition.revision, value: file.id }] }));
  assert.equal(first.customFields[0].items[0].attachmentId, file.id);
  const productField = await field(actor, { key: 'product_file', fieldType: 'attachment', associatedWith: 'product' });
  const productFile = await work(actor, (client, identity) => uploadCustomFieldAttachment(client, identity, { ...upload, requestId: randomUUID(), fieldId: productField.id }));
  await assert.rejects(save(actor, command({ name: 'Foreign file', customFields: [{ fieldId: definition.id, fieldRevision: definition.revision, value: productFile.id }] })), { code: 'invalid_vendor_custom_field_attachment' });
  const outsider = await account({ organizationId: actor.organizationId, permissions: ['masters.manage'] }, false);
  await assert.rejects(work(outsider, (client, identity) => uploadCustomFieldAttachment(client, identity, upload)), { code: 'vendor_module_access_required' });
  await field(actor, { id: definition.id, requestId: randomUUID(), revision: 1, fieldType: 'attachment', associatedWith: 'product' });
  assert.equal((await work(actor, (client, identity) => uploadCustomFieldAttachment(client, identity, upload))).replayed, true);
  assert.deepEqual((await work(actor, (client, identity) => readCustomFieldAttachment(client, identity, file.id), true)).content, upload.content);
  await assert.rejects(work(outsider, (client, identity) => readCustomFieldAttachment(client, identity, file.id), true), { code: 'attachment_not_found' });
});

test('Vendor generation resolves actual lookup labels, feeds later fields and counts inactive heads', async () => {
  const actor = await account();
  const source = { id: randomUUID(), sourceId: randomUUID(), requestId: randomUUID(), revision: 0, name: 'Synthetic Vendor lookup', lines: [{ id: 'A', label: 'Alpha' }] };
  await work(actor, (client, identity) => saveLookupSourceObservation(client, identity, source));
  const definitions = [];
  for (const [index, properties] of [
    { key: 'serial', fieldType: 'text', scheme: '{{abbr}}/{{scheme_counter}}', splitter: '/', generatedAt: 'on_init' },
    { key: 'copy', fieldType: 'text', scheme: '{{serial}}/{{total_counter}}/{{choice}}', generatedAt: 'on_submit' },
    { key: 'choice', fieldType: 'lookup', lookupSourceId: source.id },
    { key: 'number', fieldType: 'number', allowsMultiple: true }, { key: 'flag', fieldType: 'checkbox' }, { key: 'date', fieldType: 'date_time' },
    { key: 'option', fieldType: 'select', options: [{ id: randomUUID(), key: 'A', label: 'Option Alpha' }] }, { key: 'people', fieldType: 'multi_user_select' },
  ].entries()) definitions.push(await field(actor, { displayOrder: index, ...properties }));
  const raw = ['', '', 'A', [0, false, 'bad', '0x10'], false, '2026-03-08T02:30', 'A', [actor.userId]];
  const input = { vendor: { name: 'Supplier', abbreviation: 'VN' }, customFieldTimeZone: 'America/New_York',
    customFields: definitions.map((definition, index) => ({ fieldId: definition.id, fieldRevision: 1, value: raw[index] })) };
  const generate = () => work(actor, (client, identity) => generateVendorCustomFields(client, identity, input), true);
  assert.deepEqual((await generate()).values.map(item => item.value), ['VN/1', 'VN/1/1/Alpha']);
  const first = await save(actor, command({ status: 'inactive', customFieldTimeZone: input.customFieldTimeZone,
    customFields: input.customFields.map((item, index) => ({ ...item, value: ['VN/1', 'VN/1/1/Alpha'][index] ?? item.value })) }));
  assert.deepEqual(first.customFields[3].items.map(item => item.interpretationState), ['valid', 'valid', 'invalid', 'valid']);
  assert.equal(first.customFields[4].displayValue, false); assert.equal(first.customFields[5].displayValue, '08/03/2026 03:30:00');
  assert.equal(first.customFields[6].items[0].optionLabel, 'Option Alpha'); assert.equal(first.customFields[7].items[0].userId, actor.userId);
  assert.deepEqual((await generate()).values.map(item => item.value), ['VN/2', 'VN/2/2/Alpha']);
  assert.equal((await work(actor, client => client.query('SELECT * FROM masters_vendor_scheme_context(true,false)'), true)).rows[0].vendorCount, 1);
  await retire(actor, { id: first.id, requestId: randomUUID(), revision: 1 });
  assert.deepEqual((await generate()).values.map(item => item.value), ['VN/1', 'VN/1/1/Alpha']);
});

test('Vendor service and direct SQL require configured module access and reject foreign organizations', async () => {
  const manager = await account(); const first = await save(manager, command());
  const outsider = await account({ organizationId: manager.organizationId, permissions: ['masters.manage'] }, false);
  const foreign = await account();
  for (const table of ['vendors', 'vendor_contacts', 'vendor_versions', 'vendor_version_contacts', 'vendor_version_custom_fields', 'vendor_version_custom_field_values']) {
    for (const actor of [outsider, foreign]) assert.equal((await work(actor, client => client.query(`SELECT 1 FROM ${table} WHERE organization_id=$1`, [manager.organizationId]), true)).rowCount, 0);
    for (const action of ['UPDATE', 'DELETE']) await assert.rejects(work(manager, client => client.query(action === 'DELETE' ? `DELETE FROM ${table}` : `UPDATE ${table} SET organization_id=organization_id`)), { code: '42501' });
  }
  await assert.rejects(load(outsider, first.id), { code: 'vendor_module_access_required' });
  await assert.rejects(load(foreign, first.id), { code: 'vendor_not_found' });
  await assert.rejects(save(outsider, command()), { code: 'vendor_module_access_required' });
  await assert.rejects(work(outsider, vendorCustomFields, true), { code: 'vendor_module_access_required' });
  await assert.rejects(work(outsider, (client, identity) => loadMasterFieldLookupOptions('vendor', client, identity, { sourceId: randomUUID() }), true), { code: 'vendor_module_access_required' });
  await saveModuleAccessSettings(manager, emptyModuleAccess());
  await assert.rejects(load(manager, first.id), { code: 'vendor_module_access_required' });
  await assert.rejects(save(manager, { id: first.id, requestId: randomUUID(), revision: 1, name: 'Revoked' }), { code: 'vendor_module_access_required' });
  await assert.rejects(retire(manager, { id: first.id, requestId: randomUUID(), revision: 1 }), { code: 'vendor_module_access_required' });
});

test('Vendor native commands enforce contact validation, actual actor and capture transaction guards', async () => {
  const actor = await account(); const first = await save(actor, command());
  await assert.rejects(work(actor, client => client.query('SELECT masters_record_vendor($1,NULL,$2,$3,$4)', [first.id, 'create', 'a'.repeat(64), [first.contacts[0].id]])), { code: '42501' });
  await assert.rejects(work(actor, client => client.query('INSERT INTO vendor_versions SELECT * FROM vendor_versions')), { code: '42501' });
  const definition = await field(actor, {}); const captured = await save(actor, command({ name: 'Captured', customFields: [{ fieldId: definition.id, fieldRevision: 1, value: 'Value' }] }));
  await assert.rejects(work(actor, client => client.query('INSERT INTO vendor_version_custom_fields SELECT * FROM vendor_version_custom_fields WHERE organization_id=$1 AND vendor_id=$2', [actor.organizationId, captured.id])), { code: '23514', constraint: 'vendor_custom_field_transaction' });
  const args = [randomUUID(), 0, randomUUID(), 'a'.repeat(64), 'NATIVE', 'Native', 'Native legal', null, null, 0, true, 1, true,
    [randomUUID()], ['Contact'], ['invalid'], ['123'], [true]];
  await assert.rejects(work(actor, client => client.query(`SELECT masters_save_vendor(${args.map((_, index) => `$${index + 1}`).join(',')})`, args)), { code: '23514', constraint: 'vendor_relation_input' });
  args[15] = ['valid@example.invalid'];
  await assert.rejects(work(actor, client => client.query(`SELECT masters_save_vendor(${args.map((_, index) => `$${index + 1}`).join(',')})`, args)), { code: '23514', constraint: 'vendor_custom_field_complete' });
  assert.equal((await owner.query('SELECT 1 FROM vendors WHERE organization_id=$1 AND id=$2', [actor.organizationId, args[0]])).rowCount, 0);
});
