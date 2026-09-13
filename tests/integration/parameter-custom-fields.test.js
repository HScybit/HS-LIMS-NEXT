import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveTestParameter, loadTestParameter, retireTestParameter, listTestParameters } from '../../src/masters/test-parameters.js';
import { saveCustomField, retireCustomField } from '../../src/masters/custom-fields.js';
import { uploadCustomFieldAttachment } from '../../src/custom-fields/attachments.js';
import { generateParameterCustomFields } from '../../src/masters/parameter-custom-field-generation.js';

const owner = ownerPool();
after(async () => { await closePool(); await owner.end(); });
const work = (user, action, readOnly = false) => withSession(user.token, action, { csrfToken: user.csrfToken, readOnly });
async function account(options = {}) {
  const user = await createAccount(owner, { permissions: ['masters.manage'], ...options });
  return { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
}
const definition = (fieldType, extra = {}) => ({ id: randomUUID(), revision: 0, requestId: randomUUID(), label: `Synthetic ${fieldType}`,
  key: fieldType, fieldType, associatedWith: 'parameter', ...extra });
const parameter = (customFields, extra = {}) => ({ id: randomUUID(), requestId: randomUUID(), revision: 0, name: 'Synthetic captured parameter',
  key: randomUUID(), schemeAbbreviation: randomUUID(), customFields, ...extra });
const entry = (field, value) => ({ fieldId: field.id, fieldRevision: field.revision, value });

test('parameter values preserve primitive types, ordered arrays and exact history after definition edits and retirement', async () => {
  const user = await account();
  const fields = [];
  for (const [index, type] of ['text', 'number', 'checkbox', 'date_time'].entries()) {
    fields.push(await work(user, (client, identity) => saveCustomField(client, identity,
      definition(type, { displayOrder: index, allowsMultiple: type === 'number' }))));
  }
  const raw = ['stored title', [0, false, 'bad', '0x10'], false, '2026-03-08T02:30'];
  const command = parameter(fields.map((field, index) => entry(field, raw[index])), { customFieldTimeZone: 'America/New_York' });
  const saved = await work(user, (client, identity) => saveTestParameter(client, identity, command));
  assert.deepEqual(saved.customFields.map((field) => field.value), raw);
  assert.deepEqual(saved.customFields[1].items.map((item) => item.interpretationState), ['valid', 'valid', 'invalid', 'valid']);
  assert.equal(saved.customFields[2].displayValue, false);
  assert.equal(saved.customFields[3].displayValue, '08/03/2026 03:30:00');
  for (const field of fields) await work(user, (client, identity) => retireCustomField(client, identity,
    { id: field.id, revision: field.revision, requestId: randomUUID() }));
  const { customFields: _fields, customFieldTimeZone: _zone, ...omitted } = command;
  const updated = await work(user, (client, identity) => saveTestParameter(client, identity,
    { ...omitted, revision: 1, requestId: randomUUID(), name: 'Changed name' }));
  assert.equal(updated.customFieldsProvided, false);
  assert.deepEqual(updated.customFields, saved.customFields);
  await work(user, (client, identity) => retireTestParameter(client, identity, { id: saved.id, revision: 2, requestId: randomUUID() }));
  assert.deepEqual((await work(user, (client, identity) => loadTestParameter(client, identity, saved.id, { atRevision: 3 }), true)).customFields, saved.customFields);
  assert.deepEqual((await work(user, (client, identity) => saveTestParameter(client, identity, command))).customFields, saved.customFields);
  await assert.rejects(work(user, (client, identity) => saveTestParameter(client, identity,
    { ...command, customFields: command.customFields.map((item, index) => index ? item : { ...item, value: 'different' }) })), { code: 'save_request_reused' });
});

test('parameter field associations, requiredness, stale definitions and tenant access are enforced atomically', async () => {
  const user = await account(); const foreign = await account();
  const field = await work(user, (client, identity) => saveCustomField(client, identity, definition('text', { isRequired: true })));
  const productField = await work(user, (client, identity) => saveCustomField(client, identity,
    definition('text', { key: 'product_only', associatedWith: 'product' })));
  await assert.rejects(work(user, (client, identity) => saveTestParameter(client, identity, parameter([entry(productField, 'wrong')]))), { code: 'parameter_custom_fields_changed' });
  await assert.rejects(work(user, (client, identity) => saveTestParameter(client, identity, parameter([entry(field, '')]))), { code: 'invalid_custom_field_value' });
  const saved = await work(user, (client, identity) => saveTestParameter(client, identity, parameter([entry(field, 'retained')])));
  await assert.rejects(work(foreign, (client, identity) => loadTestParameter(client, identity, saved.id), true), { code: 'parameter_not_found' });
  await assert.rejects(work(user, (client) => client.query("UPDATE parameter_version_custom_field_values SET raw_text='changed' WHERE organization_id=$1 AND parameter_id=$2", [user.organizationId, saved.id])), { code: '42501' });
  await assert.rejects(owner.query("UPDATE parameter_version_custom_field_values SET raw_text='changed' WHERE organization_id=$1 AND parameter_id=$2", [user.organizationId, saved.id]), { code: '55000' });
  await work(user, (client, identity) => saveCustomField(client, identity,
    definition('text', { id: field.id, revision: field.revision, isRequired: true, label: 'Updated field' })));
  await assert.rejects(work(user, (client, identity) => saveTestParameter(client, identity,
    parameter([entry(field, 'changed')], { id: saved.id, revision: 1 }))), { code: 'parameter_custom_fields_changed' });
  assert.equal((await work(user, (client, identity) => loadTestParameter(client, identity, saved.id), true)).revision, 1);
});

test('parameter selections retain exact retired option versions, scoped users and immutable attachments in bounded reads', async () => {
  const user = await account(); const foreign = await account();
  const choice = { id: randomUUID(), key: 'old', label: 'Original option' };
  const commands = [definition('select', { options: [choice] }), definition('multi_user_select'), definition('attachment'),
    definition('longtext'), definition('email', { allowsMultiple: true }), definition('lookup'), definition('date')];
  const fields = [];
  for (const command of commands) fields.push(await work(user, (client, identity) => saveCustomField(client, identity, command)));
  const file = await work(user, (client, identity) => uploadCustomFieldAttachment(client, identity,
    { requestId: randomUUID(), fieldId: fields[2].id, fieldRevision: 1, originalName: 'Synthetic parameter.txt', mediaType: 'text/plain', content: Buffer.from('Synthetic') }));
  const raw = ['old', [user.userId.toUpperCase()], file.id, 0, ['invalid email', 0, false], '', '2026-02-31'];
  const input = parameter(fields.map((field, index) => entry(field, raw[index])), { customFieldTimeZone: 'Asia/Kolkata' });
  const saved = await work(user, (client, identity) => saveTestParameter(client, identity, input));
  assert.deepEqual(saved.customFields.map((field) => field.value), raw);
  assert.equal(saved.customFields[0].items[0].optionLabel, 'Original option');
  assert.equal(saved.customFields[1].items[0].userName, 'Synthetic Analyst');
  assert.equal(saved.customFields[2].items[0].attachment.originalName, 'Synthetic parameter.txt');
  assert.equal(saved.customFields[6].items[0].interpretationState, 'invalid');
  const calls = [];
  await work(user, (client, identity) => loadTestParameter({ query: (sql, args) => { calls.push(sql); return client.query(sql, args); } }, identity, saved.id), true);
  assert.equal(calls.filter((sql) => /FROM parameter_version_custom_field/.test(sql)).length, 2);
  const updated = await work(user, (client, identity) => saveCustomField(client, identity,
    { ...commands[0], revision: 1, requestId: randomUUID(), options: [] }));
  const next = { ...input, revision: 1, requestId: randomUUID(), customFields: input.customFields.map((item, index) => index ? item : entry(updated, 'old')) };
  const retained = await work(user, (client, identity) => saveTestParameter(client, identity, next));
  assert.equal(retained.customFields[0].fieldRevision, 2);
  assert.equal(retained.customFields[0].items[0].optionRevision, 1);
  assert.equal(retained.customFields[0].displayValue, 'old');
  await assert.rejects(work(user, (client, identity) => saveTestParameter(client, identity,
    { ...next, revision: 2, requestId: randomUUID(), customFields: next.customFields.map((item, index) => index === 1 ? { ...item, value: [foreign.userId] } : item) })),
  { code: 'invalid_parameter_custom_field_user' });
  await assert.rejects(work(user, (client, identity) => saveTestParameter(client, identity,
    { ...next, id: randomUUID(), revision: 0, requestId: randomUUID() })), { code: 'invalid_parameter_custom_field_option' });
});

test('parameter generation uses its own history, sequential fields, edit exclusion and concurrent save uniqueness', async () => {
  const user = await account();
  const fields = [];
  for (const command of [definition('text', { key: 'serial', scheme: '{{entity.scheme_abbr}}/{{scheme_counter}}', splitter: '/', generatedAt: 'on_init', validateUniqueness: true, displayOrder: 0 }),
    definition('text', { key: 'copied', scheme: '{{serial}}/{{product_name}}/{{total_counter}}', generatedAt: 'on_submit', displayOrder: 1 })]) {
    fields.push(await work(user, (client, identity) => saveCustomField(client, identity, command)));
  }
  const input = { parameter: { name: 'Synthetic generated parameter', key: 'generated', schemeAbbreviation: 'Ni', order: 0 },
    customFields: fields.map((field) => entry(field, '')) };
  const generate = (value = input) => work(user, (client, identity) => generateParameterCustomFields(client, identity, value), true);
  const previews = await Promise.all([generate(), generate()]);
  assert.deepEqual(previews[0].values.map((field) => field.value), ['Ni/1', 'Ni/1//1']);
  assert.deepEqual(previews[0], previews[1]);
  const writes = await Promise.allSettled(previews.map((preview) => {
    const values = fields.map((field, index) => entry(field, preview.values[index].value));
    return work(user, (client, identity) => saveTestParameter(client, identity, parameter(values)));
  }));
  assert.equal(writes.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(writes.find((result) => result.status === 'rejected').reason.code, 'duplicate_parameter_custom_field');
  const saved = writes.find((result) => result.status === 'fulfilled').value;
  assert.deepEqual((await generate()).values.map((field) => field.value), ['Ni/2', 'Ni/2//2']);
  assert.deepEqual((await generate({ ...input, parameterId: saved.id, fieldId: fields[0].id })).values, [{ fieldId: fields[0].id, value: 'Ni/1' }]);
  const viewer = await account({ organizationId: user.organizationId, permissions: ['masters.read'] });
  await assert.rejects(work(viewer, (client, identity) => generateParameterCustomFields(client, identity, input), true), { code: 'forbidden' });
  await assert.rejects(work(viewer, (client) => client.query('SELECT * FROM masters_parameter_scheme_context(true,true)'), true), { code: '42501' });
});

test('parameter listing batches visible values and preserves typed filters, ordering, hidden fields and captured labels', async () => {
  const user = await account(); const fields = [];
  const commands = [definition('number', { showInList: true, showInFilter: true }),
    definition('text', { showInFilter: true }), definition('checkbox', { showInList: true, showInFilter: true }),
    definition('date', { showInList: true }), definition('select', { showInList: true, showInFilter: true,
      options: [{ id: randomUUID(), key: 'A', label: 'Original Alpha' }] })];
  for (const command of commands) fields.push(await work(user, (client, identity) => saveCustomField(client, identity, command)));
  const saved = [];
  for (const value of [4, 0, 2]) saved.push(await work(user, (client, identity) => saveTestParameter(client, identity,
    parameter([value, `hidden %_ ${value}`, false, '2026-12-31', 'A'].map((raw, index) => entry(fields[index], raw)), { customFieldTimeZone: 'Asia/Kolkata' }))));
  const sort = { key: `pf:${fields[0].id}`, dir: 'asc' };
  const calls = [];
  const listed = await work(user, (client, identity) => listTestParameters({ query: (sql, args) => { calls.push(sql); return client.query(sql, args); } }, identity, { sort }), true);
  assert.deepEqual(listed.rows.map((row) => row.customFields[fields[0].id].displayValue), [0, 2, 4]);
  assert.equal(calls.length, 6, 'two definition/option batches, count, page and two value/date batches');
  assert.equal(listed.rows[0].customFields[fields[2].id].displayValue, false);
  assert.equal(listed.rows[0].customFields[fields[3].id].value, '2026-12-31');
  assert.equal(Object.hasOwn(listed.rows[0].customFields, fields[1].id), false);
  const hidden = await work(user, (client, identity) => listTestParameters(client, identity, { search: 'hidden %_ 0' }), true);
  assert.deepEqual(hidden.rows.map((row) => row._id), [saved[1].id]);
  const filtered = await work(user, (client, identity) => listTestParameters(client, identity,
    { filters: { [`pf:${fields[0].id}`]: { type: 'text', value: '0' } } }), true);
  assert.deepEqual(filtered.rows.map((row) => row._id), [saved[1].id]);
  await work(user, (client, identity) => saveCustomField(client, identity,
    { ...commands[4], revision: 1, requestId: randomUUID(), options: [{ ...commands[4].options[0], label: 'Renamed Alpha' }] }));
  const oldLabel = await work(user, (client, identity) => listTestParameters(client, identity,
    { filters: { [`pf:${fields[4].id}`]: { type: 'select', value: 'Original Alpha' } } }), true);
  assert.equal(oldLabel.totalCount, 3);
  assert.equal(oldLabel.rows[0].customFields[fields[4].id].displayValue, 'Original Alpha');
  await assert.rejects(work(user, (client, identity) => listTestParameters(client, identity,
    { sort: { key: `pf:${fields[1].id}`, dir: 'asc' } }), true), { code: 'invalid_sort' });
});
