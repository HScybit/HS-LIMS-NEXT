import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveProduct, loadProduct, retireProduct, productCustomFieldUsers } from '../../src/masters/products.js';
import { saveCustomField, retireCustomField, productCustomFields } from '../../src/masters/custom-fields.js';
import { uploadCustomFieldAttachment } from '../../src/custom-fields/attachments.js';

const owner = ownerPool();
after(async () => { await closePool(); await owner.end(); });
const work = (user, action, readOnly = false) => withSession(user.token, action, { csrfToken: user.csrfToken, readOnly });
async function account(options = {}) {
  const user = await createAccount(owner, { permissions: ['masters.manage'], ...options });
  return { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
}
const definition = (fieldType, extra = {}) => ({ id: randomUUID(), revision: 0, requestId: randomUUID(), label: `Synthetic ${fieldType}`,
  key: fieldType, fieldType, associatedWith: 'product', ...extra });
const product = (customFields, extra = {}) => ({ id: randomUUID(), requestId: randomUUID(), revision: 0, name: 'Synthetic captured Product',
  key: randomUUID(), customFields, ...extra });
const entry = (field, value) => ({ fieldId: field.id, fieldRevision: field.revision, value });

test('all eleven Product field types persist typed values, batched references and exact historical retries after edits and retirement', async () => {
  const user = await account();
  const choices = ['A','0','false'].map((key) => ({ id: randomUUID(), key, label: key === 'A' ? 'Alpha' : key === '0' ? 'Zero' : 'False' }));
  const types = ['text','number','date','select','lookup','longtext','attachment','multi_user_select','date_time','checkbox','email'];
  const commands = types.map((type, index) => definition(type, { displayOrder: index, isRequired: ['text','checkbox'].includes(type),
    allowsMultiple: ['number','select','email'].includes(type), ...(type === 'select' ? { options: choices } : {}) }));
  const fields = [];
  for (const command of commands) fields.push(await work(user, (client, identity) => saveCustomField(client, identity, command)));
  const fileField = fields.find((field) => field.fieldType === 'attachment');
  const file = await work(user, (client, identity) => uploadCustomFieldAttachment(client, identity, { requestId: randomUUID(), fieldId: fileField.id, fieldRevision: 1,
    originalName: 'synthetic.txt', mediaType: 'text/plain', content: Buffer.from('Synthetic immutable Product attachment') }));
  const raw = { text: [], number: ['0x10','bad','Infinity',0,false,189761652901714800], date: '2026-02-31', select: ['A',0,false],
    lookup: '', longtext: 0, attachment: file.id, multi_user_select: [user.userId.toUpperCase()], date_time: '2026-03-08T02:30', checkbox: false, email: ['invalid email',0,false] };
  const command = product(fields.map((field) => entry(field, raw[field.fieldType])), { customFieldTimeZone: 'America/New_York' });
  const saved = await work(user, (client, identity) => saveProduct(client, identity, command));
  assert.deepEqual(saved.customFields.map((field) => field.value), types.map((type) => raw[type]));
  const byType = new Map(saved.customFields.map((field) => [field.fieldType, field]));
  assert.equal(byType.get('date').items[0].interpretationState, 'invalid');
  assert.equal(byType.get('date_time').displayValue, '08/03/2026 03:30:00');
  assert.equal(byType.get('select').displayValue, 'Alpha, Zero, False');
  assert.deepEqual(byType.get('number').items.map((item) => item.interpretationState), ['valid','invalid','invalid','valid','valid','valid']);
  assert.equal(byType.get('attachment').items[0].attachment.originalName, 'synthetic.txt');
  assert.equal(byType.get('multi_user_select').items[0].userName, 'Synthetic Analyst');
  const readStatements = [];
  const loaded = await work(user, (client, identity) => loadProduct({ query: (sql, args) => { readStatements.push(sql); return client.query(sql, args); } }, identity, saved.id), true);
  assert.deepEqual(loaded.customFields, saved.customFields);
  assert.equal(readStatements.filter((sql) => sql.includes('FROM product_version_custom_field')).length, 2);
  const stored = (await owner.query('SELECT raw_number,raw_number_text,parsed_number FROM product_version_custom_field_values WHERE organization_id=$1 AND product_id=$2 AND field_id=$3 ORDER BY position',
    [user.organizationId, saved.id, fields[1].id])).rows;
  assert.equal(stored[5].raw_number_text, '189761652901714800'); assert.equal(stored[0].parsed_number, 16);
  const selectCommand = commands.find((field) => field.fieldType === 'select');
  await work(user, (client, identity) => saveCustomField(client, identity, { ...selectCommand, revision: 1, requestId: randomUUID(), options: choices.slice(1) }));
  const dateCommand = commands.find((field) => field.fieldType === 'date');
  await work(user, (client, identity) => saveCustomField(client, identity, { ...dateCommand, revision: 1, requestId: randomUUID(), label: 'Later date', dateFormat: 'YYYY-MM-DD' }));
  assert.deepEqual((await work(user, (client, identity) => saveProduct(client, identity, command))).customFields, saved.customFields);
  await assert.rejects(work(user, (client, identity) => saveProduct(client, identity, { ...command, requestId: randomUUID(), revision: 1 })), { code: 'product_custom_fields_changed' });
  const current = await work(user, productCustomFields, true);
  const edited = await work(user, (client, identity) => saveProduct(client, identity, { ...command, revision: 1, requestId: randomUUID(),
    customFields: current.map((field) => entry(field, field.fieldType === 'date' ? -1e15 : raw[field.fieldType])) }));
  assert.deepEqual(edited.customFields.find((field) => field.fieldType === 'select').items.map((item) => item.optionRevision), [1,2,2]);
  assert.equal(edited.customFields.find((field) => field.fieldType === 'date').items[0].interpretationState, 'out_of_range');
  await work(user, (client, identity) => retireProduct(client, identity, { id: saved.id, revision: 2, requestId: randomUUID() }));
  assert.deepEqual((await work(user, (client, identity) => loadProduct(client, identity, saved.id, { atRevision: 1 }), true)).customFields, saved.customFields);
  assert.deepEqual((await work(user, (client, identity) => loadProduct(client, identity, saved.id, { atRevision: 3 }), true)).customFields, edited.customFields);
  assert.deepEqual((await work(user, (client, identity) => saveProduct(client, identity, command))).customFields, saved.customFields);
});

test('Product uniqueness serializes simultaneous saves and retains source raw-string and case distinctions', async () => {
  const user = await account(); const command = definition('text', { validateUniqueness: true });
  const field = await work(user, (client, identity) => saveCustomField(client, identity, command));
  const raced = await Promise.allSettled([1,2].map(() => work(user, (client, identity) => saveProduct(client, identity, product([entry(field, 'SAME')])))));
  assert.equal(raced.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(raced.find((result) => result.status === 'rejected').reason.code, 'duplicate_product_custom_field');
  await work(user, (client, identity) => saveProduct(client, identity, product([entry(field, 'same')])));
  await work(user, (client, identity) => saveProduct(client, identity, product([entry(field, 0)])));
  await work(user, (client, identity) => saveProduct(client, identity, product([entry(field, '0')])));
  await assert.rejects(work(user, (client, identity) => saveProduct(client, identity, product([entry(field, 0)]))), { code: 'duplicate_product_custom_field' });
});

test('Product field omission, typed references and history enforce tenant and actor boundaries', async () => {
  const user = await account(); const foreign = await account(); const viewer = await account({ organizationId: user.organizationId, permissions: ['masters.read'] });
  const command = definition('text'); const field = await work(user, (client, identity) => saveCustomField(client, identity, command));
  await assert.rejects(work(user, (client, identity) => saveProduct(client, identity, { id: randomUUID(), requestId: randomUUID(), revision: 0, name: 'Missing', key: randomUUID() })), { code: 'product_custom_fields_changed' });
  const saved = await work(user, (client, identity) => saveProduct(client, identity, product([entry(field, 'retained')])));
  await assert.rejects(work(foreign, (client, identity) => loadProduct(client, identity, saved.id), true), { code: 'product_not_found' });
  await assert.rejects(work(viewer, (client, identity) => saveProduct(client, identity, product([entry(field, 'no')]))), { code: 'forbidden' });
  await assert.rejects(work(user, (client) => client.query("UPDATE product_version_custom_field_values SET raw_text='changed' WHERE organization_id=$1 AND product_id=$2", [user.organizationId,saved.id])), { code: '42501' });
  await assert.rejects(owner.query("UPDATE product_version_custom_field_values SET raw_text='changed' WHERE organization_id=$1 AND product_id=$2", [user.organizationId,saved.id]), { code: '55000' });
  await work(user, (client, identity) => retireCustomField(client, identity, { id: field.id, revision: field.revision, requestId: randomUUID() }));
  const preserve = { id: saved.id, revision: 1, requestId: randomUUID(), name: saved.name, key: saved.key };
  const copied = await work(user, (client, identity) => saveProduct(client, identity, preserve));
  assert.equal(copied.customFieldsProvided, false); assert.equal(copied.customFields[0].value, 'retained');
  await work(user, (client, identity) => saveCustomField(client, identity, definition('email')));
  assert.equal((await work(user, (client, identity) => saveProduct(client, identity, preserve))).customFields[0].value, 'retained');
});

test('Product user choices include inactive members, escape literal searches and never cross tenants', async () => {
  const user = await account(); const inactive = await account({ organizationId: user.organizationId }); const foreign = await account();
  await owner.query("UPDATE users SET display_name='Synthetic %_ User' WHERE id=$1", [inactive.userId]);
  await owner.query('UPDATE memberships SET active=false WHERE organization_id=$1 AND user_id=$2', [user.organizationId,inactive.userId]);
  const selected = await work(user, (client, identity) => productCustomFieldUsers(client, identity, { search: '%_' }), true);
  assert.deepEqual(selected.rows, [], 'Raw separators removed from the displayed label do not match.');
  const displayed = await work(user, (client, identity) => productCustomFieldUsers(client, identity, { search: 'Synthetic % User' }), true);
  assert.deepEqual(displayed.rows, [{ id: inactive.userId, name: 'Synthetic %_ User' }], 'Search matches the label after source separator/whitespace normalization.');
  assert.equal((await work(foreign, (client, identity) => productCustomFieldUsers(client, identity, { search: '%_' }), true)).rows.length, 0);
  const field = await work(user, (client, identity) => saveCustomField(client, identity, definition('multi_user_select')));
  const saved = await work(user, (client, identity) => saveProduct(client, identity, product([entry(field,[inactive.userId])])));
  assert.equal(saved.customFields[0].items[0].userId,inactive.userId);
  await assert.rejects(work(user, (client, identity) => saveProduct(client, identity, product([entry(field,[foreign.userId])]))), { code: 'invalid_product_custom_field_user' });
});
